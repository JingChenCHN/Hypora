/**
 * AI 加载动效（§14.1 assets/aiLoading.ts）
 * lottie 挂载即播、对话即卸（§9 性能）；主题色从令牌读取，保证设计一致。
 */
import type { ThemeName } from '@/utils/tauriAPI'

export interface LoadingFrame {
  delay: number
  text: string
}

/** 思考中轮播文案 */
export const THINKING_FRAMES: LoadingFrame[] = [
  { delay: 2600, text: '正在思考…' },
  { delay: 2600, text: '正在组织语言…' },
  { delay: 2600, text: '即将完成…' },
]

/** 从当前主题令牌读取主色（供 lottie 着色） */
export function accentColor(): string {
  const el = document.documentElement
  const v = getComputedStyle(el).getPropertyValue('--hypora-accent').trim()
  return v || '#E95420'
}

export function secondaryColor(): string {
  const el = document.documentElement
  return getComputedStyle(el).getPropertyValue('--hypora-aubergine').trim() || '#772953'
}

/** 主题相关转盘动画 SVG（轻量 lottie 替代，无外部依赖） */
export function thinkingSpinnerSVG(size = 28): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="hypora-spinner">
  <circle cx="12" cy="12" r="9" stroke="var(--hypora-border)" stroke-width="2.5" opacity="0.5"/>
  <path d="M21 12a9 9 0 0 0-9-9" stroke="var(--hypora-accent)" stroke-width="2.5" stroke-linecap="round"/>
</svg>`
}

export function themeNow(): ThemeName {
  return (document.documentElement.dataset.theme as ThemeName) || 'light'
}
