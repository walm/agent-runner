// Agent Runner for Claude Code: this session gets a building in the city, and the driver can answer it from the
// game wherever the session runs (any terminal, an editor, the desktop app), with no hooks in settings.json.
//
//   out  what the session does goes to the Agent Runner server as Claude Code's own hook payloads
//        (POST /api/hooks/claude-code), which the server already reads (server/adapters.mjs)
//   in   what the driver says or picks in the game waits in the agent's inbox on the server; the mod long-polls it
//        (GET /api/agents/<id>/inbox?wait=25) and acts on it:
//          a message                    -> a prompt of its own once the session is idle ($.prompt.submit)
//          "stop" while it works        -> the running turn ends ($.turn.abort)
//          an answer to a question      -> the AskUserQuestion dialog is answered (its tool call returns)
//          yes / no at a permission     -> the tool runs, or is refused, as if pressed in the dialog
//        The terminal's own dialog stays up meanwhile, and whichever answers first wins.
//
// No server, no harm: the mod checks every few seconds whether the server answers and sends nothing until it
// does. It keeps the session's last events meanwhile, so a game started after the session still shows it, with
// its state, as soon as the server comes up.
import type { Register, EngineInterface } from 'claude-code'

type $ = EngineInterface
// what the server read the driver's words as (src/agents/intent.js): kind, the keys a terminal would get, the words
type Meant = { kind: string; keys: { key?: string; text?: string }[]; said?: string; text?: string }
type Payload = Record<string, unknown> & { hook_event_name: string }

const PROBE_MS = 4000; // how often a missing server is looked for
const KEEP = 60; // events kept for a server that starts later
const WAIT_S = 25; // a long poll's wait for the driver

// the link to the server, for this module's life (a reload starts it over)
const link = {
  base: 'http://127.0.0.1:5210',
  headers: { 'Content-Type': 'application/json' } as Record<string, string>,
  host: 'local',
  cwd: '',
  session: '',
  agent: '', // the id the server's adapter gives this session: claude-code:<host>:<cwd>
  up: false, // the server answers
  retired: false, // a newer copy of the mod listens for this session (a reload): this one stops
  listener: Math.random().toString(36).slice(2), // this copy's name to the server
  polling: false,
  probing: false,
  turnId: undefined as string | undefined,
  start: undefined as Payload | undefined, // the session's start, replayed first
  kept: [] as Payload[],
  sent: new WeakSet<Payload>(), // what this copy has sent to the server it is linked to
  line: Promise.resolve(), // posts go one at a time, in order
  // the question or permission dialog the game may answer: the newest one
  waiting: null as null | { id: string; answer: (m: Meant) => void },
  // tool calls in the race, by id, until one of them reaches its permission dialog
  calls: new Map<string, (m: Meant) => void>(),
  allowOnce: new Set<string>(), // a tool call the driver allowed, run again past its dialog
};

const enc = encodeURIComponent;
const keyOf = (tool: string, input: unknown) => `${tool}:${JSON.stringify(input)}`;
const envelope = (event: string, more: Record<string, unknown>): Payload => ({ hook_event_name: event, session_id: link.session, cwd: link.cwd, ...more });

function remember(p: Payload) {
  if (p.hook_event_name === 'SessionStart') { link.start = p; link.kept.length = 0; return; }
  link.kept.push(p);
  if (link.kept.length > KEEP) link.kept.shift();
}

// a hook payload for the server: kept, and sent while the server is there
function report($: $, p: Payload) {
  if (!link.session && typeof p.session_id === 'string') link.session = p.session_id;
  remember(p);
  if (link.up) send($, p);
}

function send($: $, p: Payload) {
  link.sent.add(p);
  link.line = link.line.then(async () => {
    try {
      const r = await $.http.fetch(`${link.base}/api/hooks/claude-code?host=${enc(link.host)}&via=mod`, { method: 'POST', headers: link.headers, body: JSON.stringify(p) });
      if (r.status >= 500) link.up = false;
    } catch { link.up = false; }
  });
}

// the server: is it there, and does it know this session (it may have started after it, or restarted)
async function probe($: $) {
  if (link.up || link.probing || !link.agent || link.retired) return;
  link.probing = true;
  try {
    const r = await $.http.fetch(`${link.base}/api/health`, { headers: link.headers });
    if (!r.ok) return;
    link.up = true;
    const known = await $.http.fetch(`${link.base}/api/agents/${enc(link.agent)}/output`, { headers: link.headers });
    // a server that does not know the session gets all of it; one that does, what it missed while away
    const all = [link.start || envelope('SessionStart', { source: 'resume' }), ...link.kept];
    for (const p of all) if (known.status === 404 || !link.sent.has(p)) send($, p);
    $.ui.log(`agent-runner: linked to ${link.base}`, { to: 'debug' });
    void poll($);
  } catch { link.up = false; } finally { link.probing = false; }
}

// the driver's words, for as long as the server is there
async function poll($: $) {
  if (link.polling) return;
  link.polling = true;
  try {
    while (link.up) {
      let r;
      try { r = await $.http.fetch(`${link.base}/api/agents/${enc(link.agent)}/inbox?wait=${WAIT_S}&listener=${link.listener}`, { headers: link.headers }); } catch { link.up = false; break; }
      if (r.status === 409) { link.retired = true; link.up = false; break; }
      if (!r.ok) { await $.clock.sleep(2000); continue; }
      let body: { messages?: Meant[] } = {};
      try { body = JSON.parse(r.text); } catch {}
      for (const m of body.messages || []) await act($, m);
    }
  } finally { link.polling = false; }
}

async function act($: $, m: Meant) {
  const said = String(m.said ?? m.text ?? '').trim();
  if (link.waiting) {
    const w = link.waiting;
    link.waiting = null;
    w.answer({ ...m, said });
    return;
  }
  if (m.kind === 'stop' || m.kind === 'no') {
    if (!link.turnId) return;
    await $.turn.abort({ turnId: link.turnId }).catch(() => {});
    // an aborted turn raises no Stop of its own: the city hears it from here
    link.turnId = undefined;
    report($, envelope('Stop', { stop_hook_active: false, stopped_by: 'agent-runner' }));
    return;
  }
  if (said) await $.prompt.submit({ text: said, asUser: true }).catch(() => {});
}

// the number of an option the driver picked: "select 2", "the second one", or the option's own words (the server
// read those already); "yes" is the first, as Enter takes the highlighted one
const picked = (m: Meant) => (m.kind === 'choose' ? Number(m.keys.find((k) => k.key)?.key) || 0 : m.kind === 'yes' ? 1 : 0);

async function linkUp($: $, cwd: string) {
  link.cwd = cwd;
  link.session = await $.session.id().catch(() => link.session);
  try {
    const r = await $.process.run(['hostname', '-s'], { timeoutMs: 3000 });
    if (r.exitCode === 0 && r.stdout.trim()) link.host = r.stdout.trim();
  } catch {}
  link.agent = `claude-code:${link.host}:${cwd}`;
  void probe($);
  $.clock.every(PROBE_MS, () => { void probe($); });
}

export const register: Register = (on, options) => {
  link.base = String(options.url || 'http://127.0.0.1:5210').replace(/\/+$/, '');
  const token = String(options.token || '');
  if (token) link.headers.Authorization = `Bearer ${token}`;

  on('session.start', async ($, e, next) => {
    const started = await next(e);
    await linkUp($, e.cwd);
    return started;
  });

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) link.turnId = e.turnId;
    return next(e);
  });
  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) link.turnId = undefined;
    return next(e);
  });

  // what Claude Code's settings hooks would say, from the engine's own events
  on('classic.SessionStart', ($, e, next) => { report($, e as unknown as Payload); return next(e); });
  on('classic.UserPromptSubmit', ($, e, next) => { report($, e as unknown as Payload); return next(e); });
  on('classic.PostToolUse', ($, e, next) => { report($, e as unknown as Payload); return next(e); });
  on('classic.Notification', ($, e, next) => { report($, e as unknown as Payload); return next(e); });
  on('classic.Stop', ($, e, next) => { report($, e as unknown as Payload); return next(e); });
  on('classic.SubagentStop', ($, e, next) => { report($, e as unknown as Payload); return next(e); });
  on('classic.PreCompact', ($, e, next) => { report($, e as unknown as Payload); return next(e); });
  on('classic.SessionEnd', ($, e, next) => { report($, e as unknown as Payload); return next(e); });

  // a permission dialog is about to show: the tool call it belongs to is the one the game's answer goes to
  on('classic.PermissionRequest', ($, e, next) => {
    report($, e as unknown as Payload);
    const { tool_use_id: id, tool_name: tool } = e as { tool_use_id?: string; tool_name?: string };
    // the question tool asks through this dialog too; its own hook is already waiting for the game
    if (tool === 'AskUserQuestion') return next(e);
    const answer = id ? link.calls.get(id) : [...link.calls.values()].pop();
    if (answer) link.waiting = { id: id || '', answer };
    return next(e);
  });

  // a question with options: the dialog shows as ever, and the game can answer it too; the first answer wins
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    const { tool, tool_use_id, agentId: _a, requestMeta: _m, ...input } = e as typeof e & { requestMeta?: unknown };
    report($, envelope('PreToolUse', { tool_name: tool, tool_input: input, tool_use_id }));
    if (!link.up) return next(e);
    const shown = next(e);
    const fromGame = new Promise<Meant>((answer) => { link.waiting = { id: tool_use_id, answer }; });
    const first = await Promise.race([shown.then((r) => ({ r })), fromGame.then((m) => ({ m }))]);
    if (link.waiting?.id === tool_use_id) link.waiting = null;
    if ('r' in first) return first.r;
    const m = first.m;
    const q = e.questions[0];
    const labels = (q?.options || []).map((o) => o.label);
    const n = picked(m);
    const answer = n ? labels[n - 1] : m.kind === 'message' ? m.said : undefined;
    if (!q || !answer) {
      report($, envelope('PostToolUse', { tool_name: tool, tool_response: 'Dismissed from Agent Runner' }));
      return { deny: `The user dismissed the question from Agent Runner${m.said ? ` and said: ${m.said}` : '.'}` };
    }
    report($, envelope('PostToolUse', { tool_name: tool, tool_response: `${n ? `${n}. ` : ''}${answer} (answered from Agent Runner)` }));
    return { result: { questions: e.questions, answers: { [q.question]: answer } } } as never;
  });

  // a tool the driver allowed from the game runs again, past the dialog
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e);
    if (link.allowOnce.delete(keyOf(e.tool, e.input))) return { ...verdict, decision: 'allow' } as typeof verdict;
    return verdict;
  });

  // any other tool: in the race with the game, in case it stops at a permission dialog
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'AskUserQuestion' || e.agentId !== undefined) return next(e);
    const { tool, tool_use_id, agentId: _a, requestMeta: _m, ...input } = e as typeof e & { requestMeta?: unknown };
    report($, envelope('PreToolUse', { tool_name: tool, tool_input: input, tool_use_id }));
    if (!link.up) return next(e);
    const ran = next(e);
    const fromGame = new Promise<Meant>((answer) => { link.calls.set(tool_use_id, answer); });
    const first = await Promise.race([ran.then((r) => ({ r })), fromGame.then((m) => ({ m }))]);
    link.calls.delete(tool_use_id);
    if (link.waiting?.id === tool_use_id) link.waiting = null;
    if ('r' in first) return first.r;
    const m = first.m;
    const n = picked(m);
    if (n === 1 || n === 2) {
      // allowed: answering here ends the call left at the dialog, and the tool runs again with the allow
      link.allowOnce.add(keyOf(tool, input));
      report($, envelope('PostToolUse', { tool_name: tool, tool_response: 'Allowed from Agent Runner' }));
      return $.tool.call({ tool, ...input } as never) as never;
    }
    report($, envelope('PostToolUse', { tool_name: tool, tool_response: 'Denied from Agent Runner' }));
    return { deny: `The user denied this from Agent Runner${m.kind === 'message' && m.said ? ` and said: ${m.said}` : '.'}` };
  });
};
