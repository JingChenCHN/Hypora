import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import './assets/reset.scss'
import './themes/index.scss'
import App from './App.vue'
import { ensurePrismLangs } from './utils/markdown'

// 启动前应用持久化主题，避免初始浅色闪烁
;(function () {
  const t = localStorage.getItem('hypora_theme')
  if (t) document.documentElement.setAttribute('data-theme', t)
})()

const app = createApp(App)

app.use(createPinia())
app.use(ElementPlus)

app.mount('#app')

// mount 完成即移除加载遮罩（不等 window load + 固定延时），加快感知启动
removeAppLoading()

function removeAppLoading() {
  const loading = document.getElementById('app-loading')
  if (!loading) return
  loading.style.opacity = '0'
  setTimeout(() => loading.remove(), 300)
}

// 后台预加载 Prism 语法高亮语言组件（动态 import，规避静态求值顺序导致的 "Prism is not defined"）
ensurePrismLangs()