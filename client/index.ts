import { store } from '@koishijs/client'
import { defineComponent as D, h, ref, onMounted, onUnmounted, computed } from 'vue'

let ec: any = null
function loadEC(): Promise<any> {
  if (ec) return Promise.resolve(ec)
  return new Promise((resolve) => {
    if ((window as any).echarts) { ec = (window as any).echarts; return resolve(ec) }
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js'
    s.onload = () => { ec = (window as any).echarts; resolve(ec) }
    document.head.appendChild(s)
  })
}

// 图表组件
const Chart = D({
  props: { title: String, data: Array as () => any[], color: { default: '#5470c6' } },
  setup(p) {
    const c = ref<HTMLElement>(); let ch: any = null
    onMounted(async () => {
      await loadEC()
      if (!c.value || !p.data?.length) return
      ch = ec.init(c.value)
      const rev = [...p.data].reverse()
      ch.setOption({
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 120, right: 40, top: 8, bottom: 16 },
        xAxis: { type: 'value' },
        yAxis: { type: 'category', data: rev.map((d: any) => d.name), axisLabel: { width: 100, overflow: 'truncate' } },
        series: [{ type: 'bar', data: rev.map((d: any) => d.value), itemStyle: { color: p.color, borderRadius: [0, 4, 4, 0] } }],
      })
    })
    onUnmounted(() => ch?.dispose())
    return () => h('div', [
      h('h3', { style: 'margin:20px 0 8px;font-size:14px;color:var(--fg1)' }, p.title),
      h('div', { ref: c, style: 'height:' + Math.max(200, (p.data?.length || 1) * 28) + 'px' }),
    ])
  },
})

// 数字卡片
const NumCard = D({
  props: { title: String, icon: String },
  setup(p, { slots }) {
    return () => h('k-card', { class: 'frameless' }, {
      header: () => [h('k-icon', { name: p.icon }), h('span', p.title)],
      default: () => h('p', { style: 'font-size:28px;font-weight:700' }, slots.default?.() || '-'),
      footer: () => h('div', { style: 'display:flex;justify-content:space-between;font-size:12px;color:var(--fg2)' }, [
        h('span', slots['footer-left']?.() || ''),
        h('span', slots['footer-right']?.() || ''),
      ]),
    })
  },
})

// 首页
const Home = D({
  setup() {
    return () => {
      const a = (store as any).analytics
      if (!a) return null
      const d = a.dauHistory || []
      const avg = d.length > 1 ? (d.slice(1).reduce((s: number, v: number) => s + v, 0) / Math.min(d.length - 1, d.length)).toFixed(1) : '0'

      return h('div', {}, [
        // 数字卡片
        h('div', { class: 'card-grid', style: 'display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap' }, [
          h(NumCard, { title: '用户数量', icon: 'user' }, {
            default: () => String(a.userCount || 0),
            'footer-left': () => '昨日新增用户',
            'footer-right': () => String(a.userIncrement || 0),
          }),
          h(NumCard, { title: '群组数量', icon: 'guild' }, {
            default: () => String(a.guildCount || 0),
            'footer-left': () => '昨日新增群组',
            'footer-right': () => String(a.guildIncrement || 0),
          }),
          h(NumCard, { title: '今日 DAU', icon: 'heart' }, {
            default: () => String(d[0] || 0),
            'footer-left': () => '近期 DAU',
            'footer-right': () => avg,
          }),
        ]),

        // 图表
        h('div', { class: 'card-grid', style: 'display:flex;flex-wrap:wrap;gap:8px' }, [
          h('k-slot', { name: 'analytic-chart' }),
        ]),
      ])
    }
  },
})

function cmdChart(a: any) {
  const d = Object.entries(a.commandRate || {}).map(([n, c]: any) => ({ name: n, value: +c.toFixed(1) }))
    .sort((a: any, b: any) => b.value - a.value).slice(0, 15)
  return d.length ? h(Chart, { title: '⚡ 指令调用频率（日均）', data: d, color: '#91cc75' }) : null
}

function msgChart(a: any) {
  const list: any[] = []
  for (const plat of Object.keys(a.messageByBot || {}))
    for (const [sid, st] of Object.entries(a.messageByBot[plat] as any)) {
      const s: any = st
      list.push({ name: s.name || sid, value: +((s.send || 0) + (s.receive || 0)).toFixed(1) })
    }
  const d = list.sort((a: any, b: any) => b.value - a.value)
  return d.length ? h(Chart, { title: '🤖 各机器人消息量（日均）', data: d, color: '#5470c6' }) : null
}

function trgChart(a: any) {
  const d = (a.triggerRank || []).map((t: any) => ({ name: t.keyword, value: t.count })).slice(0, 15)
  return d.length ? h(Chart, { title: '🔑 关键词触发排行', data: d, color: '#ee6666' }) : null
}

const CmdSlot = D({
  setup() { return () => { const a = (store as any).analytics; return a ? cmdChart(a) : null } },
})
const MsgSlot = D({
  setup() { return () => { const a = (store as any).analytics; return a ? msgChart(a) : null } },
})
const TrgSlot = D({
  setup() { return () => { const a = (store as any).analytics; return a ? trgChart(a) : null } },
})

export default (ctx: any) => {
  ctx.slot({ type: 'analytic-chart', component: MsgSlot })
  ctx.slot({ type: 'analytic-chart', component: CmdSlot })
  ctx.slot({ type: 'analytic-chart', component: TrgSlot })
  ctx.slot({ type: 'home', component: Home, order: 0 })
}
