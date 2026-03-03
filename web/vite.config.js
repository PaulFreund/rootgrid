import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      manifest: {
        name: 'Rootgrid',
        short_name: 'Rootgrid',
        description: 'Local-first web UI for driving Codex via codex app-server',
        theme_color: '#0b0f16',
        background_color: '#0b0f16',
        display: 'standalone',
        icons: [
          {
            src: '/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any'
          }
        ]
      }
    })
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7337',
        changeOrigin: true
      },
      '/v1': {
        target: 'http://127.0.0.1:7337',
        ws: true,
        changeOrigin: true
      },
      '/vscode': {
        target: 'http://127.0.0.1:7337',
        ws: true,
        changeOrigin: true
      }
    }
  }
})
