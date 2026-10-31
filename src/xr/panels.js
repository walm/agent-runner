// In-world panels for VR. A headset shows none of the DOM, so the HUD essentials, the agents list and the terminal
// are drawn into canvases on planes that ride with the seat. A panel redraws only when what it shows has changed,
// and at most every `gap` seconds, so a speedometer does not upload a texture every frame.
import * as THREE from 'three/webgpu';
import { styleOf } from '../agents/visuals.js';
import { THEME, ago } from '../agents/terminal.js';

const DISPLAY = "'Oxanium Variable', system-ui, sans-serif";
const MONO = "'JetBrains Mono Variable', ui-monospace, Menlo, monospace";
const INK = 'rgba(232, 240, 255, 0.92)', DIM = 'rgba(190, 205, 235, 0.6)', FAINT = 'rgba(190, 205, 235, 0.32)';
const CYAN = '#3be8ff', MAG = '#ff3df2';
const strip = (s) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

class Panel {
  // w, h: canvas pixels; metres: the plane's width
  constructor(w, h, metres, gap = 0.1) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    // drawn over everything (the car's own bodywork included) and untouched by fog and tone mapping
    const mat = new THREE.MeshBasicNodeMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    mat.fog = false;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(metres, (metres * h) / w), mat);
    this.mesh.renderOrder = 20;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.gap = gap;
    this.key = null;
    this.at = -1e9;
  }

  get visible() { return this.mesh.visible; }

  show(on) {
    this.mesh.visible = on;
    if (!on) this.key = null;
  }

  paint(key, now, draw) {
    if (key === this.key || now - this.at < this.gap) return;
    this.key = key;
    this.at = now;
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    draw(ctx, canvas.width, canvas.height);
    this.tex.needsUpdate = true;
  }
}

// the DOM sheets' look: dark glass, a thin cyan edge, one corner cut
function sheet(ctx, w, h, edge = 'rgba(150, 225, 255, 0.35)', cut = 26) {
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(w - cut, 0); ctx.lineTo(w, cut); ctx.lineTo(w, h); ctx.lineTo(cut, h); ctx.lineTo(0, h - cut); ctx.closePath();
  // opaque: the scene is HDR until the final tone mapping, so a neon tube behind a translucent panel would still
  // blaze through it
  ctx.fillStyle = '#05070f';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = edge;
  ctx.stroke();
}

function text(ctx, s, x, y, { size = 24, font = DISPLAY, weight = 500, color = INK, align = 'left', spacing = 0, max } = {}) {
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = `${spacing}px`;
  let t = String(s);
  if (max && ctx.measureText(t).width > max) {
    while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
    t += '…';
  }
  ctx.fillText(t, x, y);
  ctx.letterSpacing = '0px';
}

function dot(ctx, x, y, r, color) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = r * 2.5;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ---------- the dash: speed, altitude, agents, the way to the waypoint, the prompt and the latest message ----------
export class Dash extends Panel {
  constructor() {
    super(1024, 300, 0.62, 0.1);
    this.toast = null; // { text, cls, until }
  }

  update(now, s) {
    const toast = this.toast && now < this.toast.until ? this.toast : null;
    const key = [Math.round(s.speed * 3.6), Math.round(s.alt), s.mode, s.agents, s.need, s.linked, s.target && `${s.target.name}|${Math.round(s.target.dist / 5)}|${Math.round(s.target.rel * 30)}|${s.target.color}`,
      s.prompt, toast && toast.text, s.view, s.fps].join('|');
    this.paint(key, now, (ctx, w, h) => {
      sheet(ctx, w, h);
      // speed and altitude
      text(ctx, Math.round(s.speed * 3.6), 40, 120, { size: 86, font: MONO, weight: 400 });
      text(ctx, 'KM/H', 44, 158, { size: 20, color: DIM, spacing: 5 });
      text(ctx, `${Math.round(s.alt)} M`, 44, 204, { size: 30, font: MONO, weight: 400, color: s.mode === 'air' ? CYAN : INK });
      text(ctx, s.mode === 'air' ? 'FLYING' : 'ROAD', 44, 236, { size: 18, color: DIM, spacing: 5 });
      // agents
      dot(ctx, w - 214, 62, 7, s.linked ? CYAN : '#6b7488');
      text(ctx, 'AGENTS', w - 196, 70, { size: 22, color: DIM, spacing: 6 });
      text(ctx, s.agents, w - 40, 72, { size: 40, font: MONO, weight: 400, align: 'right' });
      if (s.need) text(ctx, `${s.need} NEED${s.need === 1 ? 'S' : ''} YOU`, w - 40, 110, { size: 22, color: MAG, spacing: 5, align: 'right' });
      text(ctx, `${s.fps} FPS`, w - 40, 196, { size: 20, font: MONO, weight: 400, color: FAINT, align: 'right' });
      // the way to the waypoint: an arrow turned by its bearing relative to the car's heading
      if (s.target) {
        const cx = 400, cy = 116;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(s.target.rel);
        ctx.fillStyle = s.target.color;
        ctx.shadowColor = s.target.color;
        ctx.shadowBlur = 16;
        ctx.beginPath(); ctx.moveTo(0, -44); ctx.lineTo(30, 30); ctx.lineTo(0, 14); ctx.lineTo(-30, 30); ctx.closePath(); ctx.fill();
        ctx.restore();
        text(ctx, s.target.name, 470, 104, { size: 30, max: 300 });
        const d = s.target.dist;
        text(ctx, d < 1000 ? `${Math.round(d)} M` : `${(d / 1000).toFixed(1)} KM`, 470, 142, { size: 24, font: MONO, weight: 400, color: s.target.color });
      }
      // bottom line: what A does here, else the latest message, else the controls
      ctx.fillStyle = 'rgba(150, 225, 255, 0.14)';
      ctx.fillRect(28, 222 + 0, w - 56, 2);
      const line = s.prompt || (toast && toast.text) || `X AGENTS   ·   Y ${s.view === 'seat' ? 'CHASE VIEW' : 'SEAT VIEW'}   ·   GRIP BOOST`;
      const color = s.prompt ? CYAN : toast ? (toast.cls.includes('mag') ? MAG : toast.cls.includes('cyan') ? CYAN : INK) : FAINT;
      text(ctx, line, w / 2 + 60, 268, { size: 24, color, align: 'center', spacing: 2, max: w - 260 });
    });
  }

  message(text, cls) {
    this.toast = { text: strip(text), cls: cls || '', until: performance.now() / 1000 + 3.5 };
    this.key = null;
  }
}

// ---------- the agents list ----------
const ROWS = 7;
export class ListPanel extends Panel {
  constructor() { super(1024, 760, 1.15, 0.2); }

  // order: ids as the DOM list ranked them; sel: the chosen index
  update(now, { order, sel, entries, connected }) {
    const first = Math.max(0, Math.min(sel - Math.floor(ROWS / 2), order.length - ROWS));
    const shown = order.slice(first, first + ROWS).map((id) => entries.get(id)).filter(Boolean);
    const key = [sel, first, connected, ...shown.map((e) => `${e.agent.id}|${e.agent.status}|${e.agent.last}|${Math.round(e.dist / 10)}`)].join('|');
    this.paint(key, now, (ctx, w, h) => {
      sheet(ctx, w, h);
      text(ctx, 'AGENTS IN THE CITY', 44, 70, { size: 34, spacing: 8 });
      text(ctx, `${order.length}`, w - 44, 70, { size: 34, font: MONO, weight: 400, align: 'right', color: DIM });
      if (!order.length) {
        text(ctx, 'No agents have reported in yet.', 44, 150, { size: 26, color: DIM });
      }
      const top = 100, rh = 80;
      shown.forEach((e, i) => {
        const a = e.agent, s = styleOf(a.status), y = top + i * rh, on = first + i === sel;
        ctx.fillStyle = on ? 'rgba(59, 232, 255, 0.12)' : 'rgba(12, 16, 30, 0.7)';
        ctx.fillRect(36, y, w - 72, rh - 10);
        ctx.fillStyle = s.css;
        ctx.fillRect(36, y, 4, rh - 10);
        if (on) { ctx.strokeStyle = CYAN; ctx.lineWidth = 2; ctx.strokeRect(36, y, w - 72, rh - 10); }
        dot(ctx, 66, y + 35, 7, s.css);
        text(ctx, a.name, 90, y + 33, { size: 26, max: 560 });
        text(ctx, `${a.harness} · ${a.last || '—'}`, 90, y + 59, { size: 18, font: MONO, weight: 400, color: DIM, max: 600 });
        text(ctx, s.en, w - 56, y + 33, { size: 20, color: s.css, align: 'right', spacing: 4 });
        const d = e.dist;
        text(ctx, d < 1000 ? `${Math.round(d)} M` : `${(d / 1000).toFixed(1)} KM`, w - 56, y + 59, { size: 18, font: MONO, weight: 400, color: FAINT, align: 'right' });
      });
      ctx.fillStyle = 'rgba(150, 225, 255, 0.14)';
      ctx.fillRect(36, h - 78, w - 72, 2);
      dot(ctx, 52, h - 38, 6, connected ? CYAN : '#ff4a5a');
      text(ctx, connected ? 'LINKED' : 'NO LINK', 68, h - 30, { size: 18, color: DIM, spacing: 4 });
      text(ctx, 'STICK  CHOOSE   ·   A  DRIVE   ·   TRIGGER  WARP   ·   B  CLOSE', w - 44, h - 30, { size: 19, color: DIM, align: 'right', spacing: 2 });
    });
  }
}

// ---------- the terminal: the xterm buffer the DOM terminal holds, cell by cell ----------
const CUBE = [0, 95, 135, 175, 215, 255];
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'].map((k) => THEME[k]);
function palette(i) {
  if (i < 16) return ANSI[i];
  if (i < 232) { const c = i - 16; return `rgb(${CUBE[Math.floor(c / 36)]},${CUBE[Math.floor(c / 6) % 6]},${CUBE[c % 6]})`; }
  const g = 8 + (i - 232) * 10;
  return `rgb(${g},${g},${g})`;
}
const rgb = (n) => `#${n.toString(16).padStart(6, '0')}`;
function fgOf(c) { return c.isFgRGB() ? rgb(c.getFgColor()) : c.isFgPalette() ? palette(c.getFgColor()) : THEME.foreground; }
function bgOf(c) { return c.isBgRGB() ? rgb(c.getBgColor()) : c.isBgPalette() ? palette(c.getBgColor()) : null; }

export const TERM_SIZE = [96, 30];
const FS = 23, LH = 26, HEAD = 150, PAD = 44;

export class TermPanel extends Panel {
  constructor() {
    super(1536, 1024, 1.75, 1 / 15);
    this.ver = 0;
    this.hooked = null;
  }

  // view: the DOM TerminalView, whose xterm holds the buffer and the scroll position
  update(now, view, agent) {
    const term = view.term;
    if (!term || !agent) return;
    if (this.hooked !== term) {
      this.hooked = term;
      term.onWriteParsed(() => this.ver++);
      term.onScroll(() => this.ver++);
    }
    const b = term.buffer.active, s = styleOf(agent.status), m = agent.meta || {};
    const key = [this.ver, b.viewportY, agent.id, agent.status, agent.last, m.task, Math.floor(Date.now() / 10000)].join('|');
    this.paint(key, now, (ctx, w, h) => {
      sheet(ctx, w, h, s.css + '88', 30);
      // header: who, where, how long
      const grad = ctx.createLinearGradient(0, 0, w * 0.6, 0);
      grad.addColorStop(0, s.css + '22'); grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.fillRect(3, 3, w * 0.6, 92);
      dot(ctx, PAD + 6, 46, 8, s.css);
      text(ctx, agent.name, PAD + 30, 56, { size: 34, max: 900 });
      text(ctx, s.en, w - PAD, 56, { size: 24, color: s.css, align: 'right', spacing: 6 });
      text(ctx, `${agent.harness} · ${agent.id}`, PAD + 30, 86, { size: 18, font: MONO, weight: 400, color: FAINT, max: 1100 });
      const bits = [m.task && `TASK ${m.task}`, m.cwd && `CWD ${m.cwd}`, m.model && `MODEL ${m.model}`, `UP ${ago(Date.now() - agent.firstSeen)}`].filter(Boolean).join('    ');
      text(ctx, bits, PAD, 128, { size: 19, font: MONO, weight: 400, color: INK, max: w - PAD * 2 });
      ctx.fillStyle = 'rgba(150, 225, 255, 0.14)';
      ctx.fillRect(PAD, 144, w - PAD * 2, 2);
      // body
      ctx.font = `400 ${FS}px ${MONO}`;
      const cw = ctx.measureText('M').width;
      const cell = b.getNullCell();
      ctx.textBaseline = 'alphabetic';
      for (let y = 0; y < term.rows; y++) {
        const line = b.getLine(b.viewportY + y);
        if (!line) continue;
        const py = HEAD + 18 + y * LH;
        let run = '', runX = 0, runFg = null, runBold = false, runDim = false;
        const flush = () => {
          if (!run.trim()) { run = ''; return; }
          ctx.font = `${runBold ? 700 : 400} ${FS}px ${MONO}`;
          ctx.globalAlpha = runDim ? 0.55 : 1;
          ctx.fillStyle = runFg;
          ctx.fillText(run, PAD + runX * cw, py + FS);
          ctx.globalAlpha = 1;
          run = '';
        };
        for (let x = 0; x < term.cols; x++) {
          if (!line.getCell(x, cell) || cell.getWidth() === 0) continue;
          let fg = fgOf(cell), bg = bgOf(cell);
          if (cell.isInverse()) { const f = fg; fg = bg || THEME.background; bg = f; }
          if (bg) { ctx.fillStyle = bg; ctx.fillRect(PAD + x * cw, py + 2, cw * cell.getWidth(), LH); }
          const bold = !!cell.isBold(), dim = !!cell.isDim();
          if (fg !== runFg || bold !== runBold || dim !== runDim) { flush(); runFg = fg; runBold = bold; runDim = dim; runX = x; }
          if (!run) runX = x;
          run += cell.isInvisible() ? ' ' : cell.getChars() || ' ';
        }
        flush();
      }
      // footer
      const back = b.baseY - b.viewportY;
      text(ctx, back > 0 ? `↑ ${back} LINES BACK` : '● LIVE', PAD, h - 26, { size: 18, color: back > 0 ? DIM : s.css, spacing: 5 });
      text(ctx, 'RIGHT STICK  SCROLL   ·   A / B  CLOSE', w - PAD, h - 26, { size: 18, color: FAINT, align: 'right', spacing: 4 });
    });
  }
}

// ---------- a one-line notice: shown alone while the city's shaders build for the headset ----------
export class Notice extends Panel {
  constructor() { super(1024, 200, 1.1, 0); }

  set(title, sub) {
    this.paint(`${title}|${sub}`, 0, (ctx, w, h) => {
      sheet(ctx, w, h);
      text(ctx, title, w / 2, 92, { size: 40, align: 'center', spacing: 10 });
      text(ctx, sub, w / 2, 146, { size: 22, color: DIM, align: 'center', spacing: 4 });
    });
  }
}
