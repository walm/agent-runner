// Turn-by-turn navigation to the waypoint, as a satnav does it. The streets are a full grid (city.xs run north–south
// at x = p, city.zs east–west at z = p), so the route is a shortest path over the junctions, with a cost per turn so
// it keeps to few of them, and a cost for setting off against the car's heading. The route is kept and the car's
// progress along it tracked; off it for a moment, it is planned again from where the car is.
const TURN = 70; // metres a turn is worth
const UTURN = 600; // turning back at a junction: only when nothing else goes there
const OFF = 24; // metres from the route that count as off it
const LOOK = 30; // metres along the route the pointer aims at

// directions: 0 +x, 1 -x, 2 +z, 3 -z
const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];
const dirOf = (dx, dz) => (Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 0 : 1) : dz > 0 ? 2 : 3);
const turnCost = (a, b) => (a === b ? 0 : (a ^ 1) === b ? UTURN : TURN);

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

export class Nav {
  constructor(city) {
    this.xs = city.xs.map((l) => l.p);
    this.zs = city.zs.map((l) => l.p);
    this.nx = this.xs.length;
    this.nz = this.zs.length;
    this.target = null; // { x, z } the route leads to
    this.points = null; // the route still ahead: the car's place on it, then the corners, then the end on the street
    this.end = null; // the waypoint itself, which may be off the street (a map click inside a block)
    this.seg = 0; // which leg of the route the car is on
    this.offT = 0;
    this.lastPlan = -1e9;
    this.maneuver = null; // { type: 'left' | 'right' | 'straight' | 'back' | 'arrive', dist, total }
  }

  // the nearest point on a street: which street line, the junctions either side of it
  snap(x, z) {
    let best = null;
    const { xs, zs } = this;
    const zi = this.bracket(zs, z), xi = this.bracket(xs, x);
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(x - xs[i]);
      if (!best || d < best.d) best = { d, x: xs[i], z: Math.min(zs[zs.length - 1], Math.max(zs[0], z)), axis: 'z', i, j: zi };
    }
    for (let j = 0; j < zs.length; j++) {
      const d = Math.abs(z - zs[j]);
      if (d < best.d) best = { d, x: Math.min(xs[xs.length - 1], Math.max(xs[0], x)), z: zs[j], axis: 'x', i: xi, j };
    }
    // the junctions at the ends of the block of street it lies on
    best.a = [best.i, best.j];
    best.b = best.axis === 'z' ? [best.i, best.j + 1] : [best.i + 1, best.j];
    return best;
  }

  // the index k with arr[k] <= v <= arr[k + 1], clamped to the ends
  bracket(arr, v) {
    let k = 0;
    while (k < arr.length - 2 && arr[k + 1] < v) k++;
    return k;
  }

  pos(i, j) { return { x: this.xs[i], z: this.zs[j] }; }

  plan(x, z, hx, hz) {
    const S = this.snap(x, z), T = this.snap(this.target.x, this.target.z);
    const { nx, nz } = this;
    const N = nx * nz * 4;
    const cost = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
    const heap = new Heap();
    const hd = Math.hypot(hx, hz) > 0.01 ? dirOf(hx, hz) : -1;
    // setting off: either way along the street the car is on; against its heading costs a turn round
    const startCost = (d) => (hd < 0 || hd === d ? 0 : (hd ^ 1) === d ? TURN * 2 : TURN * 0.5);
    for (const [i, j] of [S.a, S.b]) {
      const p = this.pos(i, j);
      const d = dirOf(p.x - S.x, p.z - S.z);
      const c = Math.hypot(p.x - S.x, p.z - S.z) + startCost(d);
      const s = ((i * nz + j) << 2) | d;
      if (c < cost[s]) { cost[s] = c; prev[s] = -2; heap.push(c, s); }
    }
    while (heap.size) {
      const s = heap.pop();
      const c = cost[s], d = s & 3, n = s >> 2, i = (n / nz) | 0, j = n % nz;
      for (let o = 0; o < 4; o++) {
        const i2 = i + DX[o], j2 = j + DZ[o];
        if (i2 < 0 || i2 >= nx || j2 < 0 || j2 >= nz) continue;
        const c2 = c + Math.abs(this.xs[i2] - this.xs[i]) + Math.abs(this.zs[j2] - this.zs[j]) + turnCost(d, o);
        const s2 = (((i2 * nz) + j2) << 2) | o;
        if (c2 < cost[s2]) { cost[s2] = c2; prev[s2] = s; heap.push(c2, s2); }
      }
    }
    // the last leg: from a junction at either end of the target's block of street
    let best = Infinity, bs = -1;
    for (const [i, j] of [T.a, T.b]) {
      const p = this.pos(i, j);
      const len = Math.hypot(T.x - p.x, T.z - p.z);
      const d = len > 0.5 ? dirOf(T.x - p.x, T.z - p.z) : -1;
      for (let o = 0; o < 4; o++) {
        const s = (((i * nz) + j) << 2) | o;
        const c = cost[s] + len + (d < 0 ? 0 : turnCost(o, d));
        if (c < best) { best = c; bs = s; }
      }
    }
    // both on the same block of street: straight there, if that beats going round
    const same = S.axis === T.axis && S.i === T.i && S.j === T.j;
    const direct = same ? Math.hypot(T.x - S.x, T.z - S.z) + startCost(dirOf(T.x - S.x, T.z - S.z)) : Infinity;
    const pts = [{ x: S.x, z: S.z }];
    if (direct > best) {
      const chain = [];
      for (let s = bs; s >= 0; s = prev[s]) { const n = s >> 2; chain.push(this.pos((n / nz) | 0, n % nz)); }
      pts.push(...chain.reverse());
    }
    pts.push({ x: T.x, z: T.z });
    this.points = corners(pts);
    this.end = { x: this.target.x, z: this.target.z };
    this.seg = 0;
  }

  // per frame: target is the game's waypoint (or null); p the car's position, h its heading
  update(target, p, hx, hz, now, dt) {
    if (!target) { this.target = this.points = this.ahead = this.maneuver = null; return; }
    if (!this.target || this.target.x !== target.x || this.target.z !== target.z) {
      this.target = { x: target.x, z: target.z };
      this.plan(p.x, p.z, hx, hz);
      this.lastPlan = now;
    }
    // where the car is along the route: the nearest point on this leg or the next two
    const P = this.points;
    let bd = Infinity, bk = this.seg, bq = null;
    for (let k = Math.max(0, this.seg - 1); k < Math.min(P.length - 1, this.seg + 3); k++) {
      const q = closest(P[k], P[k + 1], p.x, p.z);
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bd - 0.01) { bd = d; bk = k; bq = q; }
    }
    this.offT = bd > OFF ? this.offT + dt : 0;
    if (this.offT > 0.6 && now - this.lastPlan > 1500) {
      this.plan(p.x, p.z, hx, hz);
      this.lastPlan = now;
      this.offT = 0;
      return this.update(target, p, hx, hz, now, 0);
    }
    this.seg = bk;
    // what is still ahead, from the car's place on the route
    this.ahead = [bq, ...P.slice(bk + 1)];
    this.maneuver = this.next(hx, hz);
  }

  // the next thing to do: the next corner and which way, or the arrival; against the route, turn round
  next(hx, hz) {
    const A = this.ahead;
    let dist = 0, total = 0;
    for (let k = 0; k < A.length - 1; k++) total += Math.hypot(A[k + 1].x - A[k].x, A[k + 1].z - A[k].z);
    if (this.end) total += Math.hypot(this.end.x - A[A.length - 1].x, this.end.z - A[A.length - 1].z);
    const d0 = unit(A[0], A[1]);
    if (d0 && Math.hypot(hx, hz) > 0.01 && d0.x * hx + d0.z * hz < -0.5) return { type: 'back', dist: 0, total };
    for (let k = 1; k < A.length - 1; k++) {
      dist += Math.hypot(A[k].x - A[k - 1].x, A[k].z - A[k - 1].z);
      const a = unit(A[k - 1], A[k]), b = unit(A[k], A[k + 1]);
      if (!a || !b) continue;
      const cross = a.x * b.z - a.z * b.x;
      if (Math.abs(cross) > 0.5) return { type: cross > 0 ? 'right' : 'left', dist, total };
    }
    return { type: 'arrive', dist: total, total };
  }

  // a point d metres along the route ahead (for the pointer and the VR dash)
  along(d) {
    const A = this.ahead;
    if (!A) return null;
    for (let k = 0; k < A.length - 1; k++) {
      const l = Math.hypot(A[k + 1].x - A[k].x, A[k + 1].z - A[k].z);
      if (d <= l) { const t = l ? d / l : 0; return { x: A[k].x + (A[k + 1].x - A[k].x) * t, z: A[k].z + (A[k + 1].z - A[k].z) * t }; }
      d -= l;
    }
    return A[A.length - 1];
  }

  lookahead() { return this.along(LOOK); }

  // the route as the maps draw it: from the car to the waypoint, the last stretch off the street included
  line() {
    if (!this.ahead) return null;
    const last = this.ahead[this.ahead.length - 1];
    return this.end && Math.hypot(this.end.x - last.x, this.end.z - last.z) > 1 ? [...this.ahead, this.end] : this.ahead;
  }
}

// drop the points that lie straight on between their neighbours, and repeats
function corners(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p.x - last.x, p.z - last.z) < 0.5) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      if ((Math.abs(a.x - last.x) < 0.01 && Math.abs(last.x - p.x) < 0.01) || (Math.abs(a.z - last.z) < 0.01 && Math.abs(last.z - p.z) < 0.01)) out.pop();
    }
    out.push(p);
  }
  if (out.length === 1) out.push({ ...out[0] });
  return out;
}

function unit(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
  return l < 0.01 ? null : { x: dx / l, z: dz / l };
}

function closest(a, b, x, z) {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
  return { x: a.x + dx * t, z: a.z + dz * t };
}
