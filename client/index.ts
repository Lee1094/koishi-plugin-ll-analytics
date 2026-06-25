import { Context, store } from '@koishijs/client'
import { defineComponent, h, ref, onMounted, onUnmounted } from 'vue'

let echarts: any = null
function loadECharts(): Promise<any> {
  if (echarts) return Promise.resolve(echarts)
  return new Promise((resolve) => {
    if ((window as any).echarts) { echarts = (window as any).echarts; return resolve(echarts) }
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js'
    s.onload = () => { echarts = (window as any).echarts; resolve(echarts) }
    document.head.appendChild(s)
  })
}

const BarChart = defineComponent({
  props: { title: String, data: Array as () => { name: string; value: number }[], color: { default: '#5470c6' } },
  setup(props) {
    const c = ref<HTMLElement>()
    let chart: any = null
    onMounted(async () => {
      await loadECharts()
      if (!c.value || !props.data?.length) return
      chart = echarts.init(c.value)
      const reversed = [...props.data].reverse()
      chart.setOption({
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 130, right: 40, top: 8, bottom: 16 },
        xAxis: { type: 'value' },
        yAxis: { type: 'category', data: reversed.map(d => d.name), axisLabel: { width: 110, overflow: 'truncate' } },
        series: [{ type: 'bar', data: reversed.map(d => d.value), itemStyle: { color: props.color, borderRadius: [0, 4, 4, 0] } }],
      })
    })
    onUnmounted(() => chart?.dispose())
    return () => h('div', [
      h('h3', { style: 'margin:20px 0 8px;font-size:15px;color:var(--fg1)' }, props.title),
      h('div', { ref: c, style: 'height:' + Math.max(200, (props.data?.length || 1) * 30) + 'px' }),
    ])
  },
})

const Page = defineComponent({
  setup() {
    return () => {
      const d: any = (store as any).analytics
      if (!d) return h('div', { style: 'text-align:center;padding:48px;color:var(--fg2)' }, '加载中...')

      // messageByBot: { platform: { selfId: { send, receive, name, ... } } }
      const msgData: { name: string; value: number }[] = []
      if (d.messageByBot) {
        for (const plat of Object.values(d.messageByBot) as any[]) {
          for (const [selfId, stats] of Object.entries(plat as any)) {
            const s: any = stats
            const label = s.name || selfId
            msgData.push({ name: label, value: s.send + s.receive })
          }
        }
        msgData.sort((a, b) => b.value - a.value)
      }

      // commandRate: { name: count }
      const cmdData = Object.entries(d.commandRate || {}).map(([name, count]: any) => ({ name, value: count }))
        .sort((a: any, b: any) => b.value - a.value).slice(0, 15)

      // triggerRank: [{ keyword, count }]
      const trgData = (d.triggerRank || []).map((t: any) => ({ name: t.keyword, value: t.count })).slice(0, 15)

      return h('div', { style: 'padding:0 20px 24px;max-width:900px;margin:0 auto' }, [
        msgData.length > 0 && h(BarChart, { title: '🤖 各机器人消息量（日均）', data: msgData, color: '#5470c6' }),
        cmdData.length > 0 && h(BarChart, { title: '⚡ 指令调用频率（日均）', data: cmdData, color: '#91cc75' }),
        trgData.length > 0 && h(BarChart, { title: '🔑 关键词触发排行', data: trgData, color: '#ee6666' }),
        msgData.length === 0 && cmdData.length === 0 &&
          h('div', { style: 'text-align:center;padding:48px;color:var(--fg2)' }, '暂无数据，使用一段时间后出现'),
      ])
    }
  },
})

export default (ctx: Context) => {
  ctx.addPage({ path: '/ll-analytics', name: '📊 数据分析', icon: 'activity', component: Page })
}
