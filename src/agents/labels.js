// Name tags over agent buildings: DOM elements projected from the roof each frame. Crisp at any size, no textures,
// and cheap for the few dozen agents a city holds. Only agents within RANGE and in front of the camera show.
import * as THREE from 'three/webgpu';
import { styleOf } from './visuals.js';

const RANGE = 380;
const v = new THREE.Vector3();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class AgentLabels {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.className = 'ag-labels';
    // under the HUD, so a tag never covers the compass or the counters
    root.insertBefore(this.el, root.querySelector('#hud'));
    this.tags = new Map(); // id -> { el, key }
  }

  sync(entries) {
    // entries: [{ agent, place }]
    const live = new Set();
    for (const { agent: a } of entries) {
      live.add(a.id);
      let t = this.tags.get(a.id);
      if (!t) {
        t = { el: document.createElement('div'), key: '' };
        t.el.className = 'ag-tag';
        this.el.appendChild(t.el);
        this.tags.set(a.id, t);
      }
      const s = styleOf(a.status);
      const key = `${a.name}|${a.harness}|${a.status}`;
      if (key !== t.key) {
        t.key = key;
        t.el.style.setProperty('--c', s.css);
        t.el.classList.toggle('pulse', a.status === 'waiting');
        t.el.innerHTML = `<span class="dot"></span><b>${esc(a.name)}</b><span class="meta">${esc(a.harness)} · ${s.en}</span>`;
      }
    }
    for (const [id, t] of this.tags) if (!live.has(id)) { t.el.remove(); this.tags.delete(id); }
  }

  update(camera, entries, hidden) {
    this.el.classList.toggle('off', !!hidden);
    if (hidden) return;
    const W = window.innerWidth, H = window.innerHeight;
    for (const { agent: a, place } of entries) {
      const t = this.tags.get(a.id);
      if (!t) continue;
      const r = place.roof;
      const d = Math.hypot(r.x - camera.position.x, r.z - camera.position.z);
      v.set(r.x, r.y + 6, r.z).project(camera);
      const show = d < RANGE && v.z < 1 && v.x > -1.2 && v.x < 1.2 && v.y > -1.2 && v.y < 1.2;
      if (!show) { if (t.shown !== false) { t.el.style.display = 'none'; t.shown = false; } continue; }
      if (t.shown !== true) { t.el.style.display = ''; t.shown = true; }
      const x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
      const scale = THREE.MathUtils.clamp(1.15 - d / RANGE, 0.55, 1);
      t.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
      t.el.style.opacity = THREE.MathUtils.clamp((RANGE - d) / 90, 0, 1).toFixed(2);
      t.el.style.zIndex = String(1000 - Math.round(d));
    }
  }
}
