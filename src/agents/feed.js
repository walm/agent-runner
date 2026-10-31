// Client side of the agent server: a snapshot then live updates over SSE, plus per-agent output.
// EventSource gives up for good when the server answers with an error (as the dev proxy does while the server is
// down), so the connection is recreated here with a backoff. Every connect starts with a full snapshot.
const API = (import.meta.env.VITE_AGENT_API || '').replace(/\/$/, '') + '/api';

export class AgentFeed {
  constructor() {
    this.agents = new Map();
    this.connected = false;
    this.onAgent = null; // (agent, { notable, prev, initial }) => void
    this.onRemove = null; // (id) => void
    this.onConnection = null; // (connected) => void
    this.onSnapshot = null; // () => void, after every (re)connect
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

  // live output chunks (text, seq) for one agent; returns an unsubscribe
  subscribe(id, fn) {
    if (!this.outputSubs.has(id)) this.outputSubs.set(id, new Set());
    this.outputSubs.get(id).add(fn);
    return () => this.outputSubs.get(id)?.delete(fn);
  }
}
