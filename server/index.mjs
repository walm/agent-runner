// Agent event server: harnesses POST events, the game reads a snapshot and follows an SSE stream.
// Plain node:http, no dependencies. `node server/index.mjs [--mock] [--fast]`; PORT (5210) and AGENT_CITY_TOKEN
// from the environment. Serves dist/ as well when it exists, so a production build needs only this process.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, validate, validateBillboard, LIMITS } from './store.mjs';
import { runMock, BILLBOARDS } from './mock.mjs';
import { ADAPTERS } from './adapters.mjs';

const PORT = +(process.env.PORT || 5210);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.AGENT_CITY_TOKEN || '';
const MAX_BODY = 1024 * 1024;
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const args = new Set(process.argv.slice(2));

const store = new Store();
const clients = new Set();

function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(data);
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

store.on((kind, data) => {
  for (const res of clients) sse(res, kind, data);
});

// agents fall silent without telling anyone: re-announce them when they cross into offline, and prune
const wasOffline = new Set();
setInterval(() => {
  store.prune();
  for (const a of store.agents.values()) {
    const off = store.status(a) === 'offline';
    if (off !== wasOffline.has(a.id)) {
      if (off) wasOffline.add(a.id); else wasOffline.delete(a.id);
      store.emit('agent', { agent: store.summary(a), prev: a.status, notable: false });
    }
  }
}, 15000).unref();

// a real event, not a comment: it keeps proxies from closing idle streams, and lets the client notice a dead link
setInterval(() => { for (const res of clients) sse(res, 'ping', Date.now()); }, 15000).unref();

async function readRaw(req, max = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw Object.assign(new Error(`body larger than ${max} bytes`), { code: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  return (await readRaw(req)).toString('utf8');
}

// POST /api/billboard: the raw image as the body (fields in the query), or JSON with the image as a data URL or
// base64 in "image", or SVG markup in "svg"
async function readBillboard(req, url) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const q = Object.fromEntries([...url.searchParams].filter(([k, v]) => v !== '' && k !== 'token'));
  // base64 grows an image by a third
  const raw = await readRaw(req, Math.ceil(LIMITS.image * 1.4) + 64 * 1024);
  if (type.startsWith('image/')) return { agent: q.agent, title: q.title, caption: q.caption, image: raw.length ? raw : undefined };
  let b;
  try { b = JSON.parse(raw.toString('utf8')); } catch { return { error: 'send the image with an image/* Content-Type, or JSON' }; }
  if (!b || typeof b !== 'object') return { error: 'billboard must be an object' };
  let image;
  if (typeof b.svg === 'string' && b.svg.trim()) image = Buffer.from(b.svg, 'utf8');
  else if (typeof b.image === 'string' && b.image) image = Buffer.from(b.image.replace(/^data:[^,]*;base64,/, ''), 'base64');
  return { agent: b.agent ?? q.agent, title: b.title ?? q.title, caption: b.caption ?? q.caption, image };
}

export function ingest(body) {
  const list = Array.isArray(body) ? body : [body];
  if (!list.length) return { ok: false, error: 'no events' };
  const valid = [];
  for (let i = 0; i < list.length; i++) {
    const v = validate(list[i]);
    if (!v.ok) return { ok: false, error: list.length > 1 ? `event ${i}: ${v.error}` : v.error };
    valid.push(v.event);
  }
  for (const e of valid) store.apply(e);
  return { ok: true, accepted: valid.length };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream', '.woff2': 'font/woff2', '.woff': 'font/woff' };

async function serveStatic(req, res, path) {
  const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, rel);
  if (!file.startsWith(DIST)) return send(res, 403, 'forbidden');
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(DIST, 'index.html');
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, 'not found (run `npm run build` to serve the game from this server)');
  }
}

function authorised(req) {
  return !TOKEN || req.headers.authorization === `Bearer ${TOKEN}` || new URL(req.url, 'http://x').searchParams.get('token') === TOKEN;
}

async function readJson(req, res) {
  // parsed as JSON whatever the Content-Type: `curl -d` sends a form type
  try { return JSON.parse(await readBody(req)); } catch (e) {
    send(res, e.code === 413 ? 413 : 400, { ok: false, error: e.code === 413 ? e.message : 'body is not valid JSON' });
    return undefined;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
    }
    if (path === '/api/health') return send(res, 200, { ok: true, agents: store.agents.size, clients: clients.size });
    if (path === '/api/events' && req.method === 'POST') {
      if (!authorised(req)) return send(res, 401, { ok: false, error: 'bad or missing bearer token' });
      const body = await readJson(req, res);
      if (body === undefined) return;
      const r = ingest(body);
      return send(res, r.ok ? 200 : 400, r);
    }
    // the shell-friendly form: the body is raw text (output, or the message with as=message), the rest is query
    // params, so a script needs no JSON escaping: `cmd | curl --data-binary @- '…/api/text?agent=x'`
    if (path === '/api/text' && req.method === 'POST') {
      if (!authorised(req)) return send(res, 401, { ok: false, error: 'bad or missing bearer token' });
      let text;
      try { text = await readBody(req); } catch (e) { return send(res, 413, { ok: false, error: e.message }); }
      const q = Object.fromEntries([...url.searchParams].filter(([k, v]) => v !== '' && k !== 'token'));
      const e = { agent: q.agent, name: q.name, harness: q.harness, status: q.status, end: q.end === 'true' || q.end === '1' };
      if (text) e[q.as === 'message' ? 'message' : 'text'] = text;
      const r = ingest(e);
      return send(res, r.ok ? 200 : 400, r);
    }
    const hook = path.match(/^\/api\/hooks\/([a-z0-9-]+)$/);
    if (hook && req.method === 'POST') {
      if (!authorised(req)) return send(res, 401, { ok: false, error: 'bad or missing bearer token' });
      const adapt = ADAPTERS[hook[1]];
      if (!adapt) return send(res, 404, { ok: false, error: `no adapter for "${hook[1]}" (have: ${Object.keys(ADAPTERS).join(', ')})` });
      const body = await readJson(req, res);
      if (body === undefined) return;
      const e = adapt(body, { host: url.searchParams.get('host') || undefined });
      if (e.error) return send(res, 400, { ok: false, error: e.error });
      const r = ingest(e);
      return send(res, r.ok ? 200 : 400, r);
    }
    if (path === '/api/billboard' && req.method === 'POST') {
      if (!authorised(req)) return send(res, 401, { ok: false, error: 'bad or missing bearer token' });
      let b;
      try { b = await readBillboard(req, url); } catch (e) { return send(res, 413, { ok: false, error: e.message }); }
      if (b.error) return send(res, 400, { ok: false, error: b.error });
      const v = validateBillboard(b);
      if (!v.ok) return send(res, 400, v);
      const board = store.setBillboard(v.board);
      return send(res, 200, { ok: true, billboard: store.boardSummary(board) });
    }
    if (path === '/api/billboard' && req.method === 'DELETE') {
      if (!authorised(req)) return send(res, 401, { ok: false, error: 'bad or missing bearer token' });
      const id = url.searchParams.get('agent');
      return store.clearBillboard(id) ? send(res, 200, { ok: true }) : send(res, 404, { ok: false, error: 'that agent has no billboard' });
    }
    if (path === '/api/billboards' && req.method === 'GET') return send(res, 200, store.boardList());
    if (path === '/api/billboard/image' && req.method === 'GET') {
      const b = store.boards.get(url.searchParams.get('agent') || '');
      if (!b?.image) return send(res, 404, { ok: false, error: 'no billboard image for that agent' });
      // an SVG opened on its own must not run anything on this origin
      res.writeHead(200, {
        'Content-Type': b.type, 'Content-Length': b.image.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox", 'Access-Control-Allow-Origin': '*',
      });
      return res.end(b.image);
    }
    if (path === '/api/agents' && req.method === 'GET') return send(res, 200, store.list());
    const m = path.match(/^\/api\/agents\/(.+)\/output$/);
    if (m && req.method === 'GET') {
      const out = store.output(decodeURIComponent(m[1]));
      return out ? send(res, 200, out) : send(res, 404, { ok: false, error: 'no such agent' });
    }
    if (path === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' });
      res.flushHeaders();
      res.write('retry: 2000\n\n');
      sse(res, 'snapshot', store.list());
      sse(res, 'billboards', store.boardList());
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (path.startsWith('/api/')) return send(res, 404, { ok: false, error: 'unknown endpoint' });
    if (req.method === 'GET') return serveStatic(req, res, path);
    send(res, 405, 'method not allowed');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { ok: false, error: 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[agent-city] server on http://${HOST}:${PORT}  (POST /api/events · GET /api/agents · SSE /api/stream)${TOKEN ? ' · token required' : ''}`);
  if (args.has('--mock')) {
    console.log('[agent-city] mock agents running in-process');
    runMock((events) => ingest(events), { fast: args.has('--fast') });
    // once the agents have reported in, their billboards go up
    setTimeout(() => {
      for (const b of BILLBOARDS) {
        const v = validateBillboard({ ...b, image: b.svg ? Buffer.from(b.svg) : undefined });
        if (v.ok) store.setBillboard(v.board);
      }
    }, 3000).unref();
  }
});
