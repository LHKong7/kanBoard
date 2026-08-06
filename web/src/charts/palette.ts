import { useEffect, useState } from 'react'

/**
 * 图表配色。
 *
 * 三套调色板，每套亮暗各一组，对照
 * `docs/0806planeFeatures/product-features.md` §3.2。
 *
 * ## 每一个色值都是**验算**出来的，不是挑出来的
 *
 * 全部六组都跑过 dataviz 的六项检查（明度带、色度下限、CVD 相邻分离度、
 * 常视力分离度、对比度）。这不是形式主义：一套"看起来挺不一样"的配色，
 * 在红绿色觉异常的人眼里可能有两条序列完全重合，而**图不会报错**——
 * 它只是让那个人读出一个错误的结论。
 *
 * ## 两处与原文档不同，都是被检查逼出来的
 *
 * 1. **每套 8 色，不是 10 色。** 第 9、10 个色相在相邻分离度上无解——
 *    色轮就那么大，塞进十个还要求两两能分辨，做不到。超过 8 条序列时
 *    图表会把尾部合并成「其他」（见 `chart-kit.tsx` 的 `foldSeries`），
 *    而不是循环取色。循环取色的后果是第 9 条和第 1 条同色，
 *    读图的人会把它们当成同一件事。
 *
 * 2. **Earthen 的首色比原文档饱和。** 原文档给的 `#386641` / `#497752`
 *    色度只有 0.077，低于 0.10 的下限——那个绿在图上会读成灰，
 *    于是它不再承担"这是哪条序列"的职责。这里把色度提到刚过线，
 *    色相保持不变，"大地色"的观感还在。
 *
 * 低饱和是一种审美偏好，可辨识是一条功能要求。冲突时让路的是前者。
 */

export type PaletteName = 'modern' | 'horizon' | 'earthen'
export type Mode = 'light' | 'dark'

export type Palette = {
  name: PaletteName
  label: string
  note: string
  series: Record<Mode, readonly string[]>
}

export const PALETTES: readonly Palette[] = [
  {
    name: 'modern',
    label: 'Modern',
    note: '蓝紫冷调，科技感',
    series: {
      // 相邻最差 ΔE 9.1（protan），常视力 19.6 —— 两项都过目标线
      light: ['#6172E8', '#EB6834', '#1BAF7A', '#EDA100', '#E87BA4', '#008300', '#4A3AA7', '#E34948'],
      dark: ['#6B7CDE', '#D95926', '#199E70', '#C98500', '#D55181', '#008300', '#9085E9', '#E66767'],
    },
  },
  {
    name: 'horizon',
    label: 'Horizon',
    note: '橙青撞色，暖对比',
    series: {
      // 亮色相邻最差 ΔE 7.0，落在 6–8 的下限带里 —— 合法，但**必须有第二重编码**。
      // 所以这套配色下图例强制显示、堆叠段之间留 2px 缝、折线带端点标签
      light: ['#E76E50', '#1BAF7A', '#4A3AA7', '#EDA100', '#E87BA4', '#008300', '#2A78D6', '#E34948'],
      dark: ['#E05A3A', '#199E70', '#9085E9', '#C98500', '#D55181', '#008300', '#3987E5', '#E66767'],
    },
  },
  {
    name: 'earthen',
    label: 'Earthen',
    note: '大地绿棕，低饱和',
    series: {
      light: ['#2F7A32', '#1E7FB0', '#B5651D', '#8E5BA6', '#B08900', '#3E6FC0', '#BC4749', '#00887A'],
      dark: ['#2E8C45', '#3A93C7', '#C97A2E', '#A06FB8', '#B08F0C', '#5A85D8', '#D05A5C', '#0A9C8B'],
    },
  },
]

/**
 * 界面色（非数据色）。
 *
 * 网格线、坐标轴、文字**一律不穿序列色**。一条黄色的坐标轴文字
 * 在浅色背景上几乎读不出来，而且它会让人以为那行字属于某条序列。
 * 身份由文字**旁边**那个色块承担，不由文字本身。
 */
export const INK: Record<Mode, Record<string, string>> = {
  light: {
    surface: '#FCFCFB',
    text: '#0B0B0B',
    secondary: '#52514E',
    muted: '#898781',
    grid: '#E1E0D9',
    axis: '#C3C2B7',
  },
  dark: {
    surface: '#1A1A19',
    text: '#FFFFFF',
    secondary: '#C3C2B7',
    muted: '#898781',
    grid: '#2C2C2A',
    axis: '#383835',
  },
}

/**
 * 状态色。**保留色**——永远不拿来当第 9 条序列。
 *
 * 它们带着"好 / 该注意 / 出事了"的含义，被当成普通序列用一次之后，
 * 这个含义在整个界面上就失效了。
 */
export const STATUS: Record<string, string> = {
  good: '#0CA30C',
  warning: '#FAB219',
  serious: '#EC835A',
  critical: '#D03B3B',
}

/**
 * 状态组的固定配色。
 *
 * 用**序数**而不是类别色：六个组之间有顺序（待分诊 → 待办 → 已排期 →
 * 进行中 → 完成），顺序本身就是信息。给它们随机分配类别色的话，
 * 进度条上"完成"可能比"待办"还浅，看图的人得先读图例才知道哪头是好的。
 */
export const GROUP_COLORS: Record<Mode, Record<string, string>> = {
  light: {
    Triage: '#C3C2B7',
    Backlog: '#A8B3C4',
    Unstarted: '#7E93B8',
    Started: '#2A78D6',
    Completed: '#0CA30C',
    Cancelled: '#E1E0D9',
  },
  dark: {
    Triage: '#5A5A56',
    Backlog: '#5B6779',
    Unstarted: '#6C82A8',
    Started: '#3987E5',
    Completed: '#0CA30C',
    Cancelled: '#383835',
  },
}

const STORAGE_KEY = 'projectos.chartPalette'

export function loadPalette(): PaletteName {
  const raw = localStorage.getItem(STORAGE_KEY)
  return PALETTES.some((p) => p.name === raw) ? (raw as PaletteName) : 'modern'
}

export function savePalette(name: PaletteName): void {
  localStorage.setItem(STORAGE_KEY, name)
}

/**
 * 当前是亮色还是暗色。
 *
 * 跟随系统而不是自己存一份开关，并且**监听变化**：
 * 只在挂载时读一次的话，用户切换系统主题后图表会留在旧配色上，
 * 而页面其余部分已经变了——看起来像图表坏了。
 */
export function useMode(): Mode {
  const [mode, setMode] = useState<Mode>(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light',
  )

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setMode(e.matches ? 'dark' : 'light')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return mode
}

export function seriesColors(name: PaletteName, mode: Mode): readonly string[] {
  const palette = PALETTES.find((p) => p.name === name) ?? PALETTES[0]
  return (palette as Palette).series[mode]
}

/**
 * 序列名 → 颜色。
 *
 * **按名字取色，不按当前排名。** 筛掉一条序列之后，剩下那些的颜色
 * 必须不变——一个记住了"支付重构是蓝色"的人，会被重新上色的图误导。
 * 所以取色的键是 `groups` 里的下标，而 `groups` 是排过序的稳定集合。
 */
export function colorOf(groups: readonly string[], group: string, colors: readonly string[]): string {
  const index = groups.indexOf(group)
  if (index < 0) return colors[0] as string
  // 折叠之后不可能超过 8 条，这里的取模只是兜底，不是取色策略
  return colors[index % colors.length] as string
}
