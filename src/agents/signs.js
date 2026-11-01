// A neon sign with the agent's name standing on the roof of its building, at the street edge, lit in its status
// colour (and pulsing when it needs you, like the beam): above the street's own blade signs, and readable from
// across the city and from the air. One instanced mesh for every agent, built before the
// warm-up. The canvas holds the lettering only as masks, the name in red and the sign's dark plate in green, so a
// status change writes three floats and never repaints the texture: the colour is the shader's.
import * as THREE from 'three/webgpu';
import { attribute, positionGeometry, vec2, vec3, float, sin, mix, texture, cos } from 'three/tsl';
import { U } from '../core/shared.js';
import { CAP, styleOf } from './visuals.js';

const CW = 512, CH = 128, COLS = 4, ROWS = CAP / COLS; // one cell per beacon slot
const NORM = [[-1, 0], [1, 0], [0, -1], [0, 1]]; // street faces, as placement.js
const FONT = "'Oxanium Variable', 'Helvetica Neue', Arial, sans-serif";
const MONO = "'JetBrains Mono Variable', monospace";

export class AgentSigns {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CW * COLS;
    this.canvas.height = CH * ROWS;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.anisotropy = 8;
    this.names = new Array(CAP).fill(null);
    this.dirty = false;

    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage); // x, y, z, yaw
    this.aQ = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage); // w, h, cell, on
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage); // r, g, b, pulse
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    geo.setAttribute('aP', this.aP);
    geo.setAttribute('aQ', this.aQ);
    geo.setAttribute('aC', this.aC);
    geo.instanceCount = CAP; // unused slots are off
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    {
      const P = positionGeometry, p = attribute('aP', 'vec4'), q = attribute('aQ', 'vec4'), c = attribute('aC', 'vec4');
      // the quad faces +z: turn it to face out of the wall
      const lx = P.x.mul(q.x), ly = P.y.mul(q.y), cy = cos(p.w), sy = sin(p.w);
      m.positionNode = vec3(lx.mul(cy).add(p.x), ly.add(p.y), lx.mul(sy).negate().add(p.z));
      const col = q.z.mod(COLS), row = q.z.div(COLS).floor();
      const uv = vec2(col.add(P.x.add(0.5)).div(COLS), float(1).sub(row.add(1).div(ROWS)).add(P.y.add(0.5).div(ROWS)));
      const s = texture(this.tex, uv);
      const pulse = sin(U.time.mul(c.w).mul(Math.PI)).mul(0.5).add(0.5).mul(c.w.min(1)).oneMinus().mul(0.6).add(0.4);
      const tube = c.xyz.mul(s.r).mul(pulse).mul(3.4);
      m.colorNode = mix(vec3(0.006, 0.007, 0.012), tube, s.r.min(1));
      m.opacityNode = s.r.max(s.g.mul(0.88)).mul(q.w);
    }
    this.mesh = new THREE.Mesh(geo, m);
    this.mesh.name = 'agent-signs';
    this.mesh.frustumCulled = false;
  }

  // slot i: the agent's building and its status; the lettering is repainted only when the name changes
  set(i, place, a) {
    const b = place.building;
    const [nx, nz] = NORM[b.streetFace];
    // the roof it stands on: the top tier (a tower may step back), else the footprint
    const top = b.tiers?.find((t) => !t.feat && !t.mast && t.y1 >= b.h - 0.01) || { x: b.x, z: b.z, w: b.w, d: b.d };
    const faceW = nx ? top.d : top.w;
    // bigger on a tower, so it reads from as far off as the tower is seen
    const w = Math.min(faceW * 0.9, Math.max(10, Math.min(26, b.h * 0.22))), h = w / 4;
    // just inside the street edge of the roof, standing a little clear of it
    const fx = top.x + nx * (top.w / 2 - 0.6), fz = top.z + nz * (top.d / 2 - 0.6);
    this.aP.array.set([fx, b.h + h / 2 + 0.6, fz, Math.atan2(nx, nz)], i * 4);
    this.aQ.array.set([w, h, i, a.status === 'offline' ? 0.35 : 1], i * 4);
    const st = styleOf(a.status);
    this.aC.array.set([...st.rgb, st.pulse], i * 4);
    this.aP.needsUpdate = this.aQ.needsUpdate = this.aC.needsUpdate = true;
    const key = `${a.name}|${a.harness}`;
    if (this.names[i] !== key) { this.names[i] = key; this.paint(i, a); }
  }

  clear(i) {
    this.aQ.array[i * 4 + 3] = 0;
    this.aQ.needsUpdate = true;
    this.names[i] = null;
  }

  paint(i, a) {
    const g = this.ctx, x = (i % COLS) * CW, y = Math.floor(i / COLS) * CH;
    g.save();
    g.beginPath(); g.rect(x, y, CW, CH); g.clip();
    g.clearRect(x, y, CW, CH);
    g.translate(x, y);
    // the plate (green), then the tubes over it (red): a frame, the name, the harness
    g.fillStyle = '#00ff00';
    g.beginPath(); g.roundRect(4, 4, CW - 8, CH - 8, 18); g.fill();
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = 'rgb(200, 0, 0)';
    g.lineWidth = 4;
    g.shadowColor = 'rgb(255, 0, 0)';
    g.shadowBlur = 10;
    g.beginPath(); g.roundRect(12, 12, CW - 24, CH - 24, 12); g.stroke();
    const name = a.name.toUpperCase();
    let size = 54;
    g.font = `700 ${size}px ${FONT}`;
    while (size > 18 && g.measureText(name).width > CW - 60) { size -= 2; g.font = `700 ${size}px ${FONT}`; }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgb(255, 0, 0)';
    g.shadowBlur = 14;
    g.fillText(name, CW / 2, CH * 0.44);
    g.font = `500 18px ${MONO}`;
    g.fillStyle = 'rgb(140, 0, 0)';
    g.shadowBlur = 6;
    if ('letterSpacing' in g) g.letterSpacing = '5px';
    g.fillText(a.harness.toUpperCase(), CW / 2, CH * 0.76);
    if ('letterSpacing' in g) g.letterSpacing = '0px';
    g.restore();
    this.dirty = true;
  }

  // per frame: one upload for any number of repainted names
  update() {
    if (!this.dirty) return;
    this.tex.needsUpdate = true;
    this.dirty = false;
  }
}
