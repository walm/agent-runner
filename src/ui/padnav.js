// A gamepad in the menus. The title, the pause sheet and the results are DOM, laid out for a pointer; here the
// d-pad or the left stick moves a highlight between the things that can be clicked (nearest in the direction
// pushed), A clicks the highlighted one, left and right move a slider, LB and RB step the tabs, and the highlight
// survives the sheet being drawn again (the settings redraw on every change).
import { PAD } from '../core/input.js';

const ITEMS = 'button, [data-act], input[type=range]';
const FIRST = 0.4, REPEAT = 0.12; // seconds before a held direction repeats, and between repeats

export class PadNav {
  constructor() {
    this.el = null; // the highlighted element
    this.key = ''; // what it was, to find it again after a redraw
    this.scope = null;
    this.hold = null; // the direction held, and its repeat timer
    this.repeat = 0;
  }

  get focused() { return !!this.el?.isConnected; }

  // what is clickable in scope now, in document order
  items(scope) {
    const out = [];
    for (const el of scope.querySelectorAll(ITEMS)) {
      if (el.disabled || el.tagName === 'A' || !el.getClientRects().length) continue;
      if (el.closest('[data-act]') !== el && el.tagName !== 'INPUT' && el.closest('[data-act]')) continue; // inside a clickable row
      out.push(el);
    }
    return out;
  }

  keyOf(el) {
    const d = el.dataset;
    return [el.tagName, d.act, d.k, d.v, d.i, d.id, d.mode, el.textContent.trim().slice(0, 40)].join('|');
  }

  set(el) {
    if (this.el && this.el !== el) this.el.classList.remove('pad-sel');
    this.el = el;
    this.key = el ? this.keyOf(el) : '';
    if (el) { el.classList.add('pad-sel'); el.scrollIntoView?.({ block: 'nearest' }); }
  }

  clear() { this.set(null); this.scope = null; }

  // the nearest item from the highlighted one in direction (dx, dy): a little way along it, little to the side
  move(scope, dx, dy) {
    const list = this.items(scope);
    if (!list.length) return;
    if (!this.focused || !list.includes(this.el)) { this.set(list[0]); return; }
    const r = this.el.getBoundingClientRect(), cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    let best = null, bs = Infinity;
    for (const el of list) {
      if (el === this.el) continue;
      const q = el.getBoundingClientRect(), qx = (q.left + q.right) / 2, qy = (q.top + q.bottom) / 2;
      // along: the gap between the edges facing each other, so a wide row and a narrow button rank alike
      const along = dx ? (dx > 0 ? q.left - r.right : r.left - q.right) : dy > 0 ? q.top - r.bottom : r.top - q.bottom;
      const side = dx ? Math.abs(qy - cy) : Math.abs(qx - cx);
      if (along < -4) continue;
      // sideways on the same row first; between rows, the one closest to straight ahead
      const s = along + side * (dx ? 2 : 0.6);
      if (s < bs) { bs = s; best = el; }
    }
    // nothing that way (a single row of buttons, say): up and down step through the list in order instead
    if (!best && dy) { const i = list.indexOf(this.el) + dy; if (i >= 0 && i < list.length) best = list[i]; }
    if (best) this.set(best);
  }

  // scope: the open sheet; pad: the input's edges, held buttons and sticks. Returns true when A clicked something
  update(scope, input, dt) {
    if (scope !== this.scope) { this.clear(); this.scope = scope; }
    // the sheet was drawn again: the same item, found by what it was
    if (this.el && !this.el.isConnected) {
      const again = this.items(scope).find((el) => this.keyOf(el) === this.key);
      this.el = null;
      if (again) this.set(again);
    }
    const edges = input.padEdges, held = input.padHeld, axes = input.padAxes;
    const sx = Math.abs(axes[0]) > 0.5 ? Math.sign(axes[0]) : 0, sy = Math.abs(axes[1]) > 0.5 ? Math.sign(axes[1]) : 0;
    const dx = held[PAD.RIGHT] ? 1 : held[PAD.LEFT] ? -1 : sx, dy = held[PAD.DOWN] ? 1 : held[PAD.UP] ? -1 : sy;
    const dir = dx || dy ? `${dx},${dy}` : null;
    let step = false;
    if (!dir) this.hold = null;
    else if (dir !== this.hold) { this.hold = dir; this.repeat = FIRST; step = true; }
    else if ((this.repeat -= dt) <= 0) { this.repeat = REPEAT; step = true; }
    if (step) {
      const range = this.focused && this.el.type === 'range';
      if (range && dx) this.slide(this.el, dx);
      else this.move(scope, dx, dy);
    }
    // the tabs
    if (edges.has(PAD.LB) || edges.has(PAD.RB)) {
      const tabs = [...scope.querySelectorAll('.tabs .btn')];
      const i = tabs.findIndex((t) => t.classList.contains('sel'));
      const n = tabs.length;
      if (n) tabs[((i < 0 ? 0 : i) + (edges.has(PAD.RB) ? 1 : n - 1)) % n].click();
    }
    if (edges.has(PAD.A) && this.focused) {
      if (this.el.type !== 'range') this.el.click();
      return true;
    }
    return false;
  }

  // a slider one step along, as a drag would
  slide(inp, d) {
    const step = +inp.step || 1, min = +inp.min, max = +inp.max;
    const v = Math.min(max, Math.max(min, +(+inp.value + d * step).toFixed(6)));
    if (v === +inp.value) return;
    inp.value = v;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
