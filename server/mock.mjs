// Mock agents: eight scripted sessions across four harnesses that send the same events a real hook would.
// In-process: runMock(post) where post(events) ingests directly. Standalone, over HTTP like a real harness:
//   node server/mock.mjs [--url http://127.0.0.1:5210] [--fast] [--token T]
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', mag: '\x1b[35m', cyan: '\x1b[36m', grey: '\x1b[90m' };
const host = 'mbp-walm';

export const AGENTS = [
  { id: `claude-code:${host}:shop-api:7f3a`, harness: 'claude-code', name: 'shop-api · auth refactor', cwd: '~/src/shop-api', model: 'claude-opus-5-5', tasks: ['Refactor session handling to signed cookies', 'Add rate limiting to /login', 'Fix flaky checkout test'] },
  { id: `claude-code:${host}:depict-web:21bd`, harness: 'claude-code', name: 'depict-web · search UI', cwd: '~/src/depict-web', model: 'claude-sonnet-5-5', tasks: ['Build faceted search sidebar', 'Debounce query input', 'Write Playwright test for filters'] },
  { id: `claude-code:${host}:infra:0c99`, harness: 'claude-code', name: 'infra · terraform drift', cwd: '~/src/infra', model: 'claude-opus-5-5', tasks: ['Reconcile terraform drift in eu-north-1', 'Tighten IAM on the ingest bucket'] },
  { id: `codex:${host}:ranker:5e01`, harness: 'codex', name: 'ranker · feature store', cwd: '~/src/ranker', model: 'codex', tasks: ['Port feature store reader to Arrow', 'Profile the scoring loop'] },
  { id: `codex:${host}:etl:a1a1`, harness: 'codex', name: 'etl · nightly job', cwd: '~/src/etl', model: 'codex', tasks: ['Backfill October events', 'Add dead-letter queue for bad rows'] },
  { id: `pi:${host}:notes:3c3c`, harness: 'pi', name: 'notes · summariser', cwd: '~/notes', model: 'pi', tasks: ['Summarise the week of meeting notes', 'Tag notes by project'] },
  { id: `pi:${host}:dotfiles:77aa`, harness: 'pi', name: 'dotfiles · zsh cleanup', cwd: '~/.dotfiles', model: 'pi', tasks: ['Speed up shell start', 'Move aliases into modules'] },
  { id: 'deploy-bot:ci:prod', harness: 'deploy-bot', name: 'deploy-bot · prod', cwd: 'ci://prod', model: 'workflow', tasks: ['Roll out shop-api v2.14', 'Canary depict-web 5%'] },
];

const FILES = ['src/auth/session.ts', 'src/routes/login.ts', 'src/lib/cookies.ts', 'tests/checkout.spec.ts', 'src/components/Facets.tsx', 'main.tf', 'iam.tf', 'ranker/features.py', 'etl/backfill.py', 'zshrc', 'README.md'];
const TOOLS = ['Read', 'Edit', 'Bash', 'Grep', 'Write'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const between = (a, b) => a + Math.random() * (b - a);

function diff(file) {
  const n = 1 + Math.floor(Math.random() * 3);
  let s = `${C.bold}${file}${C.reset}\n`;
  for (let i = 0; i < n; i++) {
    const line = 10 + Math.floor(Math.random() * 180);
    s += `${C.cyan}@@ -${line},4 +${line},5 @@${C.reset}\n`;
    s += `${C.grey}   const cfg = loadConfig();${C.reset}\n`;
    s += `${C.red}-  const token = req.headers['x-token'];${C.reset}\n`;
    s += `${C.green}+  const token = readSignedCookie(req, 'sid');${C.reset}\n`;
    s += `${C.green}+  if (!token) return unauthorised(res);${C.reset}\n`;
  }
  return s;
}

function tests(pass) {
  const total = 20 + Math.floor(Math.random() * 60);
  const failed = pass ? 0 : 1 + Math.floor(Math.random() * 3);
  let s = '';
  for (let i = 0; i < 4; i++) s += `${C.green} ✓${C.reset} ${C.dim}${pick(['session', 'login', 'cookies', 'checkout', 'facets'])} ${pick(['renews token', 'rejects expired', 'handles empty', 'debounces', 'paginates'])} (${Math.floor(between(2, 90))} ms)${C.reset}\n`;
  if (!pass) s += `${C.red} ✗ checkout › applies discount once${C.reset}\n${C.red}   Expected: 90\n   Received: 81${C.reset}\n`;
  s += `\n ${pass ? C.green : C.red}${C.bold}Tests: ${total - failed} passed${failed ? `, ${failed} failed` : ''}, ${total} total${C.reset}\n`;
  return s;
}

function* session(a) {
  const task = pick(a.tasks);
  yield { status: 'working', meta: { task }, message: `New task: ${task}` };
  yield { text: `\n${C.mag}${C.bold}❯${C.reset} ${C.bold}${task}${C.reset}\n\n` };
  const steps = 3 + Math.floor(Math.random() * 4);
  for (let s = 0; s < steps; s++) {
    yield { wait: between(2, 6) };
    yield { text: `${C.dim}✻ Thinking…${C.reset}\n` };
    yield { wait: between(1.5, 4) };
    const tool = pick(TOOLS), file = pick(FILES);
    yield { message: `${tool} ${file}`, text: `${C.yellow}⏺${C.reset} ${C.bold}${tool}${C.reset}(${file})\n` };
    yield { wait: between(0.8, 2.5) };
    if (tool === 'Edit' || tool === 'Write') yield { text: diff(file) };
    else if (tool === 'Bash') yield { text: `${C.grey}$ npm test -- ${file}${C.reset}\n${tests(Math.random() > 0.3)}` };
    else yield { text: `${C.grey}  ⎿  ${Math.floor(between(20, 400))} lines${C.reset}\n` };
    // ask for permission now and then: the driver has to come by
    if (Math.random() < 0.18) {
      const q = `Allow ${pick(['edit to', 'rm -rf on', 'network call from', 'migration in'])} ${pick(FILES)}?`;
      yield { status: 'waiting', message: q, text: `\n${C.mag}${C.bold}? ${q}${C.reset} ${C.dim}(y/n)${C.reset}\n` };
      yield { wait: between(20, 45) };
      yield { status: 'working', text: `${C.green}  y — approved${C.reset}\n` };
    }
    if (Math.random() < 0.08) {
      yield { status: 'error', message: 'Command failed: exit code 1', text: `${C.red}${C.bold}Error:${C.reset}${C.red} ECONNRESET while fetching registry.npmjs.org${C.reset}\n` };
      yield { wait: between(8, 16) };
      yield { status: 'working', message: 'Retrying' };
    }
  }
  yield { wait: between(2, 4) };
  yield { status: 'done', message: `Finished: ${task}`, text: `\n${C.green}${C.bold}✔ Done.${C.reset} ${task}\n` };
  yield { wait: between(15, 40) };
  yield { status: 'idle' };
  yield { wait: between(10, 30) };
}

// Billboards the mock agents put up: three posters as an agent would draw them (SVG it wrote for its task) and two
// that are only words. Each SVG is square, the way the docs ask: the city fits it to tall and wide screens.
const poster = (bg1, bg2, accent, art, big, small) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs>
<rect width="1024" height="1024" fill="url(#g)"/>
<g stroke="${accent}" stroke-opacity="0.14" stroke-width="2">${Array.from({ length: 15 }, (_, i) => `<line x1="0" y1="${64 + i * 64}" x2="1024" y2="${64 + i * 64}"/>`).join('')}</g>
${art}
<text x="512" y="820" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="900" font-size="120" fill="#ffffff">${big}</text>
<text x="512" y="900" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="600" font-size="44" letter-spacing="10" fill="${accent}">${small}</text>
</svg>`;
export const BILLBOARDS = [
  {
    agent: AGENTS[0].id, title: 'Signed cookies', caption: 'Sessions move off headers onto signed, HTTP-only cookies',
    svg: poster('#1a0610', '#050208', '#ff3d6e',
      '<circle cx="512" cy="380" r="230" fill="#c98a4b"/><circle cx="430" cy="310" r="34" fill="#5a3518"/><circle cx="600" cy="300" r="26" fill="#5a3518"/><circle cx="560" cy="460" r="38" fill="#5a3518"/><circle cx="420" cy="470" r="22" fill="#5a3518"/>'
      + '<rect x="600" y="430" width="200" height="170" rx="22" fill="#ff3d6e"/><path d="M640 430v-60a60 60 0 0 1 120 0v60" fill="none" stroke="#ff3d6e" stroke-width="34"/><circle cx="700" cy="505" r="22" fill="#1a0610"/>',
      'SIGNED', 'AUTH REFACTOR · SHOP-API'),
  },
  {
    agent: AGENTS[1].id, title: 'Faceted search', caption: 'Filters down the side, results that keep up as you type',
    svg: poster('#041420', '#02060c', '#3be8ff',
      '<rect x="180" y="150" width="200" height="460" rx="18" fill="none" stroke="#3be8ff" stroke-width="10"/>' + [0, 1, 2, 3, 4].map((i) => `<rect x="212" y="${190 + i * 82}" width="${90 + (i % 3) * 30}" height="26" rx="13" fill="#3be8ff" fill-opacity="${0.9 - i * 0.12}"/>`).join('')
      + [0, 1, 2].map((r) => [0, 1].map((c) => `<rect x="${430 + c * 210}" y="${150 + r * 160}" width="180" height="130" rx="14" fill="#0b2a3a" stroke="#3be8ff" stroke-opacity="0.6" stroke-width="4"/>`).join('')).join(''),
      'SEARCH', 'DEPICT-WEB · FACETS'),
  },
  {
    agent: AGENTS[2].id, title: 'Drift: zero', caption: 'eu-north-1 reconciled with the plan',
    svg: poster('#0d0a1c', '#04030a', '#a98bff',
      '<polygon points="512,140 742,272 742,536 512,668 282,536 282,272" fill="none" stroke="#a98bff" stroke-width="14"/><polygon points="512,230 664,318 664,494 512,582 360,494 360,318" fill="#a98bff" fill-opacity="0.22"/>'
      + '<path d="M430 400l60 60 120-130" fill="none" stroke="#5dff9a" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/>',
      'DRIFT 0', 'INFRA · TERRAFORM'),
  },
  { agent: AGENTS[4].id, title: 'October backfilled', caption: '31 days · 4.2M rows · 0 dead letters' },
  { agent: AGENTS[7].id, title: 'v2.14 is live', caption: 'shop-api rolled out to prod · canary clean' },
];

// post(events) may return a promise; errors are logged and the agent carries on
export function runMock(post, { fast = false, agents = AGENTS } = {}) {
  const k = fast ? 0.33 : 1;
  const timers = new Set();
  const sleep = (s) => new Promise((r) => { const t = setTimeout(() => { timers.delete(t); r(); }, s * 1000 * k); timers.add(t); });
  let stopped = false;
  async function drive(a, i) {
    const base = { agent: a.id, harness: a.harness, name: a.name };
    await sleep(i * 0.6);
    await safe(post, { ...base, status: 'idle', meta: { cwd: a.cwd, model: a.model }, text: `${C.grey}${a.harness} · ${a.model} · ${a.cwd}${C.reset}\n` });
    while (!stopped) {
      for (const step of session(a)) {
        if (stopped) return;
        if (step.wait) { await sleep(step.wait); continue; }
        const list = (Array.isArray(step) ? step : [step]).map((e) => ({ ...base, ...e }));
        await safe(post, list);
      }
    }
  }
  agents.forEach((a, i) => drive(a, i));
  return () => { stopped = true; for (const t of timers) clearTimeout(t); };
}

async function safe(post, events) {
  try {
    const r = await post(events);
    if (r && r.ok === false) console.warn('[mock] rejected:', r.error);
  } catch (e) {
    console.warn('[mock] post failed:', e.message);
  }
}

// run as a script of its own, not imported; inside the desktop app's single compiled file every module shares the
// entry's URL, so the file name decides
if (process.argv[1] === fileURLToPath(import.meta.url) && basename(process.argv[1]) === 'mock.mjs') {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const url = opt('--url', 'http://127.0.0.1:5210').replace(/\/$/, '');
  const token = opt('--token', process.env.AGENT_CITY_TOKEN || '');
  console.log(`[mock] posting ${AGENTS.length} agents to ${url}/api/events`);
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  setTimeout(() => {
    for (const b of BILLBOARDS) fetch(`${url}/api/billboard`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(b) }).catch(() => {});
  }, 3000);
  runMock(async (events) => {
    const r = await fetch(`${url}/api/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(events) });
    return r.json();
  }, { fast: argv.includes('--fast') });
}
