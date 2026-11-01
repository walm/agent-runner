// Agents' billboards on the city's LED screens. An agent posts a poster (an image it made for its task, or just a
// title and a caption: server POST /api/billboard), and the poster takes over one of the ad atlas's campaign
// slots (city/adscreens.js), so every screen that shows that campaign shows the agent's poster instead. Taken down,
// the slot gets its own campaign back. The whole image is always shown: fitted inside the cell over a blurred,
// darkened copy of itself, with the title, the caption and the agent's name.
import { paintAd, AD_SLOTS } from '../city/adscreens.js';

// the slots agents may borrow, the first taken first; the rest stay the city's own campaigns
const SLOTS = Array.from({ length: 8 }, (_, i) => AD_SLOTS - 1 - i);
const FONT = "'Oxanium Variable', 'Helvetica Neue', Arial, sans-serif";
const MONO = "'JetBrains Mono Variable', monospace";
const UPLOAD_GAP = 400; // ms between uploads of the 4096² atlas

export class AgentBillboards {
  // atlas: the ad screens' CanvasTexture; feed: for the image URLs; nameOf(id): an agent's display name
  constructor(atlas, feed, nameOf) {
    this.atlas = atlas;
    this.feed = feed;
    this.nameOf = nameOf;
    this.slots = new Map(); // agent id -> slot
    this.dirty = false;
    this.lastUpload = 0;
    this.pending = new Map(); // agent id -> version being loaded, so a stale load cannot paint over a newer one
  }

  async set(b) {
    this.pending.set(b.agent, b.v);
    const img = b.type ? await loadImage(this.feed.boardImage(b)) : null;
    if (this.pending.get(b.agent) !== b.v) return;
    this.pending.delete(b.agent);
    let slot = this.slots.get(b.agent);
    if (slot === undefined) {
      slot = SLOTS.find((s) => ![...this.slots.values()].includes(s));
      if (slot === undefined) {
        // all borrowed: the poster that went up first gives its slot over
        const [oldest] = [...this.slots.entries()].sort((x, y) => (this.feed.boards.get(x[0])?.v ?? 0) - (this.feed.boards.get(y[0])?.v ?? 0));
        this.slots.delete(oldest[0]);
        slot = oldest[1];
      }
      this.slots.set(b.agent, slot);
    }
    paintAd(this.atlas.image, slot, posterOf(img, b, this.nameOf(b.agent) || b.agent));
    this.dirty = true;
  }

  remove(id) {
    this.pending.delete(id);
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    this.slots.delete(id);
    paintAd(this.atlas.image, slot);
    this.dirty = true;
  }

  // per frame: one upload of the atlas for any number of changes, and not more often than UPLOAD_GAP
  update(now) {
    if (!this.dirty || now - this.lastUpload < UPLOAD_GAP) return;
    this.atlas.needsUpdate = true;
    this.dirty = false;
    this.lastUpload = now;
  }
}

// an image, or null when it cannot be had or cannot be drawn into a canvas the GPU may read
async function loadImage(url) {
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const probe = document.createElement('canvas');
    probe.width = probe.height = 4;
    const g = probe.getContext('2d');
    g.drawImage(img, 0, 0, 4, 4);
    g.getImageData(0, 0, 1, 1); // throws on a tainted canvas
    return img;
  } catch {
    return null;
  }
}

// a hue of its own per agent, for the posters that are only words
function hueOf(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

// words onto at most n lines of width w, shrinking the size until they fit
function fitLines(g, s, w, n, size, weight, font = FONT) {
  for (let sz = size; sz > 10; sz *= 0.9) {
    g.font = `${weight} ${sz}px ${font}`;
    const lines = [];
    let line = '';
    for (const word of s.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (g.measureText(next).width <= w || !line) line = next;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    if (lines.length <= n && lines.every((l) => g.measureText(l).width <= w)) return { lines, size: sz };
  }
  g.font = `${weight} 10px ${font}`;
  return { lines: [s], size: 10 };
}

function posterOf(img, b, name) {
  const title = (b.title || '').toUpperCase(), caption = b.caption || '';
  const hue = hueOf(b.agent);
  const accent = `hsl(${hue} 100% 62%)`;
  return (g, W, H, tall, s) => {
    // the picture's area, and the words' area: below it on a tall banner, beside it on a wide board
    const words = title || caption;
    const pic = img ? (tall ? { x: 0, y: 0, w: W, h: words ? H * 0.74 : H } : { x: 0, y: 0, w: words ? W * 0.6 : W, h: H }) : null;
    const txt = !pic ? { x: 0, y: 0, w: W, h: H } : tall ? { x: 0, y: pic.h, w: W, h: H - pic.h } : { x: pic.w, y: 0, w: W - pic.w, h: H };
    if (img) {
      const iw = img.naturalWidth || 1024, ih = img.naturalHeight || 1024;
      // behind: the image again, filling the cell, blurred and dark
      const cover = Math.max(W / iw, H / ih);
      g.save();
      g.filter = `blur(${Math.round(s * 0.04)}px) brightness(0.35) saturate(1.3)`;
      g.drawImage(img, (W - iw * cover) / 2, (H - ih * cover) / 2, iw * cover, ih * cover);
      g.restore();
      const fit = Math.min(pic.w / iw, pic.h / ih) * 0.94;
      g.drawImage(img, pic.x + (pic.w - iw * fit) / 2, pic.y + (pic.h - ih * fit) / 2, iw * fit, ih * fit);
    } else {
      // words only: a ground in the agent's own colour, a grid, a glow
      const bg = g.createLinearGradient(0, 0, W * 0.3, H);
      bg.addColorStop(0, `hsl(${hue} 70% 14%)`);
      bg.addColorStop(1, `hsl(${(hue + 40) % 360} 60% 4%)`);
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      g.strokeStyle = `hsla(${hue} 100% 70% / 0.12)`;
      g.lineWidth = Math.max(1, s * 0.004);
      for (let y = s * 0.08; y < H; y += s * 0.08) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      const glow = g.createRadialGradient(W * 0.5, H * 0.4, 0, W * 0.5, H * 0.4, s * 0.9);
      glow.addColorStop(0, `hsla(${hue} 100% 60% / 0.35)`);
      glow.addColorStop(1, `hsla(${hue} 100% 60% / 0)`);
      g.fillStyle = glow; g.fillRect(0, 0, W, H);
    }
    if (pic && words) {
      // a dark ground under the words where they sit over the blurred picture
      g.fillStyle = 'rgba(2, 4, 10, 0.55)';
      g.fillRect(txt.x, txt.y, txt.w, txt.h);
    }
    // the words: the title big, the caption under it, the agent's name at the foot
    const pad = s * 0.07, tw = txt.w - pad * 2;
    let y = txt.y + (pic ? pad * 0.9 : txt.h * (tall ? 0.22 : 0.18));
    g.textAlign = 'left';
    g.textBaseline = 'top';
    if (title) {
      const big = fitLines(g, title, tw, pic ? 2 : tall ? 4 : 2, s * (pic ? 0.13 : tall ? 0.24 : 0.2), 800);
      g.fillStyle = '#ffffff';
      g.shadowColor = accent; g.shadowBlur = s * 0.03;
      for (const l of big.lines) { g.fillText(l, txt.x + pad, y); y += big.size * 1.05; }
      g.shadowBlur = 0;
      y += s * 0.025;
    }
    if (caption) {
      const small = fitLines(g, caption, tw, pic ? (tall ? 2 : 3) : 3, s * (pic ? 0.055 : 0.07), 500);
      g.fillStyle = 'rgba(232, 240, 255, 0.85)';
      for (const l of small.lines) { g.fillText(l, txt.x + pad, y); y += small.size * 1.25; }
    }
    // the signature: whose poster this is
    g.textBaseline = 'alphabetic';
    const foot = txt.y + txt.h - pad * 0.8;
    g.fillStyle = accent;
    g.beginPath(); g.arc(txt.x + pad + s * 0.012, foot - s * 0.016, s * 0.012, 0, Math.PI * 2); g.fill();
    const sig = fitLines(g, name.toUpperCase(), tw - s * 0.05, 1, s * 0.04, 600, MONO);
    g.fillText(sig.lines[0], txt.x + pad + s * 0.04, foot);
    g.fillStyle = accent;
    g.fillRect(txt.x + pad, txt.y + (pic ? pad * 0.35 : pad), s * 0.12, Math.max(2, s * 0.008));
  };
}
