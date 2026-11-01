// Name tags for VR: the DOM tags (src/agents/labels.js) cannot show in a headset, so each agent gets a sprite over
// its roof with the same card drawn into a small canvas. Sprites grow with distance so far tags stay readable.
import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';
import { styleOf } from '../agents/visuals.js';

const RANGE = 380;
const W = 512, H = 128;

function draw(ctx, a) {
  const s = styleOf(a.status);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#05070f'; // opaque, as the panels (panels.js)
  ctx.fillRect(4, 4, W - 8, H - 30);
  ctx.strokeStyle = s.css + '99';
  ctx.lineWidth = 2;
  ctx.strokeRect(4, 4, W - 8, H - 30);
  ctx.fillStyle = s.css;
  ctx.fillRect(4, 4, 5, H - 30);
  ctx.fillRect(W / 2 - 1, H - 26, 2, 26);
  ctx.save();
  ctx.shadowColor = s.css;
  ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.arc(34, 38, 8, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(232, 240, 255, 0.95)';
  ctx.font = "500 32px 'Oxanium Variable', system-ui, sans-serif";
  let name = a.name;
  while (name.length > 1 && ctx.measureText(name).width > W - 80) name = name.slice(0, -1);
  ctx.fillText(name === a.name ? name : name + '…', 54, 49);
  ctx.fillStyle = s.css;
  ctx.font = "500 19px 'Oxanium Variable', system-ui, sans-serif";
  ctx.letterSpacing = '4px';
  ctx.fillText(`${a.harness} · ${s.en}`.toUpperCase(), 54, 82);
  ctx.letterSpacing = '0px';
}

export class VRTags {
  constructor() {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.tags = new Map(); // id -> { sprite, ctx, tex, key }
  }

  sync(entries) {
    const live = new Set();
    for (const { agent: a, place } of entries) {
      live.add(a.id);
      let t = this.tags.get(a.id);
      if (!t) {
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, toneMapped: false });
        mat.colorNode = texture(tex);
        mat.fog = false;
        const sprite = new THREE.Sprite(mat);
        sprite.center.set(0.5, 0);
        sprite.renderOrder = 10;
        this.group.add(sprite);
        t = { sprite, ctx: canvas.getContext('2d'), tex, key: '' };
        this.tags.set(a.id, t);
      }
      t.pulse = a.status === 'waiting';
      t.sprite.position.set(place.roof.x, place.roof.y + 6, place.roof.z);
      const key = `${a.name}|${a.harness}|${a.status}`;
      if (key !== t.key) { t.key = key; draw(t.ctx, a); t.tex.needsUpdate = true; }
    }
    for (const [id, t] of this.tags) {
      if (live.has(id)) continue;
      t.sprite.removeFromParent();
      t.sprite.material.dispose();
      t.tex.dispose();
      this.tags.delete(id);
    }
  }

  update(head, time) {
    for (const t of this.tags.values()) {
      const p = t.sprite.position;
      const d = Math.hypot(p.x - head.x, p.z - head.z);
      t.sprite.visible = d < RANGE;
      if (!t.sprite.visible) continue;
      // about the same angular size from 30 m out
      const w = Math.max(4, d * 0.12);
      t.sprite.scale.set(w, w / 4, 1);
      t.sprite.material.opacity = Math.min(1, (RANGE - d) / 90) * (t.pulse ? 0.65 + 0.35 * Math.sin(time * 6) : 1);
    }
  }
}
