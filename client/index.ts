import { Context, store } from '@koishijs/client'
import { defineComponent, h, ref, onMounted, onUnmounted, computed } from 'vue'

let echarts: any = null

function loadECharts(): Promise<any> {
  if (echarts) return Promise.resolve(echarts)
  return new Promise((resolve, reject) => {
    if ((window as any).echarts) {
      echarts = (window as any).echarts
      return resolve(echarts)
    }
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js'
    s.onload = () => { echarts = (window as any).echarts; resolve(echarts) }
    s.onerror = reject
    document.head.appendChild(s)
  })
}

const BarChart = defineComponent({
  props: {
    title: String,
    data: Array as () => { name: string; value: number; extra?: string }[],
    color: { type: String, default: '#5470c6' },
  },
  setup(props) {
    const container = ref<HTMLElement>()
    let chart: any = null

    function render() {
      if (!container.value || !props.data?.length || !echarts) return
      if (!chart) chart = echarts.init(container.value)
      const reversed = [...props.data].reverse()
      chart.setOption({
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          formatter: (p: any) => {
            const d = p[0]
            const idx = props.data.length - 1 - d.dataIndex
            const extra = props.data[idx]?.extra || ''
            return `${d.name}<br/>${extra ? extra + '<br/>' : ''}次数：${d.value}`
          },
        },
        grid: { left: 140, right: 40, top: 8, bottom: 16 },
        xAxis: { type: 'value' },
        yAxis: { type: 'category', data: reversed.map(d => d.name), axisLabel: { width: 110, overflow: 'truncate' } },
        series: [{
          type: 'bar', data: reversed.map(d => d.value),
          itemStyle: { color: props.color, borderRadius: [0, 4, 4, 0] },
        }],
      }, true)
    }

    onMounted(async () => {
      await loadECharts()
      render()
    })
    onUnmounted(() => chart?.dispose())

    return () => h('div', [
      h('h3', { style: 'margin:20px 0 8px;font-size:15px;color:var(--fg1);' }, props.title),
      h('div', { ref: container, style: 'height:' + Math.max(200, (props.data?.length || 1) * 30) + 'px' }),
    ])
  },
})

const Page = defineComponent({
  setup() {
    return () => {
      const d = (store as any).analytics
      if (!d) return h('div', { style: 'text-align:center;padding:48px;color:var(--fg2);' }, '加载中...')

      const msgData = (d.messageByBot || []).map((b: any) => ({
        name: b.bot,
        value: b.send + b.receive,
        extra: `发送 ${b.send.toLocaleString()} ｜ 接收 ${b.receive.toLocaleString()}`,
      }))
      const cmdData = (d.commandRank || []).map((c: any) => ({ name: c.name, value: c.count }))
      const trgData = (d.triggerRank || []).map((t: any) => ({
        name: `${t.plugin} / ${t.keyword}`,
        value: t.count,
      }))

      const nums = [
        { label: '总消息量', value: d.totalMessages || 0 },
        { label: '总指令调用', value: d.totalCommands || 0 },
        { label: '总关键词触发', value: d.totalTriggers || 0 },
      ]

      return h('div', { style: 'padding:0 20px 24px;max-width:900px;margin:0 auto;' }, [
        h('div', { style: 'display:flex;gap:16px;margin:16px 0;flex-wrap:wrap;' },
          nums.map(n => h('div', {
            style: 'flex:1;min-width:130px;background:var(--card-bg,var(--bg2));border-radius:8px;padding:16px;text-align:center;',
          }, [
            h('div', { style: 'font-size:12px;color:var(--fg2);margin-bottom:4px;' }, n.label),
            h('div', { style: 'font-size:28px;font-weight:700;color:var(--fg1);' }, n.value.toLocaleString()),
          ]))
        ),

        msgData.length > 0 && h(BarChart, { title: '🤖 各机器人消息量', data: msgData, color: '#5470c6' }),
        cmdData.length > 0 && h(BarChart, { title: '⚡ 指令调用排行', data: cmdData.slice(0, 15), color: '#91cc75' }),
        trgData.length > 0 && h(BarChart, { title: '🔑 关键词触发排行', data: trgData.slice(0, 15), color: '#ee6666' }),

        msgData.length === 0 && cmdData.length === 0 && trgData.length === 0 &&
          h('div', { style: 'text-align:center;padding:48px;color:var(--fg2);' }, '暂无统计数据，使用一段时间后会自动出现'),
      ])
    }
  },
})

export default (ctx: Context) => {
  ctx.addPage({
    path: '/ll-analytics',
    name: '📊 数据分析',
    icon: 'activity',
    component: Page,
  })
}
