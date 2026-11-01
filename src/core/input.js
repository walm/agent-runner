// Keyboard, gamepad and touch merged into one set of axes and one-shot actions.
const KEYS = {
  throttle: [['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']],
  steer: [['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']],
  lift: [['Space'], ['KeyC']],
};
const ACTIONS = { KeyV: 'camera', KeyM: 'map', KeyH: 'help', KeyR: 'reset', Escape: 'pause', KeyF: 'horn', Enter: 'confirm', KeyN: 'next', KeyB: 'radio', KeyG: 'agents', KeyQ: 'quit', KeyP: 'autopilot' };
const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);
// standard gamepad mapping: Y camera, back map, start pause, d-pad up next track, X horn, right stick press autopilot
const PAD_ACTIONS = [[3, 'camera'], [8, 'map'], [9, 'pause'], [12, 'next'], [2, 'horn'], [11, 'autopilot']];
const NONE = { throttle: 0, steer: 0, lift: 0, boost: false };

// a key pressed while typing in a field (a settings slider, say) belongs to the field, not to the car
const inField = (e) => { const t = e.target; return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); };

export class Input {
  constructor() {
    this.down = new Set();
    this.queue = [];
    this.touch = { throttle: 0, steer: 0, lift: 0, boost: false };
    this.xr = { throttle: 0, steer: 0, lift: 0, boost: false }; // the Touch controllers, written by src/xr/vr.js
    this.enabled = true;
    this.lastDevice = 'keyboard';
    addEventListener('keydown', (e) => {
      if (inField(e) && e.code !== 'Escape') return;
      if (PREVENT.has(e.code)) e.preventDefault(); // held keys repeat, and must not scroll either
      if (e.repeat) return;
      // a browser or system shortcut (reload, minimise, find) is not a driving key
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      this.down.add(e.code);
      this.lastDevice = 'keyboard';
      const a = ACTIONS[e.code];
      if (a) this.queue.push(a);
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    // the key-up is lost when the page goes behind another window or tab: nothing stays pressed
    addEventListener('blur', () => this.down.clear());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.down.clear(); });
    this.padPrev = [];
  }

  axis(name) {
    const [pos, neg] = KEYS[name];
    return (pos.some((k) => this.down.has(k)) ? 1 : 0) - (neg.some((k) => this.down.has(k)) ? 1 : 0);
  }

  // returns the merged control state for this frame
  poll() {
    let throttle = this.axis('throttle'), steer = this.axis('steer'), lift = this.axis('lift');
    let boost = this.down.has('ShiftLeft') || this.down.has('ShiftRight');
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const dz = (v) => (Math.abs(v) < 0.12 ? 0 : v);
      const rt = p.buttons[7]?.value || 0, lt = p.buttons[6]?.value || 0;
      const ax = dz(p.axes[0] || 0), ry = dz(p.axes[3] || 0);
      if (rt || lt || ax || ry) this.lastDevice = 'gamepad';
      throttle = throttle || rt - lt;
      steer = steer || ax;
      lift = lift || -ry || (p.buttons[0]?.pressed ? 1 : 0) - (p.buttons[1]?.pressed ? 1 : 0);
      boost = boost || !!p.buttons[5]?.pressed || !!p.buttons[10]?.pressed;
      for (const [b, a] of PAD_ACTIONS) {
        const pressed = !!p.buttons[b]?.pressed;
        if (pressed && !this.padPrev[b]) this.queue.push(a);
        this.padPrev[b] = pressed;
      }
    }
    for (const t of [this.touch, this.xr]) {
      throttle = throttle || t.throttle;
      steer = steer || t.steer;
      lift = lift || t.lift;
      boost = boost || t.boost;
    }
    if (!this.enabled) return NONE;
    return { throttle, steer, lift, boost };
  }

  take() {
    const q = this.queue;
    this.queue = [];
    return q;
  }
}
