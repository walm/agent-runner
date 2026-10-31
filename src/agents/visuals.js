// Agent beacons: a shaft of light rising from each agent's roof, coloured by status, and a ring on the road at the
// kerb where you pull up. Allocated for CAP agents up front and built before the warm-up, so a new agent only
// writes attributes: no pipeline is ever compiled mid-flight.
import * as THREE from 'three/webgpu';
import { attribute, positionGeometry, vec2, vec3, float, mix, abs, smoothstep, sin, fract, atan, length, cameraPosition } from 'three/tsl';
import { U } from '../core/shared.js';
import { LAYER_NOREFL } from '../city/ground.js';

export const CAP = 128;

// rgb, pulse rate
export const STATUS_STYLE = {
  working: { css: '#3be8ff', rgb: [0.23, 0.91, 1.0], pulse: 0.6, en: 'WORKING' },
  idle: { css: '#ffb547', rgb: [1.0, 0.62, 0.18], pulse: 0.0, en: 'IDLE' },
  waiting: { css: '#ff3df2', rgb: [1.0, 0.24, 0.95], pulse: 4.0, en: 'NEEDS YOU' },
  error: { css: '#ff4a5a', rgb: [1.0, 0.18, 0.22], pulse: 2.5, en: 'ERROR' },
  done: { css: '#5dff9a', rgb: [0.3, 1.0, 0.55], pulse: 0.0, en: 'DONE' },
  offline: { css: '#6b7488', rgb: [0.35, 0.38, 0.45], pulse: 0.0, en: 'OFFLINE' },
};
export const styleOf = (status) => STATUS_STYLE[status] || STATUS_STYLE.idle;

export class AgentVisuals {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'agents';
    this.roof = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4); // x, y, z, pillar on
    this.dock = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4); // x, y, z, pad on
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4); // r, g, b, pulse rate
    for (const a of [this.roof, this.dock, this.col]) a.setUsage(THREE.DynamicDrawUsage);
    const sphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

    // the shaft: like the run beacons, a soft volume that fades where its walls turn edge-on
    const pillarMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    {
      const P = positionGeometry;
      const r = attribute('aR', 'vec4'), c = attribute('aCol', 'vec4');
      const h = P.y;
      const flow = fract(h.mul(14).sub(U.time.mul(0.5).add(c.w.mul(U.time).mul(0.2))));
      const pulse = sin(U.time.mul(c.w).mul(Math.PI)).mul(0.5).add(0.5).mul(c.w.min(1)).oneMinus().mul(0.55).add(0.45);
      const world = vec3(P.x.mul(2.4), P.y.mul(140), P.z.mul(2.4)).add(r.xyz);
      const toCam = cameraPosition.sub(world).xz.normalize();
      const face = abs(vec2(P.x, P.z).normalize().dot(toCam)).pow(1.5);
      const camD = length(cameraPosition.xz.sub(r.xz));
      const near = mix(float(0.15), float(1), smoothstep(10, 70, camD));
      pillarMat.colorNode = c.xyz.mul(flow.mul(0.6).add(0.7)).mul(2.0);
      pillarMat.opacityNode = float(1).sub(h).pow(1.4).mul(smoothstep(0, 0.03, h)).mul(0.5).mul(face).mul(near).mul(pulse).mul(r.w);
      pillarMat.positionNode = world;
    }
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true).translate(0, 0.5, 0);
    const pg = new THREE.InstancedBufferGeometry();
    pg.index = cyl.index;
    pg.setAttribute('position', cyl.attributes.position);
    pg.setAttribute('aR', this.roof);
    pg.setAttribute('aCol', this.col);
    pg.instanceCount = CAP; // unused slots have alpha 0
    pg.boundingSphere = sphere;
    this.pillar = new THREE.Mesh(pg, pillarMat);

    // the kerb ring: dashes chasing round, a soft pool inside, brighter as you come close
    const padMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    {
      const P = positionGeometry;
      const d = attribute('aD', 'vec4'), c = attribute('aCol', 'vec4');
      const rr = length(P.xy);
      const dash = smoothstep(0.25, 0.35, fract(atan(P.y, P.x).mul(12 / Math.PI).sub(U.time.mul(0.9))));
      const rim = smoothstep(0.88, 0.92, rr).mul(smoothstep(1.0, 0.96, rr)).mul(dash.mul(0.7).add(0.3));
      const pool = smoothstep(0.15, 0.95, rr).pow(2).mul(smoothstep(1.0, 0.94, rr)).mul(0.22);
      const pulse = sin(U.time.mul(c.w).mul(Math.PI)).mul(0.3).mul(c.w.min(1)).add(1);
      const camD = length(cameraPosition.sub(d.xyz));
      padMat.colorNode = c.xyz.mul(1.8).mul(pulse);
      padMat.opacityNode = rim.add(pool).mul(smoothstep(260, 120, camD)).mul(d.w);
      padMat.positionNode = vec3(P.x.mul(4.5), 0.14, P.y.mul(4.5)).add(d.xyz);
    }
    const disc = new THREE.CircleGeometry(1, 64);
    const dg = new THREE.InstancedBufferGeometry();
    dg.index = disc.index;
    dg.setAttribute('position', disc.attributes.position);
    dg.setAttribute('aD', this.dock);
    dg.setAttribute('aCol', this.col);
    dg.instanceCount = CAP;
    dg.boundingSphere = sphere;
    this.pad = new THREE.Mesh(dg, padMat);

    for (const m of [this.pillar, this.pad]) {
      m.frustumCulled = false;
      m.layers.set(LAYER_NOREFL);
      this.group.add(m);
    }
  }

  // slot i: place, roof and status style
  set(i, place, status) {
    const s = styleOf(status);
    const { roof, dock } = place;
    this.roof.array.set([roof.x, roof.y + 0.5, roof.z, status === 'offline' ? 0 : 1], i * 4);
    this.dock.array.set([dock.x, 0, dock.z, 1], i * 4);
    this.col.array.set([...s.rgb, s.pulse], i * 4);
    for (const a of [this.roof, this.dock, this.col]) a.needsUpdate = true;
  }

  clear(i) {
    this.roof.array[i * 4 + 3] = 0;
    this.dock.array[i * 4 + 3] = 0;
    this.roof.needsUpdate = this.dock.needsUpdate = true;
  }
}
