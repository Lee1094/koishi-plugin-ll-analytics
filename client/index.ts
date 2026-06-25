import { Context } from '@koishijs/client'
import { defineComponent, h, ref, onMounted, onUnmounted, computed } from 'vue'

// ECharts from CDN
let echarts: any = null

function loadECharts(): Promise<any> {
  if (echarts) return Promise.resolve(echarts)
  return new Promise((resolve, reject) => {
    if ((window as any).echarts) {
      echarts = (window as any).echarts
      return resolve(echarts)
    }
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js'
    script.onload = () => {
      echarts = (window as any).echarts
      resolve(echarts)
    }
    script.onerror = reject
    document.head.appendChild(script)
  })
}

// 横向柱状图组件
const BarChart = defineComponent({
  props: {
    title: String,
    data: Array as () => { name: string; value: number; extra?: string }[],
    color: { type: String, default: '#5470c6' },
  },
  setup(props) {
    const container = ref<HTMLElement>()
    let chart: any = null

    onMounted(async () => {
      await loadECharts()
      if (!container.value || !props.data?.length) return
      chart = echarts.init(container.value)
      const names = props.data.map(d => d.name).reverse()
      const values = props.data.map(d => d.value).reverse()
      chart.setOption({
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          formatter: (p: any) => {
            const d = p[0]
            const extra = props.data[props.data.length - 1 - d.dataIndex]?.extra || ''
            return `${d.name}<br/>${extra ? extra + '<br/>' : ''}次数：${d.value}`
          },
        },
        grid: { left: 120, right: 40, top: 10, bottom: 20 },
        xAxis: { type: 'value' },
        yAxis: { type: 'category', data: names, axisLabel: { width: 100, overflow: 'truncate' } },
        series: [{
          type: 'bar', data: values,
          itemStyle: { color: props.color, borderRadius: [0, 4, 4, 0] },
        }],
      })
    })

    onUnmounted(() => { chart?.dispose() })

    return () => h('div', [
      h('h3', { style: 'margin: 16px 0 8px; color: var(--fg1);' }, props.title),
      h('div', { ref: container, style: 'height: ' + Math.max(200, props.data.length * 28) + 'px' }),
    ])
  },
})

// 主页面
const Page = defineComponent({
  setup() {
    const data = ref<any>(null)
    const loading = ref(true)
    const timer = ref<any>(null)

    async function fetchData() {
      try {
        loading.value = true
        const svc = (window as any).__koishi_console__?.services?.['ll-analytics']
        if (svc?.get) {
          data.value = await svc.get()
        }
      } catch (e) {
        console.warn('[ll-analytics] fetch error:', e)
      } finally {
        loading.value = false
      }
    }

    onMounted(() => {
      fetchData()
      timer.value = setInterval(fetchData, 60_000)
    })
    onUnmounted(() => clearInterval(timer.value))

    const msgData = computed(() =>
      (data.value?.messageByBot || []).map((b: any) => ({
        name: b.bot,
        value: b.send + b.receive,
        extra: `发送 ${b.send} ｜ 接收 ${b.receive}`,
      }))
    )
    const cmdData = computed(() =>
      (data.value?.commandRank || []).map((c: any) => ({ name: c.name, value: c.count }))
    )
    const trgData = computed(() =>
      (data.value?.triggerRank || []).map((t: any) => ({
        name: `${t.plugin} / ${t.keyword}`,
        value: t.count,
      }))
    )

    return () => {
      if (loading.value && !data.value) {
        return h('div', { style: 'text-align:center;padding:48px;color:var(--fg2);' }, '加载中...')
      }
      if (!data.value) {
        return h('div', { style: 'text-align:center;padding:48px;color:var(--fg2);' }, '暂无数据')
      }

      // 总览数字
      const nums = [
        { label: '总消息量', value: data.value.totalMessages },
        { label: '总指令调用', value: data.value.totalCommands },
        { label: '总关键词触发', value: data.value.totalTriggers },
      ]

      return h('div', { style: 'padding: 0 16px 24px; max-width: 900px; margin: 0 auto;' }, [
        // 概览卡片
        h('div', { style: 'display:flex;gap:16px;margin:16px 0;flex-wrap:wrap;' },
          nums.map(n => h('div', {
            style: 'flex:1;min-width:140px;background:var(--card-bg,var(--bg2));border-radius:8px;padding:16px;text-align:center;',
          }, [
            h('div', { style: 'font-size:13px;color:var(--fg2);margin-bottom:4px;' }, n.label),
            h('div', { style: 'font-size:32px;font-weight:700;color:var(--fg1);' }, n.value.toLocaleString()),
          ]))
        ),

        // 机器人消息量
        msgData.value.length > 0 && h(BarChart, {
          title: '🤖 各机器人消息量（近7天）',
          data: msgData.value,
          color: '#5470c6',
        }),

        // 指令排行
        cmdData.value.length > 0 && h(BarChart, {
          title: '⚡ 指令调用排行（近7天）',
          data: cmdData.value.slice(0, 15),
          color: '#91cc75',
        }),

        // 关键词触发排行
        trgData.value.length > 0 && h(BarChart, {
          title: '🔑 关键词触发排行（近7天）',
          data: trgData.value.slice(0, 15),
          color: '#ee6666',
        }),
      ])
    }
  },
})

export default (ctx: Context) => {
  ctx.addPage({
    path: '/ll-analytics',
    name: '📊 数据分析',
    icon: 'chart-bar',
    component: Page,
  })
}
