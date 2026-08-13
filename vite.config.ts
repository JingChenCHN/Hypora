import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  server: {
    port: 5300,
    open: true
  },
  optimizeDeps: {
    include: ['element-plus']
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    // 构建产物分块策略：将大体积依赖拆到独立 chunk，减小主包、改善首屏加载与长缓存命中率
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // rolldown(Vite 8)的 manualChunks 只接受函数形式：按路径把大体积依赖拆到独立 chunk
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          // mermaid 及其图渲染依赖（dagre/d3/cytoscape 等）单独成块，且只由 markdown.ts 动态 import() 引用，
          // 使其成为按需加载的 async chunk（不出现在 index.html 的 modulepreload 首屏预加载列表）。
          // 注意：不能让它掉进下面的 'vendor' 默认块——vendor 被静态依赖会首屏加载，会把 mermaid 3MB 拖进首屏。
          // mermaid 及其图渲染依赖（dagre/d3/cytoscape 等）不分配到任何 manual chunk（return undefined），
          // 交给 rolldown 默认逻辑：它们仅由 markdown.ts 动态 import() 引用，自动切成按需 async chunk，
          // 不出现在 index.html 的 modulepreload 首屏预加载列表。
          // （return 'mermaid' 会被静态化、落到 'vendor' 则因 vendor 被静态依赖——两种都会首屏加载 3MB）
          if (id.includes('mermaid') || id.includes('dagre') || id.includes('cytoscape') || id.includes('/d3-') || id.includes('/d3/') || id.includes('elkjs') || id.includes('khroma')) return undefined
          // html2canvas/jspdf 仅导出 PDF/图片时动态 import()；lottie-web 仅 AI 面板（异步组件）使用。
          // 同理不能进 vendor 静态块，交给 rolldown 默认逻辑切成按需 async chunk。
          if (id.includes('html2canvas') || id.includes('jspdf') || id.includes('lottie')) return undefined
          if (id.includes('katex')) return 'katex'
          if (id.includes('element-plus') || id.includes('@element-plus/icons-vue')) return 'element-plus'
          if (id.includes('marked') || id.includes('turndown')) return 'markdown'
          if (id.includes('@vue') || id.includes('pinia') || /[\\/]vue[\\/]/.test(id)) return 'vue-vendor'
          return 'vendor'
        }
      }
    }
  }
})
