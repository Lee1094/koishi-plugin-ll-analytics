import { $, Context, Dict, Logger, Schema, Session, Time, Universal } from 'koishi'
import { DataService } from '@koishijs/console'
import { resolve } from 'path'

declare module 'koishi' {
  interface Tables {
    'analytics.message': Analytics.Message
    'analytics.command': Analytics.Command
    'analytics.trigger': Analytics.Trigger
  }
}

declare module '@koishijs/console' {
  namespace Console {
    interface Services {
      analytics: Analytics
    }
  }
}

export interface MessageStats { send: number; receive: number }

const logger = new Logger('analytics')

class Analytics extends DataService<Analytics.Payload> {
  static inject = ['database', 'console']

  lastUpdate = new Date()
  updateHour = this.lastUpdate.getHours()
  cachedDate: number
  cachedData: Promise<Analytics.Payload>

  private messages: Analytics.Message[] = []
  private commands: Analytics.Command[] = []
  private triggers: Analytics.Trigger[] = []

  constructor(ctx: Context, public config: Analytics.Config = {} as Analytics.Config) {
    super(ctx, 'analytics')

    ctx.model.extend('analytics.message', {
      date: 'integer', hour: 'integer', type: 'string(63)',
      selfId: 'string(63)', platform: 'string(63)', count: 'integer',
    }, { primary: ['date', 'hour', 'type', 'selfId', 'platform'] })

    ctx.model.extend('analytics.command', {
      date: 'integer', hour: 'integer', name: 'string(63)',
      selfId: 'string(63)', userId: 'integer', channelId: 'string(63)',
      platform: 'string(63)', count: 'integer',
    }, { primary: ['date', 'hour', 'name', 'selfId', 'userId', 'channelId', 'platform'] })

    ctx.model.extend('analytics.trigger', {
      date: 'integer', keyword: 'string(127)', count: 'integer',
    }, { primary: ['date', 'keyword'] })

    ctx.on('exit', () => this.upload(true))
    ctx.on('dispose', async () => { await this.upload(true) })

    ctx.on('message', (session) => {
      this.messages.push({ ...this._idx(session), type: 'receive', count: 1 })
      this.upload()
    })
    ctx.on('send', (session) => {
      this.messages.push({ ...this._idx(session), type: 'send', count: 1 })
      this.upload()
    })

    ctx.any().before('command/execute', ({ command, session }) => {
      this.commands.push({
        ...this._idx(session), name: command.name,
        userId: (session as any).user?.['id'] || 0,
        channelId: (session as any).channelId || '',
        count: 1,
      })
      this.upload()
    })

    // 关键词监听
    if (this.config.trackKeywords?.length) {
      ctx.middleware((session, next) => {
        const t = (session as any).content || ''
        if (typeof t === 'string') for (const kw of this.config.trackKeywords!)
          if (t.includes(kw)) { this.triggers.push({ date: Time.getDateNumber(), keyword: kw, count: 1 }); this.upload(); break }
        return next()
      }, true)
    }

    ctx.console.addEntry({
      dev: resolve(__dirname, '../client/index.ts'),
      prod: resolve(__dirname, '../dist'),
    })
  }

  private _idx(session: any) {
    return {
      selfId: session.selfId || (session as any).bot?.selfId || '0',
      platform: session.platform || 'unknown',
      date: Time.getDateNumber(),
      hour: new Date().getHours(),
    }
  }

  async upload(forced = false) {
    const date = new Date()
    const dateHour = date.getHours()
    if (forced || +date - +this.lastUpdate > (this.config.statsInternal || 600000) || dateHour !== this.updateHour) {
      this.lastUpdate = date
      this.updateHour = dateHour
      const db = this.ctx.database
      try {
        if (this.messages.length) {
          const buf = this.messages; this.messages = []
          for (const r of buf) await db.upsert('analytics.message', [r as any], ['date', 'hour', 'type', 'selfId', 'platform'])
        }
        if (this.commands.length) {
          const buf = this.commands; this.commands = []
          for (const r of buf) await db.upsert('analytics.command', [r as any], ['date', 'hour', 'name', 'selfId', 'userId', 'channelId', 'platform'])
        }
        if (this.triggers.length) {
          const buf = this.triggers; this.triggers = []
          for (const r of buf) await db.upsert('analytics.trigger', [r as any], ['date', 'keyword'])
        }
        logger.debug('analytics updated')
      } catch (e: any) { logger.warn('upload:', e?.message || e) }
    }
  }

  private _qRecent() {
    const d = this.config.recentDayCount || 7
    return { $gte: Time.getDateNumber() - d, $lt: Time.getDateNumber() } as any
  }

  private async _getCommandRate(lengthTask: Promise<number>) {
    const data: any[] = await this.ctx.database.select('analytics.command' as any, { date: this._qRecent() })
      .groupBy(['name'], { count: (row: any) => $.sum(row.count) }).execute()
    const len = await lengthTask
    const result: Dict<number> = {}
    data.forEach(s => { result[s.name] = s.count / len })
    return result
  }

  private async _getDauHistory() {
    const d = this.config.recentDayCount || 7
    const data: any[] = await this.ctx.database.select('analytics.command' as any, { date: { $gte: Time.getDateNumber() - d }, userId: { $gt: 0 } })
      .groupBy(['date'], { count: (row: any) => $.count(row.userId) }).execute()
    const result: number[] = new Array(d + 1).fill(0)
    const today = Time.getDateNumber()
    data.forEach(s => { result[today - s.date] = s.count })
    return result
  }

  private async _getMessageByBot(lengthTask: Promise<number>) {
    const data: any[] = await this.ctx.database.select('analytics.message' as any, { date: this._qRecent() })
      .groupBy(['type', 'platform', 'selfId'], { count: (row: any) => $.sum(row.count) }).execute()
    const len = await lengthTask
    const result: Dict<Dict<MessageStats & Universal.User>> = {}
    data.forEach(s => {
      const entry = (result[s.platform] ||= {})[s.selfId] ||= {
        ...this.ctx.bots[`${s.platform}:${s.selfId}`]?.user, send: 0, receive: 0,
      }
      entry[s.type] = s.count / len
    })
    return result
  }

  private async _getMessageByDate() {
    const data: any[] = await this.ctx.database.select('analytics.message' as any, { date: { $lt: Time.getDateNumber() } })
      .groupBy(['type', 'date'], { count: (row: any) => $.sum(row.count) }).orderBy('date', 'desc').execute()
    const today = Time.getDateNumber()
    const result: MessageStats[] = []
    data.forEach(s => {
      const entry = result[today - s.date] ||= { send: 0, receive: 0 }
      entry[s.type] = s.count
    })
    for (let i = 0; i < result.length; i++) result[i] ||= { send: 0, receive: 0 }
    return result
  }

  private async _getMessageByHour(lengthTask: Promise<number>) {
    const data: any[] = await this.ctx.database.select('analytics.message' as any, { date: this._qRecent() })
      .groupBy(['type', 'hour'], { count: (row: any) => $.sum(row.count) }).execute()
    const len = await lengthTask
    const result = new Array(24).fill(null).map(() => ({ send: 0, receive: 0 }))
    data.forEach(s => { result[s.hour][s.type] = s.count / len })
    return result
  }

  private async _getTriggerRank() {
    const data: any[] = await this.ctx.database.select('analytics.trigger' as any)
      .groupBy(['keyword'], { count: (row: any) => $.sum(row.count) }).execute()
    return data.sort((a, b) => b.count - a.count).slice(0, 30)
  }

  async download(): Promise<Analytics.Payload> {
    const messageByDateTask = this._getMessageByDate()
    const lengthTask = messageByDateTask.then(data => Math.min(Math.max(data.length - 1, 1), this.config.recentDayCount || 7))
    const [
      userCount, userIncrement, guildCount, guildIncrement,
      commandRate, dauHistory, messageByBot, messageByDate, messageByHour, triggerRank,
    ] = await Promise.all([
      this.ctx.database.eval('user', row => $.count(row.id)),
      this.ctx.database.eval('user', row => $.count(row.id), {
        createdAt: { $gte: Time.fromDateNumber(Time.getDateNumber() - 1), $lt: Time.fromDateNumber(Time.getDateNumber()) },
      }),
      this.ctx.database.eval('channel', row => $.sum(1), row => $.eq(row.id, row.guildId)),
      this.ctx.database.eval('channel', row => $.sum(1), row => $.and(
        $.eq(row.id, row.guildId),
        $.gte(row.createdAt, Time.fromDateNumber(Time.getDateNumber() - 1)),
        $.lt(row.createdAt, Time.fromDateNumber(Time.getDateNumber())),
      )),
      this._getCommandRate(lengthTask),
      this._getDauHistory(),
      this._getMessageByBot(lengthTask),
      messageByDateTask,
      this._getMessageByHour(lengthTask),
      this._getTriggerRank(),
    ])
    return { userCount, userIncrement, guildCount, guildIncrement, commandRate, dauHistory, messageByBot, messageByDate, messageByHour, triggerRank }
  }

  async get() {
    const date = new Date()
    const dateNumber = Time.getDateNumber(date, date.getTimezoneOffset())
    if (dateNumber !== this.cachedDate) {
      this.cachedData = this.download()
      this.cachedDate = dateNumber
    }
    return this.cachedData
  }
}

namespace Analytics {
  export interface Index { id?: number; date: number; hour: number; selfId: string; platform: string }
  export interface Message extends Index { type: string; count: number }
  export interface Command extends Index { name: string; userId: number; channelId: string; count: number }
  export interface Trigger { date: number; keyword: string; count: number }

  export interface Payload {
    userCount: number; userIncrement: number
    guildCount: number; guildIncrement: number
    dauHistory: number[]
    commandRate: Dict<number>
    messageByBot: Dict<Dict<MessageStats & Universal.User>>
    messageByDate: MessageStats[]
    messageByHour: MessageStats[]
    triggerRank: { keyword: string; count: number }[]
  }

  export interface Config {
    statsInternal?: number
    recentDayCount?: number
    trackKeywords?: string[]
  }

  export const Config: Schema<Config> = Schema.object({
    statsInternal: Schema.natural().role('ms').description('统计数据推送的时间间隔。').default(Time.minute * 10),
    recentDayCount: Schema.natural().description('统计最近几天的数据。').default(7),
    trackKeywords: Schema.array(Schema.string()).role('table').description('要统计的关键词').default([
      '门派升级', '门派费用', '探索日志', '探索地图', '礼包码', '主播礼包码',
      '神功牌属性', '秘功牌属性', '装备', '仙幻装备', '装备升级', '装备强化',
      '桃子礼包码', '桃子礼包', '八卦', '八卦牌', '血猪八卦', '飞凤八卦', '鬼灵墓八卦', '仙幻八卦',
      '菜单', '帮助', '世界boss', '世界BOSS', '活动链接', '怀旧活动', '怀旧服活动',
      '拳师词条', '拳师技能', '火剑词条', '火剑技能',
      '气功词条', '气功技能', '攻时词条', '攻时技能', '推龙词条', '推龙技能',
      '冰气功词条', '冰气功技能', '冰气词条', '冰气技能', '冰河词条', '冰河技能',
      '力士词条', '力士技能', '执行词条', '执行技能', '执行力士词条', '执行力士技能',
      '毁灭词条', '毁灭技能', '毁灭力士词条', '毁灭力士技能',
      '刺客词条', '刺客技能', '召唤词条', '召唤技能', '大黄蜂词条', '大黄蜂技能',
      '攻血词条', '攻血技能', '召唤攻血词条', '召唤攻血技能',
      '向日葵词条', '向日葵技能', '召唤向日葵词条', '召唤向日葵技能',
      '灵剑士词条', '灵剑士技能', '灵剑词条', '灵剑技能', '雷灵词条', '雷灵技能', '雷电词条', '雷电技能', '雷力士词条',
      '风灵词条', '风灵技能', '灵剑风系词条', '灵剑风系技能', '风云词条', '风云技能',
      '咒术师词条', '咒术师技能', '咒术词条', '咒术技能', '诅咒词条', '诅咒技能', '黑炎龙词条', '黑炎龙技能',
      '冰咒词条', '冰咒技能', '冰系咒术词条', '冰系咒术技能', '咒术冰系词条', '咒术冰系技能', '咒术师冰系词条', '咒术师冰系技能', '冰龙词条', '冰龙技能',
      '魔枪词条', '魔枪技能', '魔枪士词条', '魔枪士技能',
      '小助手下载', '剑士词条', '剑士技能', '雷剑词条', '雷剑技能', '刺剑词条', '刺剑技能',
    ]),
  })
}

export default Analytics
