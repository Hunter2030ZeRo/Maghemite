import solid from 'vite-plugin-solid'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [solid()],
  server: {
    fs: { allow: ['..'] },
    proxy: { '/api/themes': 'http://127.0.0.1:8000' },
  },
})
