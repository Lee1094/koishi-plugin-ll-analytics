import { $, Context, Logger, Schema, Time } from 'koishi'

declare module 'koishi' {
  interface Tables {
    analytics_msg: { date: number; hour: number; type: string; selfId: string; platform: string; count: number }
    analytics_cmd: { date: number; hour: number; name: string; selfId: string; platform: string; userId: string; channelId: string; count: number }
    analytics_trg: { date: number; keyword: string; count: number }
  }
}

export interface Config {
  statsInternal: number
  recentDayCount: number
  trackKeywords: string[]
}

export const Config: Schema<Config> = Schema.object({
  statsInternal: Schema.number().description('数据刷新间隔（毫秒）').min(10000).max(3600000).step(1000).default(600000),
  recentDayCount: Schema.number().description('统计最近几天').min(1).max(90).step(1).default(7),
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

export const name = 'll-analytics'
export const inject = ['database']

export function apply(ctx: Context, config: Config) {
  const logger = new Logger('ll-analytics')

  ctx.model.extend('analytics_msg', {
    date: 'integer', hour: 'integer', type: 'string(63)',
    selfId: 'string(63)', platform: 'string(63)', count: 'integer',
  }, { primary: ['date', 'hour', 'type', 'selfId', 'platform'] })

  ctx.model.extend('analytics_cmd', {
    date: 'integer', hour: 'integer', name: 'string(63)',
    selfId: 'string(63)', platform: 'string(63)',
    userId: 'string(63)', channelId: 'string(63)', count: 'integer',
  }, { primary: ['date', 'hour', 'name', 'selfId', 'platform', 'userId', 'channelId'] })

  ctx.model.extend('analytics_trg', {
    date: 'integer', keyword: 'string(127)', count: 'integer',
  }, { primary: ['date', 'keyword'] })

  type Row = { date: number; count: number; [key: string]: any }
  let msgs: Row[] = [], cmds: Row[] = [], trgs: Row[] = []
  const MSG_KEYS = ['date', 'hour', 'type', 'selfId', 'platform']
  const CMD_KEYS = ['date', 'hour', 'name', 'selfId', 'platform', 'userId', 'channelId']
  const TRG_KEYS = ['date', 'keyword']
  let lastFlush = Date.now()

  function idx(s: any) {
    return { date: Time.getDateNumber(), hour: new Date().getHours(), selfId: s.selfId || s.bot?.selfId || 'unknown', platform: s.platform || 'unknown' }
  }

  function merge<T extends Row>(rows: T[], keys: string[]): T[] {
    const m = new Map<string, T>()
    for (const r of rows) { const k = keys.map(k2 => String(r[k2])).join('|'); const e = m.get(k); if (e) e.count += r.count; else m.set(k, { ...r }) }
    return [...m.values()]
  }

  async function flush(force = false) {
    const now = Date.now(); if (!force && now - lastFlush < 5000) return; lastFlush = now
    try {
      if (msgs.length) { const m = merge(msgs, MSG_KEYS); msgs = []; for (const r of m) await ctx.database.upsert('analytics_msg', [r as any], MSG_KEYS as any) }
      if (cmds.length) { const m = merge(cmds, CMD_KEYS); cmds = []; for (const r of m) await ctx.database.upsert('analytics_cmd', [r as any], CMD_KEYS as any) }
      if (trgs.length) { const m = merge(trgs, TRG_KEYS); trgs = []; for (const r of m) await ctx.database.upsert('analytics_trg', [r as any], TRG_KEYS as any) }
    } catch (e: any) { logger.warn('flush:', e?.message || e) }
  }

  ctx.on('message', (s) => { msgs.push({ ...idx(s), type: 'receive', count: 1 }); flush() })
  ctx.on('send', (s) => { msgs.push({ ...idx(s), type: 'send', count: 1 }); flush() })

  ctx.any().before('command/execute', ({ command, session }) => {
    cmds.push({ ...idx(session), name: command.name, userId: String((session as any).event?.user?.id || (session as any).userId || ''), channelId: session.channelId || '', count: 1 })
  })

  if (config.trackKeywords?.length) {
    ctx.middleware((session, next) => {
      const text = session.content || ''
      if (typeof text === 'string') for (const kw of config.trackKeywords) if (text.includes(kw)) { trgs.push({ date: Time.getDateNumber(), keyword: kw, count: 1 }); flush(); break }
      return next()
    }, true)
  }

  ctx.on('dispose', () => flush(true))

  ctx.command('analytics', '查看数据统计').action(async () => {
    const since = Time.getDateNumber() - config.recentDayCount
    const mRows: any[] = await ctx.database.select('analytics_msg').where(r => $.gt(r.date, since)).groupBy(['selfId', 'type']).execute()
    const bots = new Map<string, { s: number; r: number }>(); for (const r of mRows) { const l = r.selfId || '?'; if (!bots.has(l)) bots.set(l, { s: 0, r: 0 }); const b = bots.get(l)!; if (r.type === 'send') b.s += r.count; else b.r += r.count }
    const botLines = [...bots.entries()].sort((a, b) => (b[1].s + b[1].r) - (a[1].s + a[1].r)).map(([n, v]) => `${n}: 收${v.r} 发${v.s}`).join('\n')

    const cRows: any[] = await ctx.database.select('analytics_cmd').where(r => $.gt(r.date, since)).groupBy(['name']).execute()
    const cm = new Map<string, number>(); for (const r of cRows) cm.set(r.name, (cm.get(r.name) || 0) + r.count)
    const cmdLines = [...cm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([n, c]) => `${n}: ${c}`).join('\n')

    const tRows: any[] = await ctx.database.select('analytics_trg').where(r => $.gt(r.date, since)).groupBy(['keyword']).execute()
    const tm = new Map<string, number>(); for (const r of tRows) tm.set(r.keyword, (tm.get(r.keyword) || 0) + r.count)
    const trgLines = [...tm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, c]) => `${k}: ${c}`).join('\n')

    return `📊 近${config.recentDayCount}天统计\n\n🤖 消息量\n${botLines || '暂无'}\n\n⚡ 指令排行\n${cmdLines || '暂无'}\n\n🔑 关键词触发\n${trgLines || '暂无'}`
  })

  logger.info(`已启动 | ${config.recentDayCount}天 | ${config.trackKeywords?.length || 0}个关键词`)
}
