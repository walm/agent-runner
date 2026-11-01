// Agent → building. Each harness has a neighbourhood (a district seed); an agent's id hashes to one of the
// street-facing buildings nearest that seed, so the same agent comes back to the same door every session.
// The dock is the kerb lane in front of the building's street face, where the car pulls up.
import { SEEDS, groundAt, onSidewalk } from '../city/layout.js';

const NORM = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const POOL = 80;

const seed = (en) => SEEDS.find((s) => s.en === en);
export const HOODS = {
  'claude-code': seed('TEMPLE NIGHT MARKET'),
  codex: seed('YAU MA TEI'),
  pi: seed('SHAM SHUI PO'),
  gemini: seed('JORDAN'),
  other: seed('KOWLOON CITY'),
};

export function hash(s) {
  // FNV-1a, 32 bit
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// the kerb lane in front of a street face: out past the pavement onto the road, then a little further
function dockFor(city, b) {
  const [nx, nz] = NORM[b.streetFace];
  const fx = b.x + nx * b.w / 2, fz = b.z + nz * b.d / 2;
  for (let d = 1; d < 24; d += 0.5) {
    const x = fx + nx * d, z = fz + nz * d;
    if (!onSidewalk(city, x, z) && groundAt(city, x, z, 3) < 0.05) {
      const px = x + nx * 2.6, pz = z + nz * 2.6;
      if (onSidewalk(city, px, pz) || groundAt(city, px, pz, 3) > 0.05) return null;
      // facing along the street; the car keeps left, so the kerb is on its left
      const yaw = Math.atan2(-nz, nx);
      return { x: px, z: pz, yaw, nx, nz };
    }
  }
  return null;
}

export class Placement {
  constructor(city) {
    this.city = city;
    this.byAgent = new Map(); // id -> slot
    this.taken = new Set(); // building ids
    this.pools = new Map(); // harness key -> candidate slots
    const cands = [];
    for (const b of city.buildings) {
      if (b.streetFace === null || b.streetFace === undefined || b.zenith || !b.tiers) continue;
      const dock = dockFor(city, b);
      if (dock) cands.push({ b, dock });
    }
    this.cands = cands;
  }

  pool(harness) {
    const key = HOODS[harness] ? harness : 'other';
    if (!this.pools.has(key)) {
      const s = HOODS[key];
      // nearest first, then a stable order by building id so the hash lands the same way every session
      const near = this.cands.slice().sort((p, q) => Math.hypot(p.b.x - s.x, p.b.z - s.z) - Math.hypot(q.b.x - s.x, q.b.z - s.z)).slice(0, POOL);
      near.sort((p, q) => p.b.id - q.b.id);
      this.pools.set(key, near);
    }
    return this.pools.get(key);
  }

  // returns { building, dock, roof } for an agent, assigning one on first sight
  place(agent) {
    const have = this.byAgent.get(agent.id);
    if (have) return have;
    const pool = this.pool(agent.harness);
    let slot = null;
    const start = hash(agent.id) % pool.length;
    for (let k = 0; k < pool.length; k++) {
      const c = pool[(start + k) % pool.length];
      if (!this.taken.has(c.b.id)) { slot = c; break; }
    }
    // the neighbourhood is full: spill over anywhere in the city
    if (!slot) {
      const s2 = hash(agent.id + '#') % this.cands.length;
      for (let k = 0; k < this.cands.length && !slot; k++) {
        const c = this.cands[(s2 + k) % this.cands.length];
        if (!this.taken.has(c.b.id)) slot = c;
      }
    }
    if (!slot) return null;
    this.taken.add(slot.b.id);
    const b = slot.b;
    const out = { building: b, dock: slot.dock, roof: { x: b.x, y: b.h, z: b.z } };
    this.byAgent.set(agent.id, out);
    return out;
  }

  release(id) {
    const p = this.byAgent.get(id);
    if (!p) return;
    this.byAgent.delete(id);
    this.taken.delete(p.building.id);
  }
}
