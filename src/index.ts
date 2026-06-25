import { $, Context, Logger, Schema, Time } from 'koishi'
import { DataService } from '@koishijs/console'
import { resolve } from 'path'

declare module 'koishi' {
  interface Tables {
    'analytics.message': AnalyticsMsg
    'analytics.command': AnalyticsCmd
    'analytics.trigger': AnalyticsTrg
  }
}

declare module '@koishijs/console' {
  namespace Console {
    interface Services {
      analytics: Analytics
    }
  }
}

interface AnalyticsMsg { date: number; hour: number; type: string; selfId: string; platform: string; count: number }
interface AnalyticsCmd { date: number; hour: number; name: string; selfId: string; platform: string; userId: string; channelId: string; count: number }
interface AnalyticsTrg { date: number; keyword: string; count: number }

export interface Config {
  statsInternal: number
  recentDayCount: number
  trackKeywords: string[]
}

export const Config: Schema<Config> = Schema.object({
  statsInternal: Schema.number()
    .description('统计数据推送的时间间隔（毫秒）').min(10000).max(3600000).step(1000).default(600000),
  recentDayCount: Schema.number()
    .description('统计最近几天的数据').min(1).max(90).step(1).default(7),
  trackKeywords: Schema.array(Schema.string()).role('table')
    .description('要统计的关键词（如 word 插件的触发词，analytics 自己监听命中）')
    .default([
      '门派升级', '门派费用', '探索日志', '探索地图', '礼包码', '主播礼包码',
      '神功牌属性', '秘功牌属性', '装备', '仙幻装备', '装备升级', '装备强化',
      '桃子礼包码', '桃子礼包', '八卦', '八卦牌', '血猪八卦', '飞凤八卦', '鬼灵墓八卦', '仙幻八卦',
      '菜单', '帮助', '世界boss', '世界BOSS', '活动链接', '怀旧活动', '怀旧服活动',
      '拳师词条', '拳师技能', '火剑词条', '火剑技能',
      '气功词条', '气功技能', '攻时词条', '攻时技能',
      '推龙词条', '推龙技能',
      '冰气功词条', '冰气功技能', '冰气词条', '冰气技能', '冰河词条', '冰河技能',
      '力士词条', '力士技能', '执行词条', '执行技能', '执行力士词条', '执行力士技能',
      '毁灭词条', '毁灭技能', '毁灭力士词条', '毁灭力士技能',
      '刺客词条', '刺客技能',
      '召唤词条', '召唤技能', '大黄蜂词条', '大黄蜂技能',
      '攻血词条', '攻血技能', '召唤攻血词条', '召唤攻血技能',
      '向日葵词条', '向日葵技能', '召唤向日葵词条', '召唤向日葵技能',
      '灵剑士词条', '灵剑士技能', '灵剑词条', '灵剑技能', '雷灵词条', '雷灵技能', '雷电词条', '雷电技能', '雷力士词条',
      '风灵词条', '风灵技能', '灵剑风系词条', '灵剑风系技能', '风云词条', '风云技能',
      '咒术师词条', '咒术师技能', '咒术词条', '咒术技能', '诅咒词条', '诅咒技能', '黑炎龙词条', '黑炎龙技能',
      '冰咒词条', '冰咒技能', '冰系咒术词条', '冰系咒术技能', '咒术冰系词条', '咒术冰系技能', '咒术师冰系词条', '咒术师冰系技能', '冰龙词条', '冰龙技能',
      '魔枪词条', '魔枪技能', '魔枪士词条', '魔枪士技能',
      '小助手下载',
      '剑士词条', '剑士技能', '雷剑词条', '雷剑技能', '刺剑词条', '刺剑技能',
    ]),
})

export interface Payload {
  messageByBot: { bot: string; send: number; receive: number }[]
  commandRank: { name: string; count: number }[]
  triggerRank: { keyword: string; count: number }[]
  totalMessages: number
  totalCommands: number
  totalTriggers: number
}

const logger = new Logger('ll-analytics')

class Analytics extends DataService<Payload> {
  static inject = ['console', 'database']

  private _msgs: AnalyticsMsg[] = []
  private _cmds: AnalyticsCmd[] = []
  private _trgs: AnalyticsTrg[] = []
  private _lastFlush = new Date()
  private _cache: Payload | null = null
  private _timer: NodeJS.Timeout | null = null

  constructor(ctx: Context, private cfg: Config) {
    super(ctx, 'analytics') // 注册为 analytics，替代官方

    // 消息和指令表：与官方完全兼容
    ctx.model.extend('analytics.message', {
      date: 'integer', hour: 'integer', type: 'string(63)',
      selfId: 'string(63)', platform: 'string(63)', count: 'integer',
    }, { primary: ['date', 'hour', 'type', 'selfId', 'platform'] })

    ctx.model.extend('analytics.command', {
      date: 'integer', hour: 'integer', name: 'string(63)',
      selfId: 'string(63)', platform: 'string(63)',
      userId: 'string(63)', channelId: 'string(63)', count: 'integer',
    }, { primary: ['date', 'hour', 'name', 'selfId', 'platform', 'userId', 'channelId'] })

    // 关键词触发：新表
    ctx.model.extend('analytics.trigger', {
      date: 'integer', keyword: 'string(127)', count: 'integer',
    }, { primary: ['date', 'keyword'] })

    // 消息统计
    ctx.on('message', (s) => { this._pushMsg(s, 'receive'); this._flush() })
    ctx.on('send', (s) => { this._pushMsg(s, 'send'); this._flush() })

    // 指令统计
    ctx.any().before('command/execute', ({ command, session }) => {
      this._cmds.push({
        date: Time.getDateNumber(),
        hour: new Date().getHours(),
        name: command.name,
        selfId: session.selfId || (session as any).bot?.selfId || 'unknown',
        platform: session.platform || 'unknown',
        userId: String((session as any).userId || (session as any).event?.user?.id || ''),
        channelId: session.channelId || '',
        count: 1,
      })
    })

    // 关键词监听
    if (cfg.trackKeywords?.length) {
      ctx.middleware((session, next) => {
        const text = session.content || ''
        if (typeof text === 'string' && text.trim()) {
          for (const kw of cfg.trackKeywords) {
            if (text.includes(kw)) {
              this._trgs.push({ date: Time.getDateNumber(), keyword: kw, count: 1 })
              this._flush()
              break
            }
          }
        }
        return next()
      }, true)
    }

    // WebUI 页面
    ctx.console.addEntry({
      dev: resolve(__dirname, '../client/index.ts'),
      prod: resolve(__dirname, '../dist/index.js'),
    })

    this._timer = setInterval(() => { this._cache = null }, cfg.statsInternal)

    ctx.on('dispose', () => {
      this._flush(true)
      if (this._timer) clearInterval(this._timer)
    })

    logger.info(`已启动：统计${cfg.recentDayCount}天，刷新${cfg.statsInternal}ms，关键词${cfg.trackKeywords?.length || 0}个`)
  }

  private _idx(s: any) {
    return {
      date: Time.getDateNumber(),
      hour: new Date().getHours(),
      selfId: s.selfId || (s as any).bot?.selfId || 'unknown',
      platform: s.platform || 'unknown',
    }
  }

  private _pushMsg(s: any, type: string) {
    this._msgs.push({ ...this._idx(s), type, count: 1 })
  }

  private async _flush(force = false) {
    const now = Date.now()
    if (!force && now - +this._lastFlush < 5000) return
    this._lastFlush = new Date()
    try {
      if (this._msgs.length) {
        const merged = this._merge(this._msgs, ['date', 'hour', 'type', 'selfId', 'platform']) as AnalyticsMsg[]
        this._msgs = []
        for (const m of merged) await this.ctx.database.upsert('analytics.message', [m], ['date', 'hour', 'type', 'selfId', 'platform'])
      }
      if (this._cmds.length) {
        const merged = this._merge(this._cmds, ['date', 'hour', 'name', 'selfId', 'platform', 'userId', 'channelId']) as AnalyticsCmd[]
        this._cmds = []
        for (const c of merged) await this.ctx.database.upsert('analytics.command', [c], ['date', 'hour', 'name', 'selfId', 'platform', 'userId', 'channelId'])
      }
      if (this._trgs.length) {
        const merged = this._merge(this._trgs, ['date', 'keyword']) as AnalyticsTrg[]
        this._trgs = []
        for (const t of merged) await this.ctx.database.upsert('analytics.trigger', [t], ['date', 'keyword'])
      }
    } catch (e) { logger.warn('flush:', e) }
  }

  private _merge<T extends { count: number }>(rows: T[], keys: string[]): T[] {
    const map = new Map<string, T>()
    for (const r of rows) {
      const k = keys.map(k2 => (r as any)[k2]).join('|')
      const e = map.get(k)
      if (e) { e.count += r.count } else { map.set(k, { ...r }) }
    }
    return [...map.values()]
  }

  async get(): Promise<Payload> {
    if (this._cache) return this._cache
    const db = this.ctx.database
    const days = this.cfg.recentDayCount || 7
    const since = Time.getDateNumber() - days

    try {
      // 消息
      const msgRows = await db.select('analytics.message')
        .where(row => $.gt(row.date, since)).groupBy(['selfId', 'type']).execute() as AnalyticsMsg[]
      const botMap = new Map<string, { send: number; receive: number }>()
      for (const r of msgRows) {
        const l = r.selfId || 'unknown'
        if (!botMap.has(l)) botMap.set(l, { send: 0, receive: 0 })
        const b = botMap.get(l)!
        if (r.type === 'send') b.send += r.count; else b.receive += r.count
      }
      const messageByBot = [...botMap.entries()].map(([bot, v]) => ({ bot, ...v }))
        .sort((a, b) => (b.send + b.receive) - (a.send + a.receive))

      // 指令
      const cmdRows = await db.select('analytics.command')
        .where(row => $.gt(row.date, since)).groupBy(['name']).execute() as AnalyticsCmd[]
      const cmdMap = new Map<string, number>()
      for (const r of cmdRows) cmdMap.set(r.name, (cmdMap.get(r.name) || 0) + r.count)
      const commandRank = [...cmdMap.entries()].map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count).slice(0, 30)

      // 关键词
      const trgRows = await db.select('analytics.trigger')
        .where(row => $.gt(row.date, since)).groupBy(['keyword']).execute() as AnalyticsTrg[]
      const trgMap = new Map<string, number>()
      for (const r of trgRows) trgMap.set(r.keyword, (trgMap.get(r.keyword) || 0) + r.count)
      const triggerRank = [...trgMap.entries()].map(([keyword, count]) => ({ keyword, count }))
        .sort((a, b) => b.count - a.count).slice(0, 30)

      this._cache = {
        messageByBot, commandRank, triggerRank,
        totalMessages: messageByBot.reduce((s, b) => s + b.send + b.receive, 0),
        totalCommands: commandRank.reduce((s, c) => s + c.count, 0),
        totalTriggers: triggerRank.reduce((s, t) => s + t.count, 0),
      }
      return this._cache
    } catch (e) {
      logger.warn('get:', e)
      return { messageByBot: [], commandRank: [], triggerRank: [], totalMessages: 0, totalCommands: 0, totalTriggers: 0 }
    }
  }
}

export default Analytics
