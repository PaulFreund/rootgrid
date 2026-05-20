import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import os from 'node:os';

const isWSL = Boolean(process.env.WSL_DISTRO_NAME) || os.release().toLowerCase().includes('microsoft');

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      injectManifest: {
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024
      },
      manifest: {
        name: 'Rootgrid',
        short_name: 'Rootgrid',
        description: 'Local-first web UI for driving Codex via codex app-server',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
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
    host: '0.0.0.0',
    // On WSL or network filesystems, native file watch events may not fire; fall back to polling.
    watch: {
      usePolling: isWSL || process.env.CHOKIDAR_USEPOLLING === '1',
      interval: 200
    },
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
