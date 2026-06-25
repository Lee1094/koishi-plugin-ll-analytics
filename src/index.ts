import { $, Context, Logger, Schema, Time } from 'koishi'

declare module 'koishi' {
  interface Tables {
    analytics_msg: Msg
    analytics_cmd: Cmd
    analytics_trg: Trg
  }
}

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

export const name = 'll-analytics'
export const inject = { required: ['database'] }

interface Msg { date: number; hour: number; type: string; selfId: string; platform: string; count: number }
interface Cmd { date: number; hour: number; name: string; selfId: string; platform: string; userId: string; channelId: string; count: number }
interface Trg { date: number; keyword: string; count: number }

const msgFields: (keyof Msg)[] = ['date', 'hour', 'type', 'selfId', 'platform']
const cmdFields: (keyof Cmd)[] = ['date', 'hour', 'name', 'selfId', 'platform', 'userId', 'channelId']
const trgFields: (keyof Trg)[] = ['date', 'keyword']

function merge<T extends { count: number }>(rows: T[], keys: string[]): T[] {
  const map = new Map<string, T>()
  for (const r of rows) {
    const k = keys.map(k2 => String((r as any)[k2])).join('|')
    const e = map.get(k)
    if (e) { e.count += r.count } else { map.set(k, { ...r }) }
  }
  return [...map.values()]
}

export function apply(ctx: Context, config: Config) {
  const logger = new Logger('ll-analytics')

  ctx.model.extend('analytics_msg', {
    date: 'integer', hour: 'integer', type: 'string(63)',
    selfId: 'string(63)', platform: 'string(63)', count: 'integer',
  }, { primary: msgFields as any })

  ctx.model.extend('analytics_cmd', {
    date: 'integer', hour: 'integer', name: 'string(63)',
    selfId: 'string(63)', platform: 'string(63)',
    userId: 'string(63)', channelId: 'string(63)', count: 'integer',
  }, { primary: cmdFields as any })

  ctx.model.extend('analytics_trg', {
    date: 'integer', keyword: 'string(127)', count: 'integer',
  }, { primary: trgFields as any })

  let msgs: Msg[] = []
  let cmds: Cmd[] = []
  let trgs: Trg[] = []
  let lastFlush = Date.now()
  let cache: any = null
  let cacheTime = 0

  function idx(s: any): Pick<Msg, 'date' | 'hour' | 'selfId' | 'platform'> {
    return {
      date: Time.getDateNumber(),
      hour: new Date().getHours(),
      selfId: s.selfId || s.bot?.selfId || 'unknown',
      platform: s.platform || 'unknown',
    }
  }

  async function flush(force = false) {
    const now = Date.now()
    if (!force && now - lastFlush < 5000) return
    lastFlush = now
    try {
      if (msgs.length) {
        const m = merge(msgs, ['date', 'hour', 'type', 'selfId', 'platform'])
        msgs = []
        for (const r of m) await ctx.database.upsert('analytics_msg', [r as any], msgFields as any)
      }
      if (cmds.length) {
        const m = merge(cmds, ['date', 'hour', 'name', 'selfId', 'platform', 'userId', 'channelId'])
        cmds = []
        for (const r of m) await ctx.database.upsert('analytics_cmd', [r as any], cmdFields as any)
      }
      if (trgs.length) {
        const m = merge(trgs, ['date', 'keyword'])
        trgs = []
        for (const r of m) await ctx.database.upsert('analytics_trg', [r as any], trgFields as any)
      }
    } catch (e) { logger.warn('flush:', e) }
  }

  // 消息统计
  ctx.on('message', (s) => { msgs.push({ ...idx(s), type: 'receive', count: 1 }); flush() })
  ctx.on('send', (s) => { msgs.push({ ...idx(s), type: 'send', count: 1 }); flush() })

  // 指令统计
  ctx.any().before('command/execute', ({ command, session }) => {
    cmds.push({
      ...idx(session),
      name: command.name,
      userId: String((session as any).event?.user?.id || session.userId || ''),
      channelId: session.channelId || '',
      count: 1,
    })
  })

  // 关键词监听
  if (config.trackKeywords?.length) {
    ctx.middleware((session, next) => {
      const text = session.content || ''
      if (typeof text === 'string' && text.trim()) {
        for (const kw of config.trackKeywords) {
          if (text.includes(kw)) {
            trgs.push({ date: Time.getDateNumber(), keyword: kw, count: 1 })
            flush()
            break
          }
        }
      }
      return next()
    }, true)
  }

  // 缓存刷新
  setInterval(() => { cache = null }, config.statsInternal)
  ctx.on('dispose', () => flush(true))

  // 数据查询命令
  ctx.command('analytics.stats', '查看统计数据').action(async () => {
    const days = config.recentDayCount
    const since = Time.getDateNumber() - days

    const mRows = await ctx.database.select('analytics_msg')
      .where(row => $.gt(row.date, since)).groupBy(['selfId', 'type']).execute() as Msg[]
    const botMap = new Map<string, { send: number; receive: number }>()
    for (const r of mRows) {
      const l = r.selfId || 'unknown'
      if (!botMap.has(l)) botMap.set(l, { send: 0, receive: 0 })
      const b = botMap.get(l)!
      if (r.type === 'send') b.send += r.count; else b.receive += r.count
    }
    const botLines = [...botMap.entries()]
      .sort((a, b) => (b[1].send + b[1].receive) - (a[1].send + a[1].receive))
      .map(([bot, v]) => `${bot}: 收${v.receive} 发${v.send}`)
      .join('\n')

    const cRows = await ctx.database.select('analytics_cmd')
      .where(row => $.gt(row.date, since)).groupBy(['name']).execute() as Cmd[]
    const cmdMap = new Map<string, number>()
    for (const r of cRows) cmdMap.set(r.name, (cmdMap.get(r.name) || 0) + r.count)
    const cmdLines = [...cmdMap.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([n, c]) => `${n}: ${c}`).join('\n')

    const tRows = await ctx.database.select('analytics_trg')
      .where(row => $.gt(row.date, since)).groupBy(['keyword']).execute() as Trg[]
    const trgMap = new Map<string, number>()
    for (const r of tRows) trgMap.set(r.keyword, (trgMap.get(r.keyword) || 0) + r.count)
    const trgLines = [...trgMap.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([k, c]) => `${k}: ${c}`).join('\n')

    return `📊 近${days}天统计\n\n🤖 机器人消息量：\n${botLines || '暂无'}\n\n⚡ 指令调用：\n${cmdLines || '暂无'}\n\n🔑 关键词触发：\n${trgLines || '暂无'}`
  })

  logger.info(`已启动：统计${config.recentDayCount}天，刷新${config.statsInternal}ms，关键词${config.trackKeywords?.length || 0}个`)
}
