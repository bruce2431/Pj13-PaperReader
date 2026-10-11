import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Pj13 预览前端 · Vite 配置
// 生产构建输出到 dist/，由 web 容器后端静态 serve（Pj14 模型）。
// 开发态 VITE_API_BASE 缺省 → 走 src/api/mock.ts（后端仅保留接口契约）。
// __BUILD_TAG__：构建时间戳，App 挂载时写进 document.title——
// 远程（iPad）排查时看浏览器标签页标题即可确认加载的 bundle 版本。
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    proxy: {
      // dev 模式调试：把 /api 转给本机 8130 后端（生产构建不受影响）
      '/api': 'http://127.0.0.1:8130',
    },
  },
  define: {
    __BUILD_TAG__: JSON.stringify(new Date().toLocaleString('sv-SE').slice(5, 16)),
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // pdfjs 单个 worker 大，不拆太碎；保持相对路径便于后端任意前缀 serve
        manualChunks: {
          pdfjs: ['pdfjs-dist'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
})
