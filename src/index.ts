import { $, Context, Dict, Logger, Schema, Time, Universal } from 'koishi'
import { DataService } from '@koishijs/console'
import { resolve } from 'path'

declare module 'koishi' {
  interface Tables {
    ll_analytics_msg: LlMsg
    ll_analytics_cmd: LlCmd
    ll_analytics_trg: LlTrg
  }
}

declare module '@koishijs/console' {
  namespace Console {
    interface Services {
      'll-analytics': LlAnalytics
    }
  }
}

interface LlMsg { date: number; hour: number; type: string; selfId: string; platform: string; count: number }
interface LlCmd { date: number; name: string; selfId: string; platform: string; count: number }
interface LlTrg { date: number; plugin: string; keyword: string; count: number }

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

  private _msgs: LlMsg[] = []
  private _cmds: LlCmd[] = []
  private _trgs: LlTrg[] = []
  private _lastFlush = new Date()
  private _cache: AnalyticsPayload | null = null

  constructor(ctx: Context, cfg: LlAnalytics.Config = {}) {
    super(ctx, 'll-analytics')

    if (ctx.database) {
      ctx.model.extend('ll_analytics_msg', {
        date: 'integer', hour: 'integer', type: 'string(63)',
        selfId: 'string(63)', platform: 'string(63)', count: 'integer',
      }, { primary: ['date', 'hour', 'type', 'selfId', 'platform'] })

      ctx.model.extend('ll_analytics_cmd', {
        date: 'integer', name: 'string(63)',
        selfId: 'string(63)', platform: 'string(63)', count: 'integer',
      }, { primary: ['date', 'name', 'selfId', 'platform'] })

      ctx.model.extend('ll_analytics_trg', {
        date: 'integer', plugin: 'string(63)', keyword: 'string(127)', count: 'integer',
      }, { primary: ['date', 'plugin', 'keyword'] })
    }

    ctx.on('message', (s) => { this._pushMsg(s, 'receive'); this._flush() })
    ctx.on('send', (s) => { this._pushMsg(s, 'send'); this._flush() })
    ctx.any().before('command/execute', ({ command, session }) => {
      this._pushCmd(command.name, session)
    })
    ctx.on('dispose', () => this._flush(true))

    // 注册 WebUI 页面
    ctx.console.addEntry({
      dev: resolve(__dirname, '../client/index.ts'),
      prod: resolve(__dirname, '../dist/index.js'),
    })

    setInterval(() => { this._cache = null }, 10 * 60 * 1000)

    logger.info('已启动')
  }

  private _idx(s: any) {
    const selfId = s.selfId || s.bot?.selfId || 'unknown'
    const platform = s.platform || 'unknown'
    return { date: Time.getDateNumber(), hour: new Date().getHours(), selfId, platform }
  }

  private _pushMsg(s: any, type: string) {
    this._msgs.push({ ...this._idx(s), type, count: 1 })
  }

  private _pushCmd(name: string, s: any) {
    this._cmds.push({ ...this._idx(s), name, count: 1 })
  }

  /** 供其他插件调用：记录中间件/关键词触发 */
  recordTrigger(plugin: string, keyword: string) {
    this._trgs.push({ date: Time.getDateNumber(), plugin, keyword, count: 1 })
    this._flush()
  }

  private async _flush(force = false) {
    if (!this.ctx.database) return
    const now = Date.now()
    if (!force && now - +this._lastFlush < 5000) return
    this._lastFlush = new Date()

    try {
      if (this._msgs.length) {
        const merged = this._merge(this._msgs, ['date', 'hour', 'type', 'selfId', 'platform'])
        this._msgs = []
        for (const m of merged)
          await this.ctx.database.upsert('ll_analytics_msg', [m as any], ['date', 'hour', 'type', 'selfId', 'platform'])
      }
      if (this._cmds.length) {
        const merged = this._merge(this._cmds, ['date', 'name', 'selfId', 'platform'])
        this._cmds = []
        for (const c of merged)
          await this.ctx.database.upsert('ll_analytics_cmd', [c as any], ['date', 'name', 'selfId', 'platform'])
      }
      if (this._trgs.length) {
        const merged = this._merge(this._trgs, ['date', 'plugin', 'keyword'])
        this._trgs = []
        for (const t of merged)
          await this.ctx.database.upsert('ll_analytics_trg', [t as any], ['date', 'plugin', 'keyword'])
      }
    } catch (e) {
      logger.warn('flush error:', e)
    }
  }

  private _merge<T extends { count: number }>(rows: T[], keys: string[]): T[] {
    const map = new Map<string, T>()
    for (const r of rows) {
      const k = keys.map(k2 => (r as any)[k2]).join('|')
      const exist = map.get(k)
      if (exist) { exist.count += r.count } else { map.set(k, { ...r }) }
    }
    return [...map.values()]
  }

  async get(): Promise<AnalyticsPayload> {
    if (this._cache) return this._cache
    const db = this.ctx.database
    if (!db) return { messageByBot: [], commandRank: [], triggerRank: [], totalMessages: 0, totalCommands: 0, totalTriggers: 0 }

    try {
      const weekAgo = Time.getDateNumber() - 7

      // 机器人消息量
      const msgRows = await db.select('ll_analytics_msg')
        .where(row => $.gt(row.date, weekAgo))
        .groupBy(['selfId', 'type'])
        .execute() as LlMsg[]

      const botMap = new Map<string, { send: number; receive: number }>()
      for (const r of msgRows) {
        const label = r.selfId
        if (!botMap.has(label)) botMap.set(label, { send: 0, receive: 0 })
        const b = botMap.get(label)!
        if (r.type === 'send') b.send += r.count
        else b.receive += r.count
      }
      const messageByBot = [...botMap.entries()]
        .map(([bot, v]) => ({ bot, ...v }))
        .sort((a, b) => (b.send + b.receive) - (a.send + a.receive))

      // 指令排行
      const cmdRows = await db.select('ll_analytics_cmd')
        .where(row => $.gt(row.date, weekAgo))
        .groupBy(['name'])
        .execute() as LlCmd[]
      const cmdMap = new Map<string, number>()
      for (const r of cmdRows) cmdMap.set(r.name, (cmdMap.get(r.name) || 0) + r.count)
      const commandRank = [...cmdMap.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count).slice(0, 30)

      // 关键词触发排行
      const trRows = await db.select('ll_analytics_trg')
        .where(row => $.gt(row.date, weekAgo))
        .groupBy(['plugin', 'keyword'])
        .execute() as LlTrg[]
      const trMap = new Map<string, { plugin: string; keyword: string; count: number }>()
      for (const r of trRows) {
        const k = `${r.plugin}|${r.keyword}`
        if (!trMap.has(k)) trMap.set(k, { plugin: r.plugin, keyword: r.keyword, count: 0 })
        trMap.get(k)!.count += r.count
      }
      const triggerRank = [...trMap.values()].sort((a, b) => b.count - a.count).slice(0, 30)

      this._cache = {
        messageByBot,
        commandRank,
        triggerRank,
        totalMessages: messageByBot.reduce((s, b) => s + b.send + b.receive, 0),
        totalCommands: commandRank.reduce((s, c) => s + c.count, 0),
        totalTriggers: triggerRank.reduce((s, t) => s + t.count, 0),
      }
      return this._cache
    } catch (e) {
      logger.warn('get error:', e)
      return { messageByBot: [], commandRank: [], triggerRank: [], totalMessages: 0, totalCommands: 0, totalTriggers: 0 }
    }
  }
}

namespace LlAnalytics {
  export interface Config {}
  export const Config: Schema<Config> = Schema.object({})
}

export default LlAnalytics
