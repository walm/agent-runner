// Agent event server: harnesses POST events, the game reads a snapshot and follows an SSE stream.
// Plain node:http, no dependencies. `node server/index.mjs [--mock] [--fast]`; PORT (5210) and AGENT_CITY_TOKEN
// from the environment. Serves dist/ as well when it exists, so a production build needs only this process.
// The desktop app (desktop/) runs it compiled, with AGENT_CITY_DIST pointing at the game it ships and
// AGENT_CITY_PARENT_PID at itself, so the server goes when the app does.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, validate, validateBillboard, LIMITS } from './store.mjs';
import { runMock, BILLBOARDS } from './mock.mjs';
import { runRadioDemo } from './radio-demo.mjs';
import { runPlayground } from './playground.mjs';
import { ADAPTERS } from './adapters.mjs';
import { serveModelFile } from './models.mjs';
import { locate, type } from './typer.mjs';
import { intent } from '../src/agents/intent.js';
import { Radio, library, categoriesOf, serveTrack } from './music.mjs';

const PORT = +(process.env.PORT || 5210);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.AGENT_CITY_TOKEN || '';
// AGENT_CITY_INPUT=off: what the driver says is never typed into an agent's terminal (it still reaches the inbox)
const TYPING = !/^(0|off|false|no)$/i.test(process.env.AGENT_CITY_INPUT || '');
const MAX_BODY = 1024 * 1024;
const DIST = process.env.AGENT_CITY_DIST ? join(process.env.AGENT_CITY_DIST, '/') : fileURLToPath(new URL('../dist/', import.meta.url));
const args = new Set(process.argv.slice(2));

const store = new Store();

// started by the desktop app: leave with it, even when it could not say so (a crash, a force quit)
const PARENT = +(process.env.AGENT_CITY_PARENT_PID || 0);
if (PARENT) {
  setInterval(() => {
    try { process.kill(PARENT, 0); } catch { process.exit(0); }
  }, 2000).unref();
}
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
const radio = new Radio((kind, data) => { for (const res of clients) sse(res, kind, data); });

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
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { return send(res, 400, 'bad path'); }
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
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

// Typing into a terminal is as good as being at its keyboard, so it is only taken from the game itself: a custom
// header (a page on another site has to ask first, and the OPTIONS answer does not allow it), and not a cross-site
// request by the browser's own account (Sec-Fetch-Site).
function fromTheGame(req) {
  if (req.headers['x-agent-runner'] !== 'input') return false;
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

// what the driver said or picked, for one agent: what it means at the agent's prompt (intent.js), then typed or
// queued. The body is { text } (said), { choose: 1…9 } (an option picked in the game's list) or { answer: 'yes' |
// 'no' } (its YES and NO for a choice whose options are not known).
const inboxes = new Map(); // agent id -> [{ at, said, kind, keys }]
const wakers = new Map(); // agent id -> Set(fn): long polls waiting on its inbox
const listeners = new Map(); // agent id -> the id of the listener that is current
const listening = new Map(); // agent id -> until when something polls its inbox (a time in the past: when it last did)
// an agent whose own process reads its inbox (the Claude Code mod), now or a moment ago
const listens = (id) => (listening.get(id) || 0) > Date.now() - 40000;
const mocks = new Map(); // agent id -> answer(meant): the mock agents that take what is said (playground.mjs)
let typing = Promise.resolve(); // one at a time: two lines must not interleave their keys
function meaning(a, body) {
  const choices = Array.isArray(a.meta.choices) ? a.meta.choices : [];
  const n = Number.isInteger(body?.choose) && body.choose >= 1 && body.choose <= 9 ? body.choose : 0;
  if (n) {
    const label = choices[n - 1] ? String(choices[n - 1]) : '';
    return { kind: 'choose', label: `PRESS ${n}${label ? ` · ${label.toUpperCase().slice(0, 40)}` : ''}`, keys: [{ key: String(n) }], text: label ? `${n}. ${label}` : `option ${n}`, picked: true };
  }
  if (body?.answer === 'yes') return { kind: 'yes', label: 'YES · ENTER', keys: [{ key: 'enter' }], text: 'yes', picked: true };
  if (body?.answer === 'no') return { kind: 'no', label: 'NO · ESC', keys: [{ key: 'escape' }], text: 'no', picked: true };
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 2000) : '';
  // typed in the game's terminal ({ text, typed: true }) means the same as said
  return { ...intent(text, { status: store.status(a), prompt: a.meta.prompt, choices }), typed: body?.typed === true };
}
async function talk(id, body) {
  const a = store.agents.get(id);
  if (!a) return { ok: false, error: 'no such agent' };
  const meant = meaning(a, body);
  if (!meant.keys.length) return { ok: false, error: 'nothing was said', ...meant };
  const text = meant.text;
  const C = { cyan: '\x1b[36m', grey: '\x1b[90m', red: '\x1b[31m', reset: '\x1b[0m', bold: '\x1b[1m' };
  const echo = (how, ok = true) => store.append(a, `${C.cyan}${C.bold}${meant.picked ? '▸' : meant.typed ? '⌨' : '🎙'} ${text}${C.reset} ${ok ? C.grey : C.red}→ ${meant.label} · ${how}${C.reset}\n`);
  const mock = mocks.get(id);
  if (mock) {
    const note = mock(meant);
    echo(note ? `mock agent, ${note}` : 'mock agent');
    return { ok: true, typed: 'mock agent', kind: meant.kind, label: meant.label };
  }
  const put = () => {
    const list = inboxes.get(id) || [];
    list.push({ at: Date.now(), said: text, kind: meant.kind, keys: meant.keys });
    inboxes.set(id, list.slice(-20));
    for (const wake of [...(wakers.get(id) || [])]) wake();
  };
  const queue = (why) => {
    put();
    store.emit('input', { agent: id, said: text, kind: meant.kind });
    echo(`in its inbox (${why})`, false);
    return { ok: true, queued: true, why, kind: meant.kind, label: meant.label };
  };
  // the Claude Code mod is listening: it answers the question or permission at hand, or sends a prompt
  if (a.meta.via === 'mod' && listens(id)) {
    put();
    echo('Claude Code');
    return { ok: true, typed: 'Claude Code', kind: meant.kind, label: meant.label };
  }
  if (!TYPING) return queue('typing is off on this server');
  if (a.meta.input === 'inbox') return queue('it reads its inbox');
  const run = typing.then(async () => {
    const where = await locate(a);
    if (!where.via) return queue(where.why);
    const r = await type(where, meant.keys);
    if (!r.ok) return queue(r.error);
    echo(r.label);
    return { ok: true, typed: r.label, kind: meant.kind, label: meant.label };
  });
  typing = run.catch(() => {});
  return run;
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
      if (+q.pid > 1) e.meta = { pid: +q.pid, ...(q.host ? { host: q.host } : {}) };
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
      const e = adapt(body, { host: url.searchParams.get('host') || undefined, pid: url.searchParams.get('pid') || undefined });
      if (e.error) return send(res, 400, { ok: false, error: e.error });
      // sent by the Claude Code mod (integrations/claude-code-mod): it takes the driver's words from the inbox itself
      if (url.searchParams.get('via') === 'mod') e.meta = { ...e.meta, via: 'mod' };
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
    // the driver talking to an agent from the game's terminal (src/agents/talk.js): typed into the agent's own
    // terminal (typer.mjs), or left in its inbox
    const said = path.match(/^\/api\/agents\/(.+)\/input$/);
    if (said && req.method === 'POST') {
      if (!authorised(req)) return send(res, 401, { ok: false, error: 'bad or missing bearer token' });
      if (!fromTheGame(req)) return send(res, 403, { ok: false, error: 'only the game can talk to agents (send X-Agent-Runner: input, from its own origin)' });
      const body = await readJson(req, res);
      if (body === undefined) return;
      return send(res, 200, await talk(decodeURIComponent(said[1]), body));
    }
    // ?wait=<s> holds the request until something arrives (up to 30 s): the Claude Code mod listens this way
    const inbox = path.match(/^\/api\/agents\/(.+)\/inbox$/);
    if (inbox && req.method === 'GET') {
      if (!authorised(req)) return send(res, 401, { ok: false, error: 'bad or missing bearer token' });
      const id = decodeURIComponent(inbox[1]);
      const wait = Math.min(30, Math.max(0, +url.searchParams.get('wait') || 0));
      // one listener per agent: a newer one (the mod reloaded, or the session resumed) retires the one before
      const me = url.searchParams.get('listener') || '';
      if (me && listeners.get(id) !== me) { listeners.set(id, me); for (const wake of [...(wakers.get(id) || [])]) wake(); }
      listening.set(id, Date.now() + wait * 1000);
      if (!inboxes.get(id)?.length && wait) {
        await new Promise((resolve) => {
          const t = setTimeout(done, wait * 1000);
          function done() { clearTimeout(t); wakers.get(id)?.delete(done); resolve(); }
          if (!wakers.has(id)) wakers.set(id, new Set());
          wakers.get(id).add(done);
          req.on('close', done);
        });
        listening.set(id, Date.now());
      }
      if (res.destroyed) return;
      if (me && listeners.get(id) !== me) return send(res, 409, { ok: false, error: 'a newer listener took over' });
      const list = inboxes.get(id) || [];
      inboxes.delete(id);
      return send(res, 200, { ok: true, messages: list });
    }
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
      sse(res, 'radio', radio.view());
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    // the agent voice's model, downloaded once and kept on disk (models.mjs)
    if (path.startsWith('/api/voice/') && req.method === 'GET') return serveModelFile('voice', req, res, path.slice('/api/voice/'.length));
    // the speech recognition the game runs to hear the driver (Whistle), the same way
    if (path.startsWith('/api/stt/') && (req.method === 'GET' || req.method === 'HEAD')) return serveModelFile('stt', req, res, path.slice('/api/stt/'.length));
    // the radio: its music (music.mjs) and the agent that DJs it
    if (path === '/api/music' && req.method === 'GET') {
      const tracks = await library();
      return send(res, 200, { categories: categoriesOf(tracks), tracks });
    }
    if (path === '/api/music/file' && (req.method === 'GET' || req.method === 'HEAD')) return serveTrack(req, res, url.searchParams.get('id'));
    if (path === '/api/radio' && req.method === 'GET') {
      return send(res, 200, { radio: radio.view(), categories: categoriesOf(await library()), recent: radio.recent });
    }
    if (path === '/api/radio' && req.method === 'POST') {
      if (!authorised(req)) return send(res, 401, { ok: false, error: 'bad or missing bearer token' });
      // JSON, or the shell-friendly form: options as query params and the announcement as the raw body
      let body;
      const q = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'token'));
      if (Object.keys(q).length) {
        let text;
        try { text = await readBody(req); } catch (e) { return send(res, 413, { ok: false, error: e.message }); }
        body = { ...q, skip: q.skip === 'true' || q.skip === '1', ...(text.trim() && { announce: text }) };
      } else if ((body = await readJson(req, res)) === undefined) return;
      const r = await radio.post(body);
      return send(res, r.ok ? 200 : 400, r);
    }
    if (path === '/api/radio' && req.method === 'DELETE') {
      if (!authorised(req)) return send(res, 401, { ok: false, error: 'bad or missing bearer token' });
      radio.clear();
      return send(res, 200, { ok: true });
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
    // and one to practise talking on: it asks, and takes what is said or picked in its terminal
    const play = runPlayground((events) => ingest(events), { fast: args.has('--fast') });
    mocks.set(play.id, (meant) => play.answer(meant));
    // once the agents have reported in, their billboards go up
    setTimeout(() => {
      for (const b of BILLBOARDS) {
        const v = validateBillboard({ ...b, image: b.svg ? Buffer.from(b.svg) : undefined });
        if (v.ok) store.setBillboard(v.board);
      }
    }, 3000).unref();
    // and a DJ takes the radio (server/radio-demo.mjs): a show of made-up news, and the music to go with it
    // (only to a game that listens: the show starts from the top when one connects)
    runRadioDemo((b) => (clients.size ? radio.post(b) : null), { every: args.has('--fast') ? 25 : 45, first: 8 });
  }
});
