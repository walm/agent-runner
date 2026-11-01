// What the satnav (nav.js) shows in the world: chevrons on the road along the next stretch of the route, in the
// car's lane, and a small display floating ahead of the car with the next turn, how far it is, and where the route
// ends. On the screen the display is the same canvas in the DOM, pinned to that spot: drawn in the scene, the post
// chain's bloom would wash the neon behind over it. A headset has no post chain, so there it is a plane in the world.
import * as THREE from 'three/webgpu';
import { attribute, positionGeometry, vec3, float, fract, smoothstep } from 'three/tsl';
import { U } from '../core/shared.js';
import { LAYER_NOREFL } from '../city/ground.js';

const CAP = 32; // chevrons
const STEP = 6, FROM = 7; // metres apart, and the first one this far ahead of the car
const LANE = 3.4; // traffic keeps left: the chevrons run that far left of the street's middle
const CYAN = '#3be8ff', INK = 'rgba(232, 240, 255, 0.95)', DIM = 'rgba(190, 205, 235, 0.65)';
const FONT = "'Oxanium Variable', system-ui, sans-serif", MONO = "'JetBrains Mono Variable', ui-monospace, monospace";
const W = 640, H = 220;
const _v = new THREE.Vector3();

export class NavVisuals {
  // root: where the screen's display goes (the HUD, so it hides with it)
  constructor(root) {
    this.group = new THREE.Group();
    this.group.name = 'nav';

    // chevrons: one instanced mesh; per instance its place and direction (x, z, dx, dz) and (metres ahead, on)
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aS = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 2), 2).setUsage(THREE.DynamicDrawUsage);
    const shape = new THREE.Shape([[0.55, 0], [-0.45, 0.85], [-0.85, 0.85], [0.15, 0], [-0.85, -0.85], [-0.45, -0.85]].map(([x, y]) => new THREE.Vector2(x * 1.6, y * 1.6)));
    const src = new THREE.ShapeGeometry(shape);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = src.index;
    geo.setAttribute('position', src.attributes.position);
    geo.setAttribute('aC', this.aC);
    geo.setAttribute('aS', this.aS);
    geo.instanceCount = CAP;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    {
      const P = positionGeometry, c = attribute('aC', 'vec4'), s = attribute('aS', 'vec2');
      // the shape points along +x: turn it to the route's direction and lay it on the road
      mat.positionNode = vec3(c.x.add(c.z.mul(P.x)).sub(c.w.mul(P.y)), 0.13, c.y.add(c.w.mul(P.x)).add(c.z.mul(P.y)));
      // a wave of light running ahead along the route; fading in by the car and out at the far end
      const wave = smoothstep(0.55, 1, fract(s.x.div(30).sub(U.time.mul(1.1))));
      const fade = smoothstep(FROM - 2, FROM + 10, s.x).mul(smoothstep(FROM + STEP * CAP, FROM + STEP * (CAP - 8), s.x));
      mat.colorNode = vec3(0.23, 0.91, 1.0).mul(3);
      mat.opacityNode = s.y.mul(fade).mul(wave.mul(0.45).add(0.55));
    }
    this.chevrons = new THREE.Mesh(geo, mat);
    this.chevrons.frustumCulled = false;
    this.chevrons.layers.set(LAYER_NOREFL);
    this.chevrons.visible = false;
    this.group.add(this.chevrons);

    // the display: a canvas on a plane, facing the camera. See-through, a hologram over the street: a faint tint
    // and corner marks, the glyphs on a dark halo so the neon behind cannot wash them out
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    const pm = new THREE.MeshBasicNodeMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    pm.fog = false;
    this.panel = new THREE.Mesh(new THREE.PlaneGeometry(2.9, (2.9 * H) / W), pm);
    this.panel.renderOrder = 15;
    this.panel.frustumCulled = false;
    this.panel.layers.set(LAYER_NOREFL);
    this.panel.visible = false;
    this.group.add(this.panel);
    this.key = '';
    this.dom = document.createElement('div');
    this.dom.className = 'nav-hud hidden';
    this.dom.appendChild(this.canvas);
    root.appendChild(this.dom);
  }

  // nav: the satnav; kite: the car; view: the camera (or the headset's head); show: the game is being played;
  // xr: in a headset
  update(nav, kite, view, show, label, xr) {
    const m = show && nav.maneuver;
    this.chevrons.visible = !!m;
    this.panel.visible = !!m && xr;
    if (!m) { this.dom.classList.add('hidden'); return; }
    this.layChevrons(nav);
    // ahead of the car and above its roof, turned with its heading only, facing the camera
    const fx = -Math.sin(kite.yaw), fz = -Math.cos(kite.yaw);
    this.panel.position.set(kite.pos.x + fx * 5.5, kite.pos.y + 3.3, kite.pos.z + fz * 5.5);
    this.panel.quaternion.copy(view.quaternion);
    this.draw(m, label);
    // on the screen: the canvas itself, where that spot projects to
    _v.copy(this.panel.position).project(view);
    const on = !xr && _v.z < 1 && Math.abs(_v.x) < 1.1 && Math.abs(_v.y) < 1.1;
    this.dom.classList.toggle('hidden', !on);
    if (on) this.dom.style.transform = `translate(${((_v.x * 0.5 + 0.5) * innerWidth).toFixed(1)}px, ${((-_v.y * 0.5 + 0.5) * innerHeight).toFixed(1)}px) translate(-50%, -50%)`;
  }

  // the route ahead, moved into the left lane (corners and all: a corner moves by both legs' offsets), sampled
  layChevrons(nav) {
    const A = nav.ahead;
    const pts = A.map((p, k) => {
      let ox = 0, oz = 0;
      for (const [a, b] of [[A[k - 1], p], [p, A[k + 1]]]) {
        if (!a || !b) continue;
        const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
        if (l < 0.01) continue;
        // left of travel: heading +z keeps left at +x
        ox += (dz / l) * LANE; oz += (-dx / l) * LANE;
      }
      // a single leg (the ends) moves once; a corner gets both legs' offsets
      return { x: p.x + ox, z: p.z + oz };
    });
    const c = this.aC.array, s = this.aS.array;
    let n = 0, k = 0, at = 0, want = FROM;
    while (n < CAP && k < pts.length - 1) {
      const a = pts[k], b = pts[k + 1];
      const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
      if (l > 0.01 && want <= at + l) {
        const t = (want - at) / l;
        c.set([a.x + dx * t, a.z + dz * t, dx / l, dz / l], n * 4);
        s.set([want, 1], n * 2);
        n++;
        want += STEP;
        continue;
      }
      at += l;
      k++;
    }
    for (let i = n; i < CAP; i++) s[i * 2 + 1] = 0;
    this.aC.needsUpdate = this.aS.needsUpdate = true;
  }

  draw(m, label) {
    const dist = m.type === 'back' ? 0 : m.dist;
    const r = dist < 100 ? 5 : dist < 1000 ? 10 : 100;
    const key = `${m.type}|${Math.round(dist / r)}|${Math.round(m.total / 50)}|${label}`;
    if (key === this.key) return;
    this.key = key;
    const g = this.ctx;
    g.clearRect(0, 0, W, H);
    // a faint tint, darker toward the middle, and the corners of a frame
    const tint = g.createLinearGradient(0, 0, W, 0);
    tint.addColorStop(0, 'rgba(3, 6, 14, 0.5)');
    tint.addColorStop(0.7, 'rgba(3, 6, 14, 0.36)');
    tint.addColorStop(1, 'rgba(3, 6, 14, 0.1)');
    g.fillStyle = tint;
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(59, 232, 255, 0.7)';
    g.lineWidth = 3;
    const c = 26;
    for (const [x, y, sx, sy] of [[2, 2, 1, 1], [W - 2, 2, -1, 1], [2, H - 2, 1, -1], [W - 2, H - 2, -1, -1]]) {
      g.beginPath(); g.moveTo(x, y + sy * c); g.lineTo(x, y); g.lineTo(x + sx * c, y); g.stroke();
    }
    // every glyph from here on: a dark halo under it
    const halo = () => { g.shadowColor = 'rgba(0, 0, 0, 1)'; g.shadowBlur = 14; };
    // the icon
    g.save();
    g.translate(110, H / 2);
    g.strokeStyle = g.fillStyle = CYAN;
    halo();
    icon(g, m.type);
    g.shadowColor = CYAN;
    g.shadowBlur = 18;
    icon(g, m.type);
    g.restore();
    // what to do, and how far
    const what = { left: 'TURN LEFT', right: 'TURN RIGHT', back: 'TURN AROUND', arrive: 'ARRIVE' }[m.type];
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    halo();
    g.fillStyle = INK;
    g.font = `500 76px ${MONO}`;
    g.fillText(m.type === 'back' ? 'U-TURN' : fmt(dist), 220, 98);
    g.fillStyle = CYAN;
    g.font = `700 28px ${FONT}`;
    g.letterSpacing = '6px';
    g.fillText(what, 222, 140);
    // where the route ends, and how far that is
    g.fillStyle = DIM;
    g.font = `600 22px ${FONT}`;
    g.letterSpacing = '3px';
    let text = `${label} · ${fmt(m.total)}`;
    while (text.length > 4 && g.measureText(text).width > W - 250) text = text.slice(0, -2);
    g.fillText(text, 222, 184);
    g.letterSpacing = '0px';
    this.tex.needsUpdate = true;
  }
}

export function fmt(d) {
  return d < 1000 ? `${Math.round(d / (d < 100 ? 5 : 10)) * (d < 100 ? 5 : 10)} M` : `${(d / 1000).toFixed(1)} KM`;
}

// a satnav's maneuver arrows, about 150 px tall, centred on the origin
function icon(g, type) {
  g.lineWidth = 16;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const head = (x, y, ang) => {
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    g.beginPath(); g.moveTo(26, 0); g.lineTo(-14, -26); g.lineTo(-14, 26); g.closePath(); g.fill();
    g.restore();
  };
  if (type === 'left' || type === 'right') {
    const s = type === 'left' ? -1 : 1;
    g.beginPath(); g.moveTo(-s * 10, 66); g.lineTo(-s * 10, -6); g.quadraticCurveTo(-s * 10, -30, s * 14, -30); g.lineTo(s * 30, -30); g.stroke();
    head(s * 40, -30, type === 'left' ? Math.PI : 0);
  } else if (type === 'back') {
    g.beginPath(); g.moveTo(26, 66); g.lineTo(26, -16); g.arc(0, -16, 26, 0, Math.PI, true); g.lineTo(-26, 26); g.stroke();
    head(-26, 34, Math.PI / 2);
  } else {
    // arriving: a pin
    g.beginPath(); g.arc(0, -22, 32, Math.PI * 0.8, Math.PI * 2.2); g.lineTo(0, 58); g.closePath(); g.fill();
    g.fillStyle = '#05070f';
    g.shadowBlur = 0;
    g.beginPath(); g.arc(0, -22, 13, 0, Math.PI * 2); g.fill();
  }
}
