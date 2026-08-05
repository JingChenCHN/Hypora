import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// Hypora — frontend build config.
// 分包策略（§11 性能架构）：Mermaid / Prism / markdown 解析按需拆包，
// Vue 内核独立 chunk，保证首屏 ≤300ms 执行预算。
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  css: {
    preprocessorOptions: {
      scss: {
        // 注入通用 mixin 到所有组件样式（主题令牌统一取 CSS 变量）
        additionalData: `@use "@/themes/mixins.scss" as *;\n`,
      },
    },
  },
  build: {
    target: 'es2021',
    sourcemap: process.env.TAURI_ENV_DEBUG === 'true',
    rollupOptions: {
      output: {
        // 函数式 manualChunks（§11）：大依赖独立 chunk，主包保持精简
        manualChunks(id) {
          if (id.includes('node_modules/mermaid') || id.includes('@braintree')) return 'mermaid'
          if (id.includes('node_modules/prismjs')) return 'prism'
          if (id.includes('node_modules/marked') || id.includes('node_modules/turndown')) return 'markdown'
          if (id.includes('node_modules/vue') || id.includes('node_modules/pinia') || id.includes('@vue')) return 'vue'
          if (id.includes('node_modules')) return 'vendor'
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
  esbuild: {
    drop: process.env.NODE_ENV === 'production' ? ['console', 'debugger'] : [],
  },
})
