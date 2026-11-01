// Client side of the agent server: a snapshot then live updates over SSE, plus per-agent output.
// EventSource gives up for good when the server answers with an error (as the dev proxy does while the server is
// down), so the connection is recreated here with a backoff. Every connect starts with a full snapshot.
export const API = (import.meta.env.VITE_AGENT_API || '').replace(/\/$/, '') + '/api';

export class AgentFeed {
  constructor() {
    this.agents = new Map();
    this.connected = false;
    this.onAgent = null; // (agent, { notable, prev, initial }) => void
    this.onRemove = null; // (id) => void
    this.onConnection = null; // (connected) => void
    this.onSnapshot = null; // () => void, after every (re)connect
    this.boards = new Map(); // agent id -> { agent, title, caption, type, v, at }: the agents' billboards
    this.onBoard = null; // (board) => void, put up or replaced
    this.onBoardRemove = null; // (agent id) => void
    this.onRadio = null; // ({ dj, category, track }) => void: the radio's DJ and what it picked (server/music.mjs)
    this.onAnnounce = null; // ({ id, text, from, dj, when }) => void: a DJ's announcement
    this.onSkip = null; // () => void: the DJ skipped the track
    this.outputSubs = new Map(); // id -> Set(fn(text, seq))
    this.retry = 1000;
    this.lastMsg = 0;
    this.connect();
    // the server pings every 15 s; a proxy can hold a stream open after the server behind it has gone
    setInterval(() => {
      if (this.es?.readyState === EventSource.OPEN && performance.now() - this.lastMsg > 40000) { this.setConnected(false); this.connect(); }
    }, 5000);
  }

  connect() {
    clearTimeout(this.timer);
    this.es?.close();
    const es = new EventSource(`${API}/stream`);
    this.es = es;
    this.lastMsg = performance.now();
    const seen = () => { this.lastMsg = performance.now(); };
    es.addEventListener('ping', seen);
    es.addEventListener('agent', seen);
    es.addEventListener('output', seen);
    es.addEventListener('error', () => {
      this.setConnected(false);
      // a dropped stream reconnects on its own; a refused one is CLOSED and needs a new EventSource
      if (es.readyState === EventSource.CLOSED) {
        this.timer = setTimeout(() => this.connect(), this.retry);
        this.retry = Math.min(this.retry * 1.6, 10000);
      }
    });
    es.addEventListener('snapshot', (e) => {
      this.retry = 1000;
      const list = JSON.parse(e.data);
      const ids = new Set(list.map((a) => a.id));
      for (const id of [...this.agents.keys()]) if (!ids.has(id)) { this.agents.delete(id); this.onRemove?.(id); }
      for (const a of list) {
        const prev = this.agents.get(a.id);
        this.agents.set(a.id, a);
        this.onAgent?.(a, { initial: true, prev: prev?.status });
      }
      this.synced = true; // the list is in
      this.setConnected(true);
      this.onSnapshot?.();
    });
    es.addEventListener('agent', (e) => {
      const { agent, prev, notable } = JSON.parse(e.data);
      this.agents.set(agent.id, agent);
      this.onAgent?.(agent, { notable, prev });
    });
    es.addEventListener('remove', (e) => {
      const { id } = JSON.parse(e.data);
      this.agents.delete(id);
      this.onRemove?.(id);
    });
    // every connect sends the whole set after the snapshot; then one at a time
    es.addEventListener('billboards', (e) => {
      const list = JSON.parse(e.data);
      const ids = new Set(list.map((b) => b.agent));
      for (const id of [...this.boards.keys()]) if (!ids.has(id)) { this.boards.delete(id); this.onBoardRemove?.(id); }
      for (const b of list) if (this.boards.get(b.agent)?.v !== b.v) { this.boards.set(b.agent, b); this.onBoard?.(b); }
    });
    es.addEventListener('billboard', (e) => {
      seen();
      const b = JSON.parse(e.data);
      if (b.removed) { if (this.boards.delete(b.agent)) this.onBoardRemove?.(b.agent); return; }
      this.boards.set(b.agent, b);
      this.onBoard?.(b);
    });
    es.addEventListener('radio', (e) => this.onRadio?.(JSON.parse(e.data)));
    es.addEventListener('radio-announce', (e) => this.onAnnounce?.(JSON.parse(e.data)));
    es.addEventListener('radio-skip', () => this.onSkip?.());
    es.addEventListener('output', (e) => {
      const { id, text, seq } = JSON.parse(e.data);
      const subs = this.outputSubs.get(id);
      if (subs) for (const fn of subs) fn(text, seq);
    });
  }

  setConnected(on) {
    if (on === this.connected) return;
    this.connected = on;
    this.onConnection?.(on);
  }

  // the whole buffer; seq is the count of characters ever appended, which live chunks continue from
  async output(id) {
    try {
      const r = await fetch(`${API}/agents/${encodeURIComponent(id)}/output`);
      if (r.ok) return r.json();
    } catch {}
    return { text: '', seq: 0 };
  }

  // where a billboard's image is (the version busts any cache)
  boardImage(b) { return `${API}/billboard/image?agent=${encodeURIComponent(b.agent)}&v=${b.v}`; }

  // live output chunks (text, seq) for one agent; returns an unsubscribe
  subscribe(id, fn) {
    if (!this.outputSubs.has(id)) this.outputSubs.set(id, new Set());
    this.outputSubs.get(id).add(fn);
    return () => this.outputSubs.get(id)?.delete(fn);
  }
}
