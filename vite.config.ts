import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  // Los archivos de public/ (style.css) se sirven como assets estáticos
  publicDir: 'public',

  build: {
    outDir: 'dist',
    emptyOutDir: true
  },

  server: {
    // Allow binding to the local network so other devices can reach the dev server
    // `true` tells Vite to listen on all addresses (0.0.0.0)
    host: true,
    port: 3002,
    proxy: {
      // API REST → Express en :3001
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      // Página de status → Express en :3001
      '/status': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      // WebSocket de signaling → Express en :3001
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true
      }
    }
  }
})
