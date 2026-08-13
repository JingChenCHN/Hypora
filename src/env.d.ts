/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module 'prismjs/components/prism-core'
declare module 'mermaid/dist/mermaid.esm.min.mjs'
declare module 'turndown'
declare module 'html2canvas'
declare module 'jspdf'