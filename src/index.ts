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
}

export const Config: Schema<Config> = Schema.object({
  recentDays: Schema.number()
    .description('统计最近几天的数据').min(1).max(90).step(1).default(7),
  refreshInterval: Schema.number()
    .description('数据缓存刷新间隔（毫秒）').min(30000).max(3600000).step(1000).default(600000),
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
