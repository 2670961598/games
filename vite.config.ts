import { defineConfig } from 'vite'

// 前端源码在 web/，构建产物输出到仓库根 dist/（server/index.js 伺服该目录）
export default defineConfig({
  root: 'web',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // dev 时 API 走 vite 代理打到本机 server（npm run dev 会同时拉起两者）
      '/api': 'http://127.0.0.1:4399',
    },
  },
})
