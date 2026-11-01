// The agents list (G): every agent with its harness, status and latest line. DRIVE sets a waypoint to the door,
// WARP puts the car at the kerb outside. ↑/↓ choose, Enter drives, Esc or G closes.
import { styleOf } from './visuals.js';
import { esc } from '../core/esc.js';

// the agents that want you first, then the busy ones
const RANK = { waiting: 0, error: 1, working: 2, done: 3, idle: 4, offline: 5 };

export class AgentPanel {
  constructor(root) {
    root.insertAdjacentHTML('beforeend', `
      <div id="aglist" class="screen hidden">
        <div class="sheet">
          <h2>AGENTS IN THE CITY</h2>
          <div class="agrows"></div>
          <div class="agfoot"><span class="conn"></span><span><span class="key">↑ ↓</span>CHOOSE <span class="key">ENTER</span>DRIVE <span class="key">W</span>WARP <span class="key">ESC</span>CLOSE · <span class="key">PAD</span>STICK · A DRIVE · Y WARP · B CLOSE</span></div>
        </div>
      </div>`);
    this.el = root.querySelector('#aglist');
    this.rows = this.el.querySelector('.agrows');
    this.conn = this.el.querySelector('.conn');
    this.sel = 0;
    this.order = [];
    this.onDrive = null; // (id) => void
    this.onWarp = null;
    this.onClose = null;
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ag]');
      if (!b) { if (e.target === this.el) this.onClose?.(); return; }
      const id = b.closest('[data-id]')?.dataset.id;
      if (b.dataset.ag === 'drive') this.onDrive?.(id);
      else if (b.dataset.ag === 'warp') this.onWarp?.(id);
    });
  }

  get open() { return !this.el.classList.contains('hidden'); }

  show(entries, connected) {
    this.el.classList.remove('hidden');
    this.render(entries, connected);
  }

  hide() { this.el.classList.add('hidden'); }

  render(entries, connected) {
    const list = [...entries].sort((a, b) => (RANK[a.agent.status] ?? 9) - (RANK[b.agent.status] ?? 9) || b.agent.lastSeen - a.agent.lastSeen);
    const selId = this.order[this.sel];
    this.order = list.map((e) => e.agent.id);
    this.sel = Math.max(0, Math.min(list.length - 1, selId ? this.order.indexOf(selId) : 0));
    if (this.sel < 0) this.sel = 0;
    this.conn.innerHTML = connected ? '<i class="on"></i>LINKED · /api/stream' : '<i></i>NO LINK · retrying';
    if (!list.length) {
      this.rows.innerHTML = `<div class="agempty">No agents have reported in yet.<br><small>POST an event to <b>/api/events</b>, or run <b>npm run dev</b> for the mock agents.</small></div>`;
      return;
    }
    this.rows.innerHTML = list.map(({ agent: a, dist }, i) => {
      const s = styleOf(a.status);
      return `<div class="agrow ${i === this.sel ? 'sel' : ''} ${a.status === 'waiting' ? 'pulse' : ''}" data-id="${esc(a.id)}" style="--c:${s.css}">
        <span class="dot"></span>
        <div class="nm"><b>${esc(a.name)}</b><small>${esc(a.harness)} · ${esc(a.last || '—')}</small></div>
        <div class="st">${s.en}<small>${dist < 1000 ? `${Math.round(dist)} M` : `${(dist / 1000).toFixed(1)} KM`}</small></div>
        <div class="acts"><button class="btn" data-ag="drive">DRIVE</button><button class="btn ghost" data-ag="warp">WARP</button></div>
      </div>`;
    }).join('');
  }

  move(d) {
    if (!this.order.length) return;
    this.sel = (this.sel + d + this.order.length) % this.order.length;
    this.rows.querySelectorAll('.agrow').forEach((r, i) => r.classList.toggle('sel', i === this.sel));
    this.rows.children[this.sel]?.scrollIntoView({ block: 'nearest' });
  }

  selected() { return this.order[this.sel]; }
}
