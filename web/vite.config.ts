import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';

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
        //
        // 注意 proxyRes 的类型要显式写上：proxy.on() 继承自 EventEmitter，
        // 而 EventEmitter 的类型来自 @types/node。这个包一旦没装（或没写进
        // devDependencies，只在本地 node_modules 里被 hoist 出来），
        // 'proxyRes' 这个重载就解析不出来，proxyRes 会退化成隐式 any，
        // noImplicitAny 下直接报错 —— 而本机却可能是过的。见 CI 里的 typecheck。
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes: IncomingMessage) => {
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
