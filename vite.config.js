import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

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

// HTTPS=1 (npm run dev:lan): a self-signed certificate, because a headset on the LAN only gets WebXR over https
const https = process.env.HTTPS === '1';

export default defineConfig({
  build: { target: 'esnext', assetsInlineLimit: 0, chunkSizeWarningLimit: 4000 },
  plugins: https ? [basicSsl()] : [],
  // ngrok's domains are let in so `ngrok http 5200` works (Vite refuses Host headers it does not know)
  server: { host: '127.0.0.1', port: 5200, proxy, allowedHosts: ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.io'] },
  preview: { proxy },
});
