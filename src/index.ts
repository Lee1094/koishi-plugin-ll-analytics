import { $, Context, Logger, Schema, Time } from 'koishi'
import { DataService } from '@koishijs/console'
import { resolve } from 'path'

declare module 'koishi' {
  interface Tables {
    ll_analytics_trigger: LlTrigger
  }
}

declare module '@koishijs/console' {
  namespace Console {
    interface Services {
      'll-analytics': LlAnalytics
    }
  }
}

interface LlTrigger { date: number; plugin: string; keyword: string; count: number }

export interface Config {
  recentDays: number
  refreshInterval: number
  trackKeywords: string[]
}

export const Config: Schema<Config> = Schema.object({
  recentDays: Schema.number()
    .description('统计最近几天的数据').min(1).max(90).step(1).default(7),
  refreshInterval: Schema.number()
    .description('数据缓存刷新间隔（毫秒）').min(30000).max(3600000).step(1000).default(600000),
  trackKeywords: Schema.array(Schema.string()).role('table')
    .description('要统计的关键词（analytics 自己监听命中，无需改其他插件）')
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

export interface AnalyticsPayload {
  messageByBot: { bot: string; send: number; receive: number }[]
  commandRank: { name: string; count: number }[]
  triggerRank: { keyword: string; plugin: string; count: number }[]
  totalMessages: number
  totalCommands: number
  totalTriggers: number
}

const logger = new Logger('ll-analytics')

class LlAnalytics extends DataService<AnalyticsPayload> {
  static inject = ['console', 'database']

  private _triggers: LlTrigger[] = []
  private _lastFlush = new Date()
  private _cache: AnalyticsPayload | null = null
  private _timer: NodeJS.Timeout | null = null

  constructor(ctx: Context, private cfg: Config) {
    super(ctx, 'll-analytics')

    // 只新建 trigger 表——消息/指令直接用官方 analytics 表
    ctx.model.extend('ll_analytics_trigger', {
      date: 'integer', plugin: 'string(63)', keyword: 'string(127)', count: 'integer',
    }, { primary: ['date', 'plugin', 'keyword'] })

    // 注册 WebUI 页面
    ctx.console.addEntry({
      dev: resolve(__dirname, '../client/index.ts'),
      prod: resolve(__dirname, '../dist/index.js'),
    })

    // 关键词监听：无需改其他插件，analytics 自己统计
    if (cfg.trackKeywords?.length) {
      ctx.middleware((session, next) => {
        const text = session.content || ''
        if (typeof text === 'string' && text.trim()) {
          for (const kw of cfg.trackKeywords) {
            if (text.includes(kw)) {
              this._triggers.push({ date: Time.getDateNumber(), plugin: 'keyword', keyword: kw, count: 1 })
              this._flush()
              break
            }
          }
        }
        return next()
      }, true) // 最后执行，不影响其他插件
    }

    // 每 N 毫秒清缓存
    this._timer = setInterval(() => { this._cache = null }, cfg.refreshInterval)

    ctx.on('dispose', () => {
      this._flush(true)
      if (this._timer) clearInterval(this._timer)
    })

    logger.info(`已启动：统计${cfg.recentDays}天，刷新间隔${cfg.refreshInterval}ms`)
  }

  /** 供其他插件调用：记录中间件/关键词触发 */
  recordTrigger(plugin: string, keyword: string) {
    this._triggers.push({ date: Time.getDateNumber(), plugin, keyword, count: 1 })
    this._flush()
  }

  private async _flush(force = false) {
    const now = Date.now()
    if (!force && now - +this._lastFlush < 5000) return
    this._lastFlush = new Date()
    try {
      if (this._triggers.length) {
        const map = new Map<string, LlTrigger>()
        for (const t of this._triggers) {
          const k = `${t.date}|${t.plugin}|${t.keyword}`
          const e = map.get(k)
          if (e) { e.count += t.count } else { map.set(k, { ...t }) }
        }
        this._triggers = []
        for (const t of map.values())
          await this.ctx.database.upsert('ll_analytics_trigger', [t as any], ['date', 'plugin', 'keyword'])
      }
    } catch (e) {
      logger.warn('flush error:', e)
    }
  }

  async get(): Promise<AnalyticsPayload> {
    if (this._cache) return this._cache
    const db = this.ctx.database
    const days = this.cfg.recentDays || 7
    const since = Time.getDateNumber() - days

    try {
      // ── 读官方 analytics.message 表（兼容） ──
      let messageByBot: { bot: string; send: number; receive: number }[] = []
      let totalMessages = 0
      try {
        const msgRows = await db.select('analytics.message' as any)
          .where((row: any) => $.gt(row.date, since))
          .groupBy(['selfId', 'type'])
          .execute() as any[]
        const botMap = new Map<string, { send: number; receive: number }>()
        for (const r of msgRows) {
          const label = r.selfId || 'unknown'
          if (!botMap.has(label)) botMap.set(label, { send: 0, receive: 0 })
          const b = botMap.get(label)!
          if (r.type === 'send') b.send += r.count
          else b.receive += r.count
        }
        messageByBot = [...botMap.entries()]
          .map(([bot, v]) => ({ bot, ...v }))
          .sort((a, b) => (b.send + b.receive) - (a.send + a.receive))
        totalMessages = messageByBot.reduce((s, b) => s + b.send + b.receive, 0)
      } catch (e) {
        logger.debug('读取官方消息表失败（可能未安装官方 analytics 插件）:', e)
        // fallback：你已有的消息数据
        try {
          const rows = await db.select('ll_analytics_msg' as any)
            .where((row: any) => $.gt(row.date, since))
            .groupBy(['selfId', 'type'])
            .execute() as any[]
          const botMap = new Map<string, { send: number; receive: number }>()
          for (const r of rows) {
            const label = r.selfId || 'unknown'
            if (!botMap.has(label)) botMap.set(label, { send: 0, receive: 0 })
            const b = botMap.get(label)!
            if (r.type === 'send') b.send += r.count
            else b.receive += r.count
          }
          messageByBot = [...botMap.entries()]
            .map(([bot, v]) => ({ bot, ...v }))
            .sort((a, b) => (b.send + b.receive) - (a.send + a.receive))
          totalMessages = messageByBot.reduce((s, b) => s + b.send + b.receive, 0)
        } catch { /* */ }
      }

      // ── 读官方 analytics.command 表（兼容） ──
      let commandRank: { name: string; count: number }[] = []
      let totalCommands = 0
      try {
        const cmdRows = await db.select('analytics.command' as any)
          .where((row: any) => $.gt(row.date, since))
          .groupBy(['name'])
          .execute() as any[]
        const cmdMap = new Map<string, number>()
        for (const r of cmdRows) cmdMap.set(r.name, (cmdMap.get(r.name) || 0) + r.count)
        commandRank = [...cmdMap.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count).slice(0, 30)
        totalCommands = commandRank.reduce((s, c) => s + c.count, 0)
      } catch (e) {
        logger.debug('读取官方指令表失败:', e)
        try {
          const rows = await db.select('ll_analytics_cmd' as any)
            .where((row: any) => $.gt(row.date, since))
            .groupBy(['name'])
            .execute() as any[]
          const cmdMap = new Map<string, number>()
          for (const r of rows) cmdMap.set(r.name, (cmdMap.get(r.name) || 0) + r.count)
          commandRank = [...cmdMap.entries()]
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count).slice(0, 30)
          totalCommands = commandRank.reduce((s, c) => s + c.count, 0)
        } catch { /* */ }
      }

      // ── 关键词触发：读自己的表 ──
      let triggerRank: { keyword: string; plugin: string; count: number }[] = []
      let totalTriggers = 0
      try {
        const trRows = await db.select('ll_analytics_trigger')
          .where((row: any) => $.gt(row.date, since))
          .groupBy(['plugin', 'keyword'])
          .execute() as LlTrigger[]
        const trMap = new Map<string, { plugin: string; keyword: string; count: number }>()
        for (const r of trRows) {
          const k = `${r.plugin}|${r.keyword}`
          if (!trMap.has(k)) trMap.set(k, { plugin: r.plugin, keyword: r.keyword, count: 0 })
          trMap.get(k)!.count += r.count
        }
        triggerRank = [...trMap.values()].sort((a, b) => b.count - a.count).slice(0, 30)
        totalTriggers = triggerRank.reduce((s, t) => s + t.count, 0)
      } catch { /* */ }

      this._cache = { messageByBot, commandRank, triggerRank, totalMessages, totalCommands, totalTriggers }
      return this._cache
    } catch (e) {
      logger.warn('get error:', e)
      return { messageByBot: [], commandRank: [], triggerRank: [], totalMessages: 0, totalCommands: 0, totalTriggers: 0 }
    }
  }
}

export default LlAnalytics
