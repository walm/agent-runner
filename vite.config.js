import { defineConfig } from 'vite';

// the agent server (server/index.mjs) listens on 5210; in dev the game reaches it through /api on its own origin
const API = `http://127.0.0.1:${process.env.AGENT_CITY_PORT || 5210}`;
// when the server goes away, end the browser's side of a proxied stream too, so the EventSource reconnects
const proxy = {
  '/api': {
    target: API,
    changeOrigin: true,
    configure: (p) => p.on('proxyRes', (proxyRes, req, res) => proxyRes.on('close', () => { if (!res.writableEnded) res.end(); })),
  },
};

export default defineConfig({
  build: { target: 'esnext', assetsInlineLimit: 0, chunkSizeWarningLimit: 4000 },
  server: { host: '127.0.0.1', port: 5200, proxy },
  preview: { proxy },
});
