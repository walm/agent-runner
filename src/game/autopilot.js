// The autopilot: the car drives itself. Modes:
//   agent   by the satnav to the agents that need you (waiting on you, or failed), one after another: the long
//           way over the streets at 50 m, the last few hundred metres a few metres over the traffic in the left
//           lane; it lands at the kerb and waits while the agent still needs you. With nobody waiting it calls on
//           the others in turn. Pinned to one agent (AUTO in the agents list, or P while driving to one), it goes
//           there and nowhere else, and hands the car back once it has landed at the kerb (`finish`)
//   cruise  the street canyons at skyline height, at an easy pace, turning where it likes
//   turbo   the avenues lower down, boosting along the long straights
//   tour    the districts one after another, and round the Zenith spire, with a word from the radio at each
// The flying modes keep to heights between the sky lanes (life/skytraffic.js: 72, 168, 330 m over the avenues
// that run north–south, 118 and 236 m over the others), and to the streets, which are open all the way up.
//
// One way of driving serves them all: a path of points (street junctions), followed by pure pursuit (aim at the
// point a little way along the path; nearer at low speed, so the corners are not cut into the blocks), a speed
// that eases off for the corners and for anything ahead it must climb over, and controls that change smoothly.
// Any steering, throttle, lift or boost from the player takes the car back (game.js).
import { SEEDS, queryBoxes, groundAt, districtSeedAt } from '../city/layout.js';
import { SKY_ALT } from '../life/skytraffic.js';

export const MODES = ['off', 'agent', 'cruise', 'turbo', 'tour'];
export const MODE_NAMES = { off: 'OFF', agent: 'AGENT', cruise: 'CRUISE', turbo: 'TURBO', tour: 'TOUR' };

const PROFILE = {
  agent: { alt: 6.5, speed: 22, lane: 3.4, high: 50, fast: 45 }, // 6.5: over the street traffic (it collides below 6 m)
  cruise: { alt: 95, speed: 30 },
  turbo: { alt: 50, speed: 118, boost: true },
  tour: { alt: 145, speed: 26 },
};
const CLEAR = 3.5; // metres the car keeps from anything above or below its path
const PROBE = 2; // half-width of the corridor checked along the path: the car's, and a margin
const DWELL = 12; // seconds parked with an agent that does not need you, when calling on them in turn
const DWELL_NEEDY = 60; // the longest it waits with one that does, while others wait too

const _b = [];
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const approach = (v, t, rate) => v + clamp(t - v, -rate, rate);

export class Autopilot {
  // game: the Game (kite, city, nav, agents, hud, sound); onStop(stop) when the tour passes a stop
  constructor(game) {
    this.game = game;
    this.city = game.city;
    this.xs = game.city.xs;
    this.zs = game.city.zs;
    this.mode = 'off';
    this.out = { throttle: 0, steer: 0, lift: 0, boost: false };
    this.path = [];
    this.status = '';
    this.visits = new Map(); // agent id -> when it was last called on
    this.stuck = 0;
    this.back = 0;
    this.scanAt = 0;
    this.need = { y: 0, at: Infinity, under: Infinity };
    this.pin = null; // the one agent a pinned trip goes to
    this.finish = null; // why it is done and the car is the driver's again (game.js turns it off)
  }

  // pin: the id of the one agent to drive to (agent mode); without one, the agent being driven to by the waypoint
  set(mode, { pin } = {}) {
    if (!MODES.includes(mode)) mode = 'off';
    const was = this.mode;
    this.mode = mode;
    this.pin = mode === 'agent' ? pin || this.game.waypointAgent || null : null;
    this.finish = null;
    this.path = [];
    this.stop = null;
    this.parked = null;
    this.target = null;
    this.stuck = this.back = 0;
    this.status = '';
    this.out = { throttle: 0, steer: 0, lift: 0, boost: false };
    if (mode === 'tour') { this.stops = this.tourStops(); this.carIx = 0; this.announced = null; }
    // the agent mode drives by the satnav: its waypoint goes with it to another mode (taking the car back, the
    // driver keeps it, to drive there)
    if (was === 'agent' && mode !== 'agent' && mode !== 'off' && this.game.waypointAgent) { this.game.waypoint = null; this.game.waypointAgent = null; }
  }

  get on() { return this.mode !== 'off'; }

  // ---- per frame ----

  controls(dt) {
    const k = this.game.kite, p = PROFILE[this.mode];
    this.t = (this.t || 0) + dt;
    let plan;
    if (this.mode === 'agent') plan = this.agentPlan();
    else {
      this.extend();
      plan = { path: this.path, alt: p.alt, speed: p.speed };
    }
    if (!plan) return this.smooth(dt, { throttle: -0.3, steer: 0, lift: 0, boost: false });
    if (plan.park) return this.smooth(dt, plan.park);
    return this.follow(dt, k, plan, p);
  }

  // drive along plan.path at plan.alt above the street, up to plan.speed; plan.land: come down at its end
  follow(dt, k, plan, prof) {
    const P = plan.path;
    if (!P || P.length < 2) return this.smooth(dt, { throttle: -0.4, steer: 0, lift: 0, boost: false });
    const v = Math.max(0, k.vel.x * k.fwd.x + k.vel.z * k.fwd.z);
    const air = k.mode === 'air';

    // where the car is on the path, and the point to aim at
    const at = this.locate(P, k.pos.x, k.pos.z);
    const L = clamp(v * 0.7 + 4, 7, 60);
    const aim = this.along(P, at, L);
    const want = Math.atan2(-(aim.x - k.pos.x), -(aim.z - k.pos.z));
    const err = wrap(want - k.yaw);

    // the yaw rate pure pursuit asks for, as the steering that gives it (the car's own limits, kite.js)
    const maxRate = air ? 1.45 / (1 + v / 80) : (2.1 * Math.min(1, v / 7)) / (1 + v / 55);
    const w = (Math.max(v, 5) * 2 * Math.sin(err)) / L;
    let steer = maxRate > 0.05 ? clamp(-w / maxRate, -1, 1) : 0;

    // speed: the mode's, eased for the corners and climbs ahead, slow to turn round
    let vT = plan.speed;
    for (const c of this.corners(P, at, Math.max(60, v * 4), plan.alt)) {
      const vc = c.open ? 34 : c.turn > 1.2 ? 9 : c.turn > 0.6 ? 14 : 26;
      vT = Math.min(vT, Math.sqrt(vc * vc + 2 * 9 * Math.max(0, c.d - 6)));
    }
    if (Math.abs(err) > 1.1) vT = Math.min(vT, 5);
    else if (Math.abs(err) > 0.5) vT = Math.min(vT, 14);

    // height: the mode's above the street, or over whatever is in the way ahead. Low down (taking off, or the
    // agent mode's hover) what matters is what is at the car's own height; higher up, at the height it flies at
    const street = groundAt(this.city, k.pos.x, k.pos.z, 1);
    let ty = street + plan.alt;
    // the end of the agent mode's route: down onto the street at the kerb, slowing to a stop there
    if (plan.land) {
      // what is left: along the path, and never less than the way to its end (a route that doubles back near
      // the kerb puts the car beside its last metres while the kerb is still across the street)
      const end = P[P.length - 1];
      const left = Math.max(this.remaining(P, at), Math.hypot(end.x - k.pos.x, end.z - k.pos.z));
      vT = Math.min(vT, Math.max(1.5, left * 0.45));
      ty = street + clamp((left - 7) * 0.4, 0, plan.alt);
      if (left < 3) return this.smooth(dt, { throttle: v > 0.6 ? -0.6 : 0, steer: 0, lift: air ? -1 : 0, boost: false });
    }
    const low = k.pos.y < street + 14;
    if (this.t - this.scanAt > 0.1) { this.need = this.scan(P, at, Math.max(40, v * 3.5), low ? Math.max(k.pos.y, street + 1) : ty); this.scanAt = this.t; }
    // off the street: out to the middle of it low down (signs and awnings hang over the kerbs), then up, and only
    // then away; still under something, along the street low until clear of it
    let ceiling = Infinity;
    if (low && plan.alt > 14) {
      ceiling = this.ceiling(k.pos.x, k.pos.z, k.pos.y, ty);
      if (Math.sqrt(at.d) > 1.5) { ty = Math.min(ty, street + 1.6); vT = Math.min(vT, 5); }
      else if (ceiling < Infinity) { ty = Math.min(ty, ceiling - 2.4); vT = Math.min(vT, 6); }
      else vT = Math.min(vT, 3);
    }
    ty = this.laneSafe(k.pos.x, k.pos.z, k.pos.y, ty);
    // low among signs and awnings: slower, while anything has been close ahead in the last moments
    if (this.need.at < 25) this.cluttered = this.t;
    if (low && this.t - (this.cluttered ?? -9) < 2) vT = Math.min(vT, 10);
    if (this.need.y > ty) {
      // something in the way: under it when there is room beneath and that is the smaller move (a sign over the
      // street), else over it, no faster than the car can climb, and not at all when it is close
      const under = this.need.under - 2.4;
      if (under > street + 1.4 && k.pos.y - under < this.need.y - k.pos.y) {
        ty = Math.min(ty, under);
        if (k.pos.y - ty > 0.6 && this.need.at < 10) vT = 0; // low enough first
      } else {
        ty = this.need.y;
        const dy = ty - k.pos.y;
        if (dy > 0.6) vT = Math.min(vT, this.need.at < 10 ? 0 : (17 * (this.need.at - 10)) / dy);
      }
    }

    let lift = clamp((ty - k.pos.y) / 7 - k.vel.y * 0.08, -1, 1);
    // on the ground: off it first (it cannot turn standing still), unless this is the landing
    if (!air && !(plan.land && ty - street < 0.5)) lift = 1;
    else if (!air) lift = 0;
    let throttle = clamp((vT - v) * 0.22, -1, 1);
    const boost = !!prof.boost && vT > 70 && Math.abs(err) < 0.12 && v > 35 && throttle > 0.3;

    // pinned against something: back off a moment, climbing, as a driver would
    this.stuck = throttle > 0.2 && k.speed < 1.2 && air ? this.stuck + dt : 0;
    if (this.stuck > 1.5) { this.back = 1.2; this.stuck = 0; }
    if (this.back > 0) { this.back -= dt; return this.smooth(dt, { throttle: -0.8, steer: -steer, lift: ty < k.pos.y - 0.5 || ceiling < k.pos.y + 3 ? -1 : 1, boost: false }, true); }
    return this.smooth(dt, { throttle, steer, lift, boost });
  }

  // controls that move at a steady rate, not in jumps (hard: braking or backing off may jump)
  smooth(dt, c, hard = false) {
    const o = this.out;
    o.steer = approach(o.steer, c.steer, dt * 3.5);
    o.throttle = hard || c.throttle < o.throttle - 0.5 ? c.throttle : approach(o.throttle, c.throttle, dt * 2.5);
    o.lift = approach(o.lift, c.lift, dt * 3);
    o.boost = c.boost;
    return o;
  }

  // ---- paths ----

  // the nearest point on the path to (x, z), from the segment it was on last: { i, t, x, z }
  locate(P, x, z) {
    let best = null;
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
      const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / l2, 0, 1);
      const qx = a.x + dx * t, qz = a.z + dz * t, d = (qx - x) ** 2 + (qz - z) ** 2;
      if (!best || d < best.d) best = { i, t, x: qx, z: qz, d };
      if (i > (best.i ?? 0) + 3) break; // far enough along: the rest is further on
    }
    return best;
  }

  along(P, at, dist) {
    let x = at.x, z = at.z;
    for (let i = at.i; i < P.length - 1; i++) {
      const b = P[i + 1], l = Math.hypot(b.x - x, b.z - z);
      if (dist <= l) return { x: x + ((b.x - x) * dist) / (l || 1), z: z + ((b.z - z) * dist) / (l || 1) };
      dist -= l; x = b.x; z = b.z;
    }
    return P[P.length - 1];
  }

  remaining(P, at) {
    let d = Math.hypot(P[at.i + 1].x - at.x, P[at.i + 1].z - at.z);
    for (let i = at.i + 1; i < P.length - 1; i++) d += Math.hypot(P[i + 1].x - P[i].x, P[i + 1].z - P[i].z);
    return d;
  }

  // the turns ahead within reach: { d (metres to it), turn (radians), open (nothing tall at the corner) }
  corners(P, at, reach, alt) {
    const out = [];
    let d = Math.hypot(P[at.i + 1].x - at.x, P[at.i + 1].z - at.z);
    for (let i = at.i + 1; i < P.length - 1 && d < reach; i++) {
      const a = P[i - 1], b = P[i], c = P[i + 1];
      const turn = Math.abs(wrap(Math.atan2(c.x - b.x, c.z - b.z) - Math.atan2(b.x - a.x, b.z - a.z)));
      if (turn > 0.25) out.push({ d, turn, open: alt > 30 && this.roofs(b.x, b.z, 26) < groundAt(this.city, b.x, b.z, 1) + alt - 8 });
      d += Math.hypot(c.x - b.x, c.z - b.z);
    }
    return out;
  }

  // the lowest underside of anything over the car between its height y and ty
  ceiling(x, z, y, ty) {
    const r = 3.2;
    queryBoxes(this.city, x - r, z - r, x + r, z + r, _b);
    let c = Infinity;
    for (const b of _b) if (b.x1 > x - r && b.x0 < x + r && b.z1 > z - r && b.z0 < z + r && b.y0 > y + 0.9 && b.y0 < ty) c = Math.min(c, b.y0);
    return c;
  }

  // the sky lanes (life/skytraffic.js) run 5 m either side of the avenues at fixed heights. Close to a lane's
  // line, the car does not climb or sink through its height: it waits just above or below until it is clear
  laneSafe(x, z, y, ty) {
    const BAND = 4;
    const near = (list, c) => list.some((l) => l.w >= 24 && !l.harbour && Math.abs(Math.abs(c - l.p) - 5) < 6);
    const guard = (alts) => {
      for (const a of alts) {
        if (y > a + BAND && ty < a + BAND) ty = a + BAND + 0.5; // above it: no lower than its top
        else if (y < a - BAND && ty > a - BAND) ty = a - BAND - 0.5; // below it: no higher than its bottom
        else if (Math.abs(y - a) <= BAND) ty = ty >= a ? Math.max(ty, a + BAND + 1) : Math.min(ty, a - BAND - 1); // in it: out
      }
    };
    if (near(this.xs, x)) guard(SKY_ALT.z);
    if (near(this.zs, z)) guard(SKY_ALT.x);
    return ty;
  }

  // the highest top of anything within r of (x, z)
  roofs(x, z, r) {
    queryBoxes(this.city, x - r, z - r, x + r, z + r, _b);
    let top = -Infinity;
    for (const b of _b) if (b.x1 > x - r && b.x0 < x + r && b.z1 > z - r && b.z0 < z + r) top = Math.max(top, b.y1);
    return top;
  }

  // along the path ahead, anything in the way of flying at height y: the height to climb to, and how far ahead
  scan(P, at, reach, y) {
    let need = -Infinity, first = Infinity, under = Infinity;
    for (let s = 0; s <= reach; s += 5) {
      const q = this.along(P, at, s);
      queryBoxes(this.city, q.x - PROBE, q.z - PROBE, q.x + PROBE, q.z + PROBE, _b);
      for (const b of _b) {
        if (b.x1 < q.x - PROBE || b.x0 > q.x + PROBE || b.z1 < q.z - PROBE || b.z0 > q.z + PROBE) continue;
        // above the car with room under it: it passes beneath
        if (b.y0 > y + CLEAR || b.y1 < y - CLEAR) continue;
        if (b.y1 + CLEAR > need) need = b.y1 + CLEAR;
        first = Math.min(first, s);
        under = Math.min(under, b.y0);
      }
    }
    return { y: need, at: first, under };
  }

  // the street junction nearest (x, z), as grid indices
  junction(x, z) {
    let i = 0, j = 0;
    for (let n = 1; n < this.xs.length; n++) if (Math.abs(this.xs[n].p - x) < Math.abs(this.xs[i].p - x)) i = n;
    for (let n = 1; n < this.zs.length; n++) if (Math.abs(this.zs[n].p - z) < Math.abs(this.zs[j].p - z)) j = n;
    return { i, j };
  }

  pt(i, j) { return { x: this.xs[i].p, z: this.zs[j].p, i, j }; }

  // keep a few hundred metres of path ahead for the free modes, dropping what is behind
  extend() {
    const k = this.game.kite;
    if (this.path.length >= 2) {
      const at = this.locate(this.path, k.pos.x, k.pos.z);
      if (at.i > 0) this.path.splice(0, at.i);
      if (this.remaining(this.path, this.locate(this.path, k.pos.x, k.pos.z)) > 700) return;
    } else {
      // from abreast of the car on the middle of its street: it pulls out to there first
      const next = this.ahead(k), alongX = this.dir < 2;
      this.path = [alongX ? { x: k.pos.x, z: next.z } : { x: next.x, z: k.pos.z }, next];
    }
    while (this.remaining(this.path, { i: 0, x: this.path[0].x, z: this.path[0].z }) < 900) {
      const last = this.path[this.path.length - 1];
      const next = this.mode === 'tour' ? this.tourLeg(last) : this.wander(last);
      if (!next) break;
      this.path.push(next);
    }
  }

  // the junction ahead of the car on the street it is on (or nearest), in the direction it faces; this.dir
  // becomes that direction in grid terms: 0 +x, 1 -x, 2 +z, 3 -z
  ahead(k) {
    const x = k.pos.x, z = k.pos.z, alongX = Math.abs(k.fwd.x) > Math.abs(k.fwd.z);
    const { i, j } = this.junction(x, z);
    for (const flip of [false, true]) {
      const sgn = (alongX ? Math.sign(k.fwd.x) : Math.sign(k.fwd.z)) * (flip ? -1 : 1) || 1;
      this.dir = alongX ? (sgn > 0 ? 0 : 1) : sgn > 0 ? 2 : 3;
      if (alongX) {
        for (let n = sgn > 0 ? 0 : this.xs.length - 1; n >= 0 && n < this.xs.length; n += sgn) if ((this.xs[n].p - x) * sgn > 6 && this.inside(n, j)) return this.pt(n, j);
      } else {
        for (let n = sgn > 0 ? 0 : this.zs.length - 1; n >= 0 && n < this.zs.length; n += sgn) if ((this.zs[n].p - z) * sgn > 6 && this.inside(i, n)) return this.pt(i, n);
      }
    }
    return this.pt(clamp(i, 1, this.xs.length - 2), clamp(j, 1, this.zs.length - 2));
  }

  inside(i, j) { return i >= 1 && i < this.xs.length - 1 && j >= 1 && j < this.zs.length - 1 && !this.zs[j].harbour; }

  // the next junction on a wander: on most, straight on; now and then, a turn; never back, never out of town.
  // Turbo keeps to the avenues, and only turns where one crosses
  wander(from) {
    const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];
    const avenue = (d, i, j) => (d < 2 ? this.zs[j].w : this.xs[i].w) >= 24;
    const opts = [];
    for (let d = 0; d < 4; d++) {
      if (d === (this.dir ^ 1)) continue;
      const i = from.i + DX[d], j = from.j + DZ[d];
      if (!this.inside(i, j)) continue;
      let w = d === this.dir ? 3 : 1;
      if (this.mode === 'turbo') {
        if (!avenue(d, from.i, from.j)) w = avenue(this.dir, from.i, from.j) ? 0 : 0.2;
        else w *= d === this.dir ? 3 : 1;
      }
      if (w > 0) opts.push({ d, i, j, w });
    }
    if (!opts.length) { this.dir ^= 1; return this.pt(from.i + DX[this.dir], from.j + DZ[this.dir]); }
    let r = Math.random() * opts.reduce((s, o) => s + o.w, 0);
    const o = opts.find((x) => (r -= x.w) < 0) || opts[0];
    this.dir = o.d;
    return this.pt(o.i, o.j);
  }

  // ---- the tour ----

  // the districts by name, and the Zenith; the nearest first, then on round the city
  tourStops() {
    const k = this.game.kite;
    const all = [...SEEDS.map((s) => ({ ...s, ...this.junction(s.x, s.z) })), { en: 'THE ZENITH', type: 'zenith', x: 0, z: 0, zenith: true }];
    const out = [];
    let x = k.pos.x, z = k.pos.z;
    while (all.length) {
      all.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
      const s = all.shift();
      out.push(s);
      x = s.x; z = s.z;
    }
    this.stopIx = 0;
    return out;
  }

  // the next junction toward the tour's next stop: along one street, then the other. The Zenith's stop is a lap
  // of the streets round its block
  tourLeg(from) {
    const stop = this.stops[this.stopIx % this.stops.length];
    if (stop.zenith && !stop.lap) {
      let iL = 0, jL = 0;
      while (this.xs[iL + 1].p < 0) iL++;
      while (this.zs[jL + 1].p < 0) jL++;
      stop.lap = [this.pt(iL, jL), this.pt(iL + 1, jL), this.pt(iL + 1, jL + 1), this.pt(iL, jL + 1), this.pt(iL, jL)];
      stop.i = iL; stop.j = jL;
    }
    // on the lap: its next corner, whatever junction this is
    if (stop.lapLeft > 0) {
      const n = stop.lap[5 - stop.lapLeft--];
      if (!stop.lapLeft) this.nextStop();
      return n;
    }
    if (from.i === stop.i && from.j === stop.j) {
      if (stop.zenith && stop.lapLeft === undefined) stop.lapLeft = 4;
      else this.nextStop();
      return this.tourLeg(from);
    }
    // along the longer way first, all of it, then the other: one turn, not a staircase
    const di = stop.i - from.i, dj = stop.j - from.j;
    if (stop.firstI === undefined) stop.firstI = Math.abs(this.xs[stop.i].p - this.xs[from.i].p) >= Math.abs(this.zs[stop.j].p - this.zs[from.j].p);
    const goI = di !== 0 && (stop.firstI || dj === 0);
    const i = from.i + (goI ? Math.sign(di) : 0), j = from.j + (goI ? 0 : Math.sign(dj));
    return this.pt(i, j);
  }

  nextStop() {
    const done = this.stops[this.stopIx % this.stops.length];
    delete done.lapLeft;
    delete done.firstI;
    this.stopIx++;
  }

  // called each frame by the game in tour mode: announces each stop as the car comes to it (the path is planned
  // further ahead, so the car keeps its own count of the stops it has reached)
  tourTick() {
    if (this.mode !== 'tour' || !this.stops) return;
    const k = this.game.kite, s = this.stops[(this.carIx || 0) % this.stops.length];
    const d = s.zenith ? Math.hypot(k.pos.x, k.pos.z) : Math.hypot(k.pos.x - this.xs[s.i].p, k.pos.z - this.zs[s.j].p);
    if (d < (s.zenith ? 280 : 160)) {
      this.carIx = (this.carIx || 0) + 1;
      this.announced = { s, at: this.t };
      this.onStop?.(s);
    }
    const a = this.announced;
    this.status = a && this.t - a.at < 25 ? `TOUR · ${a.s.en}` : `TOUR · NEXT ${s.en}`;
  }

  // ---- the agents ----

  needy(a) { return a.status === 'waiting' || a.status === 'error'; }

  // the agent to go to: who waits on you first, then who failed, nearest first; with none, the one called on
  // least lately
  pickAgent() {
    const k = this.game.kite, list = [...this.game.agents.entries.values()].filter((e) => e.agent.status !== 'offline');
    if (!list.length) return null;
    const dist = (e) => Math.hypot(e.place.dock.x - k.pos.x, e.place.dock.z - k.pos.z);
    const rank = (e) => (e.agent.status === 'waiting' ? 0 : e.agent.status === 'error' ? 1 : 2);
    // called on in turn: the ones not called on lately first (within ten minutes is lately), nearest first
    const recent = (e) => (Date.now() - (this.visits.get(e.agent.id) || 0) < 600000 ? 1 : 0);
    list.sort((a, b) => rank(a) - rank(b) || (rank(a) < 2 ? 0 : recent(a) - recent(b)) || dist(a) - dist(b));
    // the one just left, only if it is the only one that needs you
    const last = this.left;
    return list.find((e) => e.agent.id !== last) || list[0];
  }

  agentPlan() {
    const g = this.game, k = g.kite;
    if (this.pin) {
      if (!g.agents.entries.has(this.pin)) { this.finish = 'THE AGENT LEFT'; return { park: { throttle: -0.3, steer: 0, lift: 0, boost: false } }; }
      this.target = this.pin;
    }
    let e = this.target && g.agents.entries.get(this.target);
    if (!e) {
      e = this.pickAgent();
      if (!e) { this.status = 'AGENT · NO AGENTS ON SHIFT'; return { park: { throttle: -0.3, steer: 0, lift: 0, boost: false } }; }
      this.target = e.agent.id;
      this.parked = null;
      this.calm = null;
      g.agents.drive(e.agent.id);
    }
    // on the way to one that does not need you (any more, for ten seconds, or never did), still far off, and now
    // another does: go there instead. Otherwise it keeps to its choice, and gets there
    if (this.needy(e.agent)) this.calm = null;
    else this.calm ??= this.t;
    if (!this.pin && !this.parked && this.t - this.calm > 10 && this.t - (this.checked || 0) > 2 && (g.nav.maneuver?.total ?? 0) > 400) {
      this.checked = this.t;
      const first = this.pickAgent();
      if (first && first !== e && this.needy(first.agent)) { e = first; this.target = e.agent.id; this.calm = null; g.agents.drive(e.agent.id); }
    }
    const a = e.agent, d = e.place.dock;
    const near = Math.hypot(k.pos.x - d.x, k.pos.z - d.z);
    // braking that holds the car still: against the way it moves (its speed has no sign; reverse throttle on a car
    // already rolling back would drive it away from the kerb)
    const vf = k.vel.x * k.fwd.x + k.vel.z * k.fwd.z;
    const hold = { throttle: vf > 0.3 ? -0.6 : vf < -0.3 ? 0.6 : 0, steer: 0, lift: k.mode === 'air' ? -1 : 0, boost: false };

    // a pinned trip is there once the car is at the kerb ring, low enough for the agent's card (agents.js), and
    // still; landed or hovering. It holds the car there on the brakes until it stops, then the driver takes over.
    // Within 3 m of the ring's middle it is there; nearer the ring's edge only once it has made no headway for 2 s
    const still = Math.abs(vf) < 0.4 && k.speed < 0.6;
    if (this.pin && k.pos.y < 5 && near < 6.5) {
      this.stuckAt = still && near >= 3 ? this.stuckAt ?? this.t : null;
      if (near < 3 || this.t - (this.stuckAt ?? this.t) > 2) {
        this.status = `AGENT · AT ${a.name.toUpperCase()}`;
        if (still) this.finish = `ARRIVED AT ${a.name.toUpperCase()}`;
        return { park: hold };
      }
    } else this.stuckAt = null;

    // parked: stay while it needs you; move on when it does not (or after a while, if others wait as well)
    // (within the kerb ring's reach, agents.js DOCK_R, and stopped; still in the air, it sets down there)
    if (this.parked || (near < 5 && k.speed < 1.5 && k.pos.y - groundAt(this.city, k.pos.x, k.pos.z, k.pos.y) < 1)) {
      if (!this.parked) { this.parked = this.t; this.visits.set(a.id, Date.now()); }
      const waited = this.t - this.parked;
      const others = [...g.agents.entries.values()].some((x) => x.agent.id !== a.id && this.needy(x.agent));
      const go = this.needy(a) ? others && waited > DWELL_NEEDY : waited > DWELL;
      this.status = `AGENT · AT ${a.name.toUpperCase()}`;
      if (go) { this.left = a.id; this.target = null; this.parked = null; }
      return { park: hold };
    }

    // the satnav's route (game.js keeps it planned to the waypoint), in the left lane, the last stretch to the kerb
    if (g.waypointAgent !== a.id) g.agents.drive(a.id);
    const line = g.nav.line();
    if (!line || line.length < 2) return null;
    // far off: higher and faster, down to the street over the last few hundred metres
    const P = PROFILE.agent, left = g.nav.maneuver?.total ?? near;
    const f = clamp((left - 150) / 150, 0, 1);
    const path = f > 0.5 ? line : laneOf(line, P.lane);
    this.status = `AGENT · ${this.pin ? 'TO ' : this.needy(a) ? '' : 'VISITING '}${a.name.toUpperCase()} · ${Math.round(left)} M`;
    return { path, alt: P.alt + f * (P.high - P.alt), speed: P.speed + f * (P.fast - P.speed), land: true };
  }

  // for the HUD: what it is doing
  describe() {
    if (this.mode === 'off') return '';
    if (this.mode === 'cruise' || this.mode === 'turbo') {
      const k = this.game.kite;
      return `${MODE_NAMES[this.mode]} · ${districtSeedAt(k.pos.x, k.pos.z).en}`;
    }
    return this.status;
  }
}

// the route moved into the left lane (traffic keeps left: left of heading d is (d.z, -d.x)), but for its last
// stretch, which ends at the kerb already
function laneOf(line, off) {
  const out = [];
  const n = line.length;
  for (let i = 0; i < n; i++) {
    if (i >= n - 2) { out.push(line[i]); continue; }
    const a = line[Math.max(0, i - 1)], b = line[i], c = line[i + 1];
    const d1 = unit(i === 0 ? b : a, i === 0 ? c : b), d2 = unit(b, c);
    if (!d1 || !d2) { out.push(b); continue; }
    const n1 = { x: d1.z, z: -d1.x }, n2 = { x: d2.z, z: -d2.x };
    const dot = n1.x * n2.x + n1.z * n2.z, s = off / Math.max(0.5, 1 + dot);
    out.push({ x: b.x + (n1.x + n2.x) * s, z: b.z + (n1.z + n2.z) * s });
  }
  return out;
}

function unit(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
  return l < 0.01 ? null : { x: dx / l, z: dz / l };
}
