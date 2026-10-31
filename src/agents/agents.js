// The agent layer: the feed, where each agent lives, its beacon and name tag, the list and the terminal, and the
// glue to the game (prompt at the door, compass/minimap/map markers, toasts and radio for what needs you).
// Overlays reuse screens.open ('agents' | 'terminal'), so the car freezes and other menus stay shut as for any screen.
import { AgentFeed } from './feed.js';
import { Placement } from './placement.js';
import { AgentVisuals, CAP, styleOf } from './visuals.js';
import { AgentLabels } from './labels.js';
import { AgentPanel } from './panel.js';
import { TerminalView, ago } from './terminal.js';
import './agents.css';

const DOCK_R = 7; // how close to the kerb ring counts as arrived
// in the beam over the roof counts too: within BEAM_R of its axis (wider than the 2.4 m shaft, it is hard to hit
// in the air), from just under the roof to the top of the beam (visuals.js)
const BEAM_R = 8, BEAM_H = 140;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class AgentLayer {
  constructor({ city, ui, screens, hud }) {
    this.city = city;
    this.screens = screens;
    this.hud = hud;
    this.placement = new Placement(city);
    this.visuals = new AgentVisuals();
    this.group = this.visuals.group;
    this.labels = new AgentLabels(ui);
    this.panel = new AgentPanel(ui);
    this.feed = new AgentFeed();
    this.term = new TerminalView(ui, this.feed);
    this.entries = new Map(); // id -> { agent, place, slot, dist }
    this.free = Array.from({ length: CAP }, (_, i) => CAP - 1 - i);
    this.game = null;
    this.near = null;
    this.notes = new Map(); // id -> time of the last notification, to keep chatty agents quiet
    this.listDirty = false;

    // the HUD chip: count, how many need you, link state; a tap opens the list (no G key on a phone)
    hud.el.insertAdjacentHTML('beforeend', `<div class="h-agents interactive"><i class="link"></i>AGENTS<b>0</b><span class="need hidden"></span></div>`);
    this.chip = hud.el.querySelector('.h-agents');
    // the card for the agent you are at, at the kerb or in its beam: from up there its name tag is out of sight
    hud.el.insertAdjacentHTML('beforeend', `<div class="ag-card hidden"></div>`);
    this.card = hud.el.querySelector('.ag-card');
    this.cardKey = '';
    this.chip.addEventListener('pointerdown', (e) => { e.preventDefault(); this.toggleList(); });

    this.feed.onAgent = (a, info) => this.upsert(a, info);
    this.feed.onRemove = (id) => this.remove(id);
    this.feed.onConnection = (on) => { this.chip.classList.toggle('linked', on); this.listDirty = true; };
    this.feed.onSnapshot = () => this.term.resync();
    this.panel.onDrive = (id) => this.drive(id);
    this.panel.onWarp = (id) => this.warp(id);
    this.panel.onClose = () => this.close();
    this.term.onClose = () => this.close();

    // keys for our overlays are taken in the capture phase, before the game's own listener sees them
    addEventListener('keydown', (e) => this.key(e), true);
  }

  bind(game) { this.game = game; }

  get open() { const o = this.screens.open; return o === 'agents' || o === 'terminal' ? o : null; }

  // ---- data ----
  upsert(a, { notable, initial } = {}) {
    let e = this.entries.get(a.id);
    if (!e) {
      if (!this.free.length) return; // more agents than beacons: the newest wait until one leaves
      const place = this.placement.place(a);
      if (!place) return;
      e = { agent: a, place, slot: this.free.pop(), dist: 0 };
      this.entries.set(a.id, e);
      if (!initial && this.game?.state === 'play') this.hud.toast(`NEW AGENT · ${esc(a.name)}`, 'cyan');
    }
    e.agent = a;
    this.visuals.set(e.slot, e.place, a.status);
    this.labels.sync([...this.entries.values()]);
    if (this.term.id === a.id) this.term.header(a);
    if (notable && !initial) this.notify(a);
    this.listDirty = true;
    this.updateChip();
    this.pendingWarp();
  }

  remove(id) {
    const e = this.entries.get(id);
    if (!e) return;
    this.visuals.clear(e.slot);
    this.free.push(e.slot);
    this.placement.release(id);
    this.entries.delete(id);
    this.labels.sync([...this.entries.values()]);
    if (this.game?.waypointAgent === id) { this.game.waypoint = null; this.game.waypointAgent = null; }
    if (this.term.id === id) this.close();
    this.listDirty = true;
    this.updateChip();
  }

  updateChip() {
    let need = 0;
    for (const { agent } of this.entries.values()) if (agent.status === 'waiting' || agent.status === 'error') need++;
    this.chip.querySelector('b').textContent = this.entries.size;
    const n = this.chip.querySelector('.need');
    n.classList.toggle('hidden', !need);
    n.textContent = `${need} NEED${need === 1 ? 'S' : ''} YOU`;
  }

  notify(a) {
    if (this.game?.state === 'title') return;
    const now = performance.now();
    const key = `${a.id}|${a.status}`;
    if (now - (this.notes.get(key) || -1e9) < 20000) return;
    this.notes.set(key, now);
    const s = styleOf(a.status);
    this.hud.toast(`${s.en} · ${esc(a.name)}`, a.status === 'waiting' ? 'mag' : a.status === 'done' ? 'cyan' : '');
    // the radio is for the agents that are blocked on you
    if (a.status === 'waiting') this.hud.radio(`${esc(a.harness).toUpperCase()} · ${esc(a.name)}`, esc(a.last || 'Needs your input'));
    this.game?.sound?.ui?.();
  }

  // ---- overlays ----
  toggleList() {
    if (this.open === 'agents') return this.close();
    if (this.screens.open || this.game?.state !== 'play') return;
    this.screens.open = 'agents';
    this.panel.show(this.ranked(), this.feed.connected);
    this.listDirty = false;
    this.game?.sound?.ui?.();
  }

  openTerminal(id) {
    const e = this.entries.get(id);
    if (!e) return;
    this.panel.hide();
    this.screens.open = 'terminal';
    this.term.open(e.agent);
    this.game?.sound?.ui?.();
  }

  close() {
    if (!this.open) return;
    this.panel.hide();
    this.term.close();
    this.screens.open = null;
    this.game?.sound?.ui?.();
  }

  key(e) {
    const o = this.open;
    if (!o) return;
    // reading back in the terminal: held keys repeat
    const scroll = o === 'terminal' && { ArrowUp: -1, ArrowDown: 1, PageUp: -1, PageDown: 1, Home: -Infinity, End: Infinity }[e.code];
    if (scroll) {
      if (e.code.startsWith('Page')) this.term.page(scroll);
      else this.term.scroll(scroll);
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.repeat) return;
    let used = true;
    if (e.code === 'Escape' || (e.code === 'KeyG' && o === 'agents') || (e.code === 'Enter' && o === 'terminal')) this.close();
    else if (o === 'agents' && e.code === 'ArrowDown') this.panel.move(1);
    else if (o === 'agents' && e.code === 'ArrowUp') this.panel.move(-1);
    else if (o === 'agents' && e.code === 'Enter') { const id = this.panel.selected(); if (id) this.drive(id); }
    else if (o === 'agents' && e.code === 'KeyW') { const id = this.panel.selected(); if (id) this.warp(id); }
    else used = false;
    if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
  }

  drive(id) {
    const e = this.entries.get(id);
    if (!e || !this.game) return;
    // set directly: setWaypoint toggles off when the new point is near the old one
    this.game.waypoint = { x: e.place.dock.x, z: e.place.dock.z };
    this.game.waypointAgent = id;
    this.close();
    this.hud.toast(`WAYPOINT · ${esc(e.agent.name)}`, 'cyan');
  }

  warp(id) {
    const e = this.entries.get(id);
    if (!e || !this.game) return;
    const g = this.game, d = e.place.dock;
    // a few metres short of the ring (behind it along the street), inside the radius that brings up the prompt
    g.kite.place(d.x + Math.sin(d.yaw) * 4, 0, d.z + Math.cos(d.yaw) * 4, d.yaw);
    g.rig.yaw = d.yaw;
    g.rig.snap = true;
    g.waypoint = null;
    g.waypointAgent = null;
    this.close();
    this.hud.toast(`ARRIVED · ${esc(e.agent.name)}`, 'cyan');
  }

  // ?agent=<id> on the URL: warp there as soon as that agent shows up
  warpWhenSeen(id) { this.wantWarp = id; this.pendingWarp(); }
  pendingWarp() {
    if (!this.wantWarp || !this.game || this.game.state !== 'play') return;
    const e = this.entries.get(this.wantWarp) || [...this.entries.values()].find((x) => x.agent.id.includes(this.wantWarp) || x.agent.name.includes(this.wantWarp));
    if (!e) return;
    this.wantWarp = null;
    this.warp(e.agent.id);
  }

  // ---- per frame ----
  ranked() { return [...this.entries.values()]; }

  // the agent the car is at, if any: parked at its kerb ring (close to the road surface), or in its beam
  nearest(p) {
    let best = null, bd = Infinity;
    for (const e of this.entries.values()) {
      const d = e.place.dock, r = e.place.roof;
      const atDock = p.y < 6 ? Math.hypot(p.x - d.x, p.z - d.z) : Infinity;
      // offline agents show no beam
      const inBeam = e.agent.status !== 'offline' && p.y > r.y - 2 && p.y < r.y + BEAM_H ? Math.hypot(p.x - r.x, p.z - r.z) : Infinity;
      const m = Math.min(atDock < DOCK_R ? atDock : Infinity, inBeam < BEAM_R ? inBeam : Infinity);
      if (m < bd) { bd = m; best = e; }
    }
    return best;
  }

  renderCard(hidden) {
    const e = hidden ? null : this.near;
    if (!e) {
      if (this.cardKey) { this.card.classList.add('hidden'); this.cardKey = ''; }
      return;
    }
    const a = e.agent, s = styleOf(a.status), m = a.meta || {};
    const seen = ago(Date.now() - a.lastSeen);
    const key = `${a.id}|${a.status}|${a.name}|${a.last}|${m.task}|${m.cwd}|${m.model}|${seen}`;
    if (key === this.cardKey) return;
    this.cardKey = key;
    const rows = [m.task && ['TASK', m.task], m.cwd && ['CWD', m.cwd], m.model && ['MODEL', m.model], ['SEEN', `${seen} ago`]].filter(Boolean);
    this.card.style.setProperty('--c', s.css);
    this.card.classList.toggle('pulse', a.status === 'waiting');
    this.card.innerHTML = `<div class="hd"><span class="dot"></span><b>${esc(a.name)}</b><span class="st">${s.en}</span></div>
      <div class="sub">${esc(a.harness)} · ${esc(a.id)}</div>
      ${a.last ? `<div class="last">${esc(a.last)}</div>` : ''}
      <div class="rows">${rows.map(([k, v]) => `<span><i>${k}</i>${esc(v)}</span>`).join('')}</div>`;
    this.card.classList.remove('hidden');
  }

  update(camera, kite) {
    const p = kite.pos;
    for (const e of this.entries.values()) e.dist = Math.hypot(p.x - e.place.dock.x, p.z - e.place.dock.z);
    const hidden = !!this.screens.open || this.game?.state !== 'play' || this.inVR;
    this.labels.update(camera, this.entries.values(), hidden);
    this.renderCard(hidden);
    this.pad();
    if (this.open === 'agents' && this.listDirty) { this.panel.render(this.ranked(), this.feed.connected); this.listDirty = false; }
    if (this.game?.waypointAgent && !this.game.waypoint) this.game.waypointAgent = null;
    this.pendingWarp();
  }

  // a gamepad in the terminal (the car is parked meanwhile): either stick scrolls, faster the further it is pushed;
  // the d-pad steps a line, held to repeat; LB / RB a page; B closes. Standard mapping: 1 B, 4 LB, 5 RB, 12/13 d-pad.
  pad() {
    const now = performance.now(), dt = Math.min(0.1, (now - (this.padT || now)) / 1000);
    this.padT = now;
    const pads = this.open === 'terminal' && navigator.getGamepads ? navigator.getGamepads() : [];
    const prev = this.padPrev || (this.padPrev = {});
    for (const p of pads) {
      if (!p) continue;
      const btn = (i) => !!p.buttons[i]?.pressed;
      const edge = (i) => btn(i) && !prev[`${p.index}:${i}`];
      const y = [p.axes[1] || 0, p.axes[3] || 0].reduce((a, v) => (Math.abs(v) > Math.abs(a) ? v : a), 0);
      if (Math.abs(y) > 0.15) {
        this.padScroll = (this.padScroll || 0) + y * Math.abs(y) * 60 * dt;
        const n = Math.trunc(this.padScroll);
        if (n) { this.term.scroll(n); this.padScroll -= n; }
      } else this.padScroll = 0;
      const dir = btn(12) ? -1 : btn(13) ? 1 : 0;
      if (!dir) this.padRepeat = 0;
      else if (edge(12) || edge(13) || (this.padRepeat -= dt) <= 0) {
        this.term.scroll(dir);
        this.padRepeat = edge(12) || edge(13) ? 0.35 : 0.06;
      }
      if (edge(4)) this.term.page(-1);
      if (edge(5)) this.term.page(1);
      const close = edge(1);
      for (const i of [1, 4, 5, 12, 13]) prev[`${p.index}:${i}`] = btn(i);
      if (close) { this.close(); return; }
    }
  }

  // compass and minimap markers; the agent being driven to is pinned to the minimap rim
  markers(p, bearingOf) {
    const hud = [], map = [];
    for (const e of this.entries.values()) {
      const s = styleOf(e.agent.status), d = e.place.dock;
      const target = this.game?.waypointAgent === e.agent.id;
      map.push({ x: d.x, z: d.z, color: s.css, shape: 'dot', pin: target || e.agent.status === 'waiting' });
      if (target || e.agent.status === 'waiting' || e.dist < 500) hud.push({ bearing: bearingOf(d.x - p.x, d.z - p.z), color: s.css });
    }
    return { hud, map };
  }

  mapMarkers() {
    return [...this.entries.values()].map((e) => ({ x: e.place.dock.x, z: e.place.dock.z, color: styleOf(e.agent.status).css, shape: 'dot', label: e.agent.name }));
  }

  prompt(touch) {
    const e = this.near;
    if (!e) return null;
    const s = styleOf(e.agent.status);
    return `<span class="key">${touch ? 'TAP' : 'ENTER'}</span><span style="color:${s.css}">${s.en}</span> · OPEN TERMINAL · ${esc(e.agent.name)}`;
  }
}
