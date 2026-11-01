// Keyboard, gamepad and touch merged into one set of axes and one-shot actions.
const KEYS = {
  throttle: [['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']],
  steer: [['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']],
  lift: [['Space'], ['KeyC']],
};
const ACTIONS = { KeyV: 'camera', KeyM: 'map', KeyH: 'help', KeyR: 'reset', Escape: 'pause', KeyF: 'horn', Enter: 'confirm', KeyN: 'next', KeyB: 'radio', KeyG: 'agents', KeyQ: 'quit', KeyP: 'autopilot' };
const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);
const NONE = { throttle: 0, steer: 0, lift: 0, boost: false };
// the gamepad's buttons, standard mapping (what each does is the game's to decide, by what is open: game.js)
export const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

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
    // the gamepad this frame, for the menus and the HUD: which buttons went down (edges), which are held, the sticks
    this.padEdges = new Set();
    this.padHeld = [];
    this.padAxes = [0, 0, 0, 0];
    this.padTrig = [0, 0]; // left and right trigger, 0..1
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
    this.padEdges.clear();
    const held = this.padHeld, axes = this.padAxes;
    held.length = 0;
    axes[0] = axes[1] = axes[2] = axes[3] = 0;
    this.padTrig[0] = this.padTrig[1] = 0;
    for (const p of pads) {
      if (!p) continue;
      const dz = (v) => (Math.abs(v) < 0.12 ? 0 : v);
      const rt = p.buttons[7]?.value || 0, lt = p.buttons[6]?.value || 0;
      const ax = dz(p.axes[0] || 0), ry = dz(p.axes[3] || 0);
      if (rt || lt || ax || ry) this.lastDevice = 'gamepad';
      this.padTrig[0] = this.padTrig[0] || lt; this.padTrig[1] = this.padTrig[1] || rt;
      throttle = throttle || rt - lt;
      steer = steer || ax;
      lift = lift || -ry;
      boost = boost || !!p.buttons[5]?.pressed || !!p.buttons[10]?.pressed;
      for (let b = 0; b < 16; b++) {
        const v = p.buttons[b]?.value || (p.buttons[b]?.pressed ? 1 : 0);
        const pressed = v > 0.5;
        if (pressed) { held[b] = true; this.lastDevice = 'gamepad'; }
        if (pressed && !this.padPrev[b]) this.padEdges.add(b);
        this.padPrev[b] = pressed;
      }
      for (let i = 0; i < 4; i++) axes[i] = axes[i] || dz(p.axes[i] || 0);
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
