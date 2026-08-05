/**
 * Hypora 入口（§9 性能架构：主题预应用同步执行，防闪屏）
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'

import '@fontsource/ubuntu/400.css'
import '@fontsource/ubuntu/700.css'
import '@fontsource/ubuntu-mono/400.css'
import '@/assets/reset.scss'
import '@/themes/index.scss'

import App from '@/App.vue'
import { settings, type ThemeName } from '@/utils/tauriAPI'

// 启动前预应用主题（§7：localStorage 主题 → data-theme，0ms 同步）
const theme = settings.get<ThemeName>('theme', 'system')
document.documentElement.dataset.theme = theme

// 全局点击关闭下拉菜单
window.addEventListener('pointerdown', (e) => {
  const target = e.target as HTMLElement
  if (target.closest('.t-btn .menu')) return
  document.querySelectorAll('.menu').forEach((m) => m.parentElement?.classList.remove('open'))
  // 无实际 open class 的菜单通过内部状态控制，此处仅供清理兜底
})

const app = createApp(App)
app.use(createPinia())
app.mount('#app')

// 未捕获异常 → 内核日志（§10 崩溃取证）
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason)
})
window.addEventListener('error', (e) => {
  console.error('[window.error]', e.message)
})
