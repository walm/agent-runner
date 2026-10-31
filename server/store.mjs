// In-memory agent registry: validates incoming events, keeps a summary and a bounded output buffer per agent,
// and tells listeners what changed. No I/O here, so it can be tested on its own.
//
// An event is one flat object. Only `agent` is required; every other field is optional and independent, so a
// hook can say "waiting, and here is why" in one POST:
//   { agent, name?, harness?, status?, message?, text?, meta?, end? }

export const STATUSES = new Set(['idle', 'working', 'waiting', 'error', 'done']);
// a status change into one of these is worth interrupting the driver for
export const NOTABLE = new Set(['waiting', 'error', 'done']);

export const LIMITS = {
  id: 200,
  name: 120,
  harness: 40,
  message: 2000,
  text: 64 * 1024,
  output: 256 * 1024,
  meta: 4 * 1024,
  agents: 500,
};
export const OFFLINE_MS = 15 * 60 * 1000;
export const PRUNE_ENDED_MS = 2 * 60 * 60 * 1000;
export const PRUNE_SILENT_MS = 24 * 60 * 60 * 1000;

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);

// returns { ok: true, event } or { ok: false, error }
export function validate(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, error: 'event must be an object' };
  const agent = typeof e.agent === 'string' ? e.agent.trim() : '';
  if (!agent) return { ok: false, error: '"agent" (a stable id string) is required' };
  if (agent.length > LIMITS.id) return { ok: false, error: `"agent" is longer than ${LIMITS.id} chars` };
  if (e.status !== undefined && !STATUSES.has(e.status)) return { ok: false, error: `"status" must be one of ${[...STATUSES].join(', ')}` };
  if (e.text !== undefined && typeof e.text !== 'string') return { ok: false, error: '"text" must be a string' };
  if (e.message !== undefined && typeof e.message !== 'string') return { ok: false, error: '"message" must be a string' };
  let meta;
  if (e.meta !== undefined) {
    if (!e.meta || typeof e.meta !== 'object' || Array.isArray(e.meta)) return { ok: false, error: '"meta" must be an object' };
    if (JSON.stringify(e.meta).length > LIMITS.meta) return { ok: false, error: `"meta" is larger than ${LIMITS.meta} bytes` };
    meta = e.meta;
  }
  return {
    ok: true,
    event: {
      agent, meta,
      name: str(e.name, LIMITS.name),
      harness: str(e.harness, LIMITS.harness)?.toLowerCase(),
      status: e.status,
      message: str(e.message, LIMITS.message),
      text: typeof e.text === 'string' && e.text ? e.text.slice(0, LIMITS.text) : undefined,
      end: e.end === true,
    },
  };
}

export class Store {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.agents = new Map();
    this.listeners = new Set();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind, data) { for (const fn of this.listeners) fn(kind, data); }

  // apply one validated event
  apply(e) {
    const t = this.now();
    let a = this.agents.get(e.agent);
    if (!a) {
      if (this.agents.size >= LIMITS.agents) this.prune(true);
      // seq counts every character ever appended to out, so a reader can tell a duplicate chunk from a gap
      a = { id: e.agent, name: e.agent, harness: 'other', status: 'idle', last: '', meta: {}, firstSeen: t, lastSeen: t, ended: null, out: '', seq: 0 };
      this.agents.set(e.agent, a);
    }
    a.lastSeen = t;
    if (e.name) a.name = e.name;
    if (e.harness) a.harness = e.harness;
    if (e.meta) Object.assign(a.meta, e.meta);
    const prev = a.status;
    if (e.status) { a.status = e.status; a.ended = null; }
    if (e.message) {
      a.last = e.message.split('\n')[0].slice(0, 300);
      this.append(a, `\x1b[2m› ${e.message.replace(/\n+$/, '')}\x1b[0m\n`);
    }
    if (e.text) this.append(a, e.text);
    if (e.end) { a.status = 'done'; a.ended = t; }
    const notable = a.status !== prev && NOTABLE.has(a.status);
    this.emit('agent', { agent: this.summary(a), prev, notable });
    return a;
  }

  append(a, text) {
    // xterm wants CRLF; harnesses send LF
    const chunk = text.replace(/\r?\n/g, '\r\n');
    a.out += chunk;
    if (a.out.length > LIMITS.output) {
      // cut at a line boundary so the buffer never starts mid escape sequence or mid character
      let cut = a.out.length - LIMITS.output;
      const nl = a.out.indexOf('\n', cut);
      if (nl !== -1) cut = nl + 1;
      a.out = a.out.slice(cut);
    }
    a.seq += chunk.length;
    this.emit('output', { id: a.id, text: chunk, seq: a.seq });
  }

  status(a, t = this.now()) {
    if (a.status !== 'done' && t - a.lastSeen > OFFLINE_MS) return 'offline';
    return a.status;
  }

  summary(a) {
    return { id: a.id, name: a.name, harness: a.harness, status: this.status(a), last: a.last, meta: a.meta, firstSeen: a.firstSeen, lastSeen: a.lastSeen, seq: a.seq };
  }

  list() { return [...this.agents.values()].map((a) => this.summary(a)); }

  output(id) {
    const a = this.agents.get(id);
    return a ? { id, text: a.out, seq: a.seq } : null;
  }

  // drop agents that ended a while ago or went silent for a day; when full, also the longest silent one
  prune(force = false) {
    const t = this.now();
    for (const a of this.agents.values()) {
      if ((a.ended && t - a.ended > PRUNE_ENDED_MS) || t - a.lastSeen > PRUNE_SILENT_MS) this.remove(a.id);
    }
    if (force && this.agents.size >= LIMITS.agents) {
      const oldest = [...this.agents.values()].sort((x, y) => x.lastSeen - y.lastSeen)[0];
      this.remove(oldest.id);
    }
  }

  remove(id) {
    if (!this.agents.delete(id)) return false;
    this.emit('remove', { id });
    return true;
  }
}
