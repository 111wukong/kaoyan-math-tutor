import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5180',
        changeOrigin: true,
        // SSE 必须关掉缓冲，否则 AI 流式回复会卡住不动
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (String(proxyRes.headers['content-type'] || '').includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        /* Vite 8 底层换成了 Rolldown，manualChunks 只认函数形式，对象形式会直接报
         * "manualChunks is not a function"。所以这里写成函数按 id 归组。 */
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          const at = (pkgs: string) => new RegExp(`[\\\\/]node_modules[\\\\/](?:${pkgs})[\\\\/]`).test(id);
          if (at('react|react-dom|react-router|react-router-dom|scheduler')) return 'react';
          if (at('recharts|d3-[a-z-]+|victory-vendor|internmap|decimal\\.js-light')) return 'charts';
          if (at('motion|framer-motion|motion-dom|motion-utils')) return 'motion';
          if (at('katex')) return 'math';
          return 'vendor';
        },
      },
    },
  },
});
