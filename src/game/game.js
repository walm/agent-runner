// Game flow: title, free ride, timed runs, shards, radio, and the overlays (pause, map, results).
import * as THREE from 'three/webgpu';
import { CITY, districtSeedAt, groundAt } from '../city/layout.js';
import { SKY_ALT } from '../life/skytraffic.js';
import { U } from '../core/shared.js';
import { esc } from '../core/esc.js';
import { Autopilot, MODES, MODE_NAMES } from './autopilot.js';

const DEG = 180 / Math.PI;
const bearingOf = (dx, dz) => ((Math.atan2(dx, -dz) * DEG) + 360) % 360;
const ZERO = { throttle: 0, steer: 0, lift: 0, boost: false };

const RADIO = {
  liftoff: ['KOWLOON CONTROL', 'Kite-nine, you are clear to the lanes. Keep left, keep lit.'],
  cloud: ['KOWLOON CONTROL', 'Cloud base five-two-zero. You are on instruments.'],
  above: ['NEON FM 88.1', 'Above the weather tonight? Lucky you. Here is something for the quiet up there.'],
  pad: ['ZENITH PAD', 'Touchdown, one-four-one-eight. Nice flying, Kite-nine.'],
  fast: ['KOWLOON CONTROL', 'Kite-nine, we read you over four hundred. Ease it off near the lanes.'],
  start: ['NEON FM 88.1', 'Rain all night over Kowloon, heavier after midnight. Stay dry, stay out of the lanes if you are not licensed.'],
  shardsAll: ['NEON FM 88.1', 'Somebody just lit up every shard in the city. We see you.'],
  district: {
    market: [['Night market is jammed, watch the minibuses on Temple Street.'], ['Dai pai dong on the corner still open. Of course it is.']],
    center: [['Glass towers, glass rain. Mind the downdrafts between them.'], ['Admiralty signal boards report all lanes green.']],
    estate: [['Estates on the ridge. Forty floors of windows, every one still lit.']],
    mixed: [['Old Kowloon. Low roofs, a lot of signs, a lot of wires.']],
    docks: [['Container cranes on the piers. Lights on, nobody home.']],
  },
};

const TOUR_ZENITH = [['Fifteen hundred metres of glass, with a landing pad near the top. Up there, the rain stops.'], ['The tallest thing in Kowloon, and the brightest. The pad at fourteen-eighteen is open all night.']];
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export class Game {
  constructor(o) {
    Object.assign(this, o); // city, kite, rig, camera, input, hud, screens, sound, visuals, runs, book, shards, settings, attract, agents, nav, touch
    this.waypointAgent = null; // the agent the waypoint leads to, if any
    this.nearAgent = null;
    this.state = 'loading';
    this.run = null;
    this.waypoint = null;
    this.seen = new Set();
    this.lastRadio = -1e9;
    this.clock = 0;
    this.prevPos = new THREE.Vector3();
    this.dir = new THREE.Vector3();
    try { this.collected = new Set(JSON.parse(localStorage.getItem('nz.shards') || '[]')); } catch { this.collected = new Set(); }
    this.visuals.setShards(this.shards, this.collected);
    this.visuals.setBeacons(this.runs, true);
    this.hud.setShards(this.collected.size, this.shards.length);
    this.flags = {};
    this.bot = null;
    this.stats = { hits: 0, hitSum: 0 };
    this.autopilot = new Autopilot(this);
    // the tour's stops: the district's name, and a word about it from the radio
    this.autopilot.onStop = (s) => {
      this.hud.toast(`TOUR · ${s.en}`, 'cyan');
      const pool = s.zenith ? TOUR_ZENITH : RADIO.district[s.type];
      const [line] = pool[Math.floor(Math.random() * pool.length)];
      this.radio(['TOUR · NEON FM 88.1', `${titleCase(s.en)}. ${line}`], true);
    };
  }

  // the autopilot's mode (autopilot.js); why: what the toast says
  setAutopilot(mode, why) {
    const ap = this.autopilot;
    if (mode === ap.mode) return;
    if (mode !== 'off' && this.run) return this.hud.toast('NO AUTOPILOT ON A RUN');
    ap.set(mode);
    this.hud.toast(mode === 'off' ? `AUTOPILOT OFF${why ? ` · ${why}` : ''}` : `AUTOPILOT · ${MODE_NAMES[mode]}`, mode === 'off' ? '' : 'cyan');
    this.hud.autopilot(mode, ap.describe());
    this.screens.updateAutopilot?.(mode);
    this.sound.ui();
  }

  cycleAutopilot() {
    this.setAutopilot(MODES[(MODES.indexOf(this.autopilot.mode) + 1) % MODES.length]);
  }

  // ---- flow ----
  title() {
    this.state = 'title';
    this.screens.atTitle = true;
    this.hud.show(false);
    this.screens.showTitle(true);
    // the title is a film of the city; the run markers are for the game
    this.visuals.showBeacons(false);
    this.attract.start();
  }

  startFree() {
    this.sound.start();
    this.sound.whoosh();
    this.attract.stop();
    this.screens.hideTitle();
    this.visuals.showBeacons(true);
    this.state = 'play';
    this.screens.atTitle = false;
    this.rig.snap = true;
    this.hud.show(!!this.settings.hud);
    this.hud.setHints(this.touch);
    this.flags.startT = this.clock;
  }

  pauseToggle(tab) {
    if (this.screens.open === 'pause') { this.screens.closePause(); this.sound.ui(); return; }
    if (this.screens.open) return;
    this.screens.inRun = !!this.run;
    this.screens.showPause(tab || 'menu');
    this.sound.ui();
  }

  mapToggle() {
    if (this.screens.open === 'map') { this.screens.closeMap(); return; }
    if (this.screens.open) return;
    this.screens.openMap(this.kite.pos);
    this.sound.ui();
  }

  setWaypoint(x, z) {
    if (this.waypoint && Math.hypot(this.waypoint.x - x, this.waypoint.z - z) < 40) this.waypoint = null;
    else this.waypoint = { x, z };
    this.sound.ui();
  }

  startRun(i) {
    this.setAutopilot('off');
    this.sound.start();
    if (this.state === 'title') this.startFree();
    this.screens.closePause();
    this.screens.closeResults();
    const r = this.runs[i];
    this.run = { i, def: r, gate: 0, t: 0, splits: [], best: this.book.splits(i), count: 3.6, deltaT: 0, delta: null };
    this.kite.place(r.start.x, r.start.y, r.start.z, r.yaw);
    this.rig.yaw = r.yaw;
    this.rig.snap = true;
    this.visuals.setGates(r);
    this.visuals.showBeacons(false);
    this.hud.setRun(r);
    this.hud.updateRun(0, 0, r.gates.length, null);
    this.state = 'countdown';
    this.sound.inRun = true;
    this.lastCount = null;
    this.sound.whoosh();
  }

  endRun() {
    this.run = null;
    this.visuals.setGates(null);
    this.visuals.showBeacons(true);
    this.hud.setRun(null);
    this.hud.countdown(null);
    this.sound.inRun = false;
    this.state = 'play';
  }

  finishRun() {
    const r = this.run;
    const t = r.t;
    const better = this.book.record(r.i, t, r.splits);
    const medal = this.book.medal(r.i, t);
    this.sound.fanfare(medal);
    this.screens.showResults(r.i, t, this.book.best(r.i), medal, better);
    this.endRun();
  }

  reset() {
    if (this.run) return this.startRun(this.run.i);
    // back down to the nearest street, facing along it
    const p = this.kite.pos;
    const lx = this.city.xs.reduce((a, l) => (Math.abs(l.p - p.x) < Math.abs(a.p - p.x) ? l : a));
    const lz = this.city.zs.reduce((a, l) => (Math.abs(l.p - p.z) < Math.abs(a.p - p.z) ? l : a));
    const alongX = Math.abs(lx.p - p.x) < Math.abs(lz.p - p.z);
    const x = alongX ? lx.p - 3.2 : THREE.MathUtils.clamp(p.x, -CITY.half + 30, CITY.half - 30);
    const z = alongX ? THREE.MathUtils.clamp(p.z, -CITY.half + 30, CITY.harbourZ - 40) : lz.p + 3.2;
    this.kite.place(x, 0, z, alongX ? 0 : Math.PI / 2);
    this.rig.snap = true;
    this.screens.closePause();
  }

  // back to the title from the menu: the run ends, and the car parks where the title film expects it
  quitToTitle() {
    this.setAutopilot('off');
    if (this.run) this.endRun();
    this.screens.closePause();
    this.kite.place(...this.attract.home);
    this.sound.ui();
    this.title();
  }

  // ---- per frame ----
  update(dt) {
    this.clock += dt;
    const k = this.kite;
    // polled every frame, menu or no menu: a gamepad's buttons are edges the poll detects, so without it Start
    // could open the menu but never close it (and never start the game from the title)
    const polled = this.input.poll();
    const actions = this.input.take();
    if (this.state === 'title') {
      this.attract.update(dt);
      for (const a of actions) if (a === 'confirm' || a === 'start') this.startFree();
      k.syncModel(dt);
      // the car is parked; the rain and the city follow the film's camera (only once a game has started the sound)
      const y = this.camera.position.y;
      this.sound.update(dt, { speed: 0, throttle: 0, boost: 0, air: false, alt: y, vy: 0, inCloud: U.inCloud.value, covered: false, parked: true });
      return;
    }
    if (this.state === 'loading') return;

    for (const a of actions) this.action(a);
    const overlay = this.screens.open;
    if (overlay === 'map') this.screens.drawMap(this.mapState());

    let c = overlay ? ZERO : polled;
    if (this.bot && !overlay) c = this.bot.controls(this);
    else if (this.autopilot.on && !overlay && this.state === 'play') {
      // the player's own hands on the controls take the car back
      if (Math.abs(c.throttle) > 0.15 || Math.abs(c.steer) > 0.15 || Math.abs(c.lift) > 0.15 || c.boost) this.setAutopilot('off', 'YOU HAVE CONTROL');
      else { c = this.autopilot.controls(dt); this.autopilot.tourTick(); }
    }
    if (this.state === 'countdown') {
      this.run.count -= dt;
      const n = Math.ceil(this.run.count - 0.6);
      if (n !== this.lastCount) {
        this.lastCount = n;
        if (n > 0) { this.hud.countdown(n); this.sound.beep(false); }
        else { this.hud.countdown('GO'); this.sound.beep(true); }
      }
      if (this.run.count <= 0) { this.state = 'run'; this.hud.countdown(null); }
      c = ZERO;
    }

    this.prevPos.copy(k.pos);
    if (!overlay) {
      k.update(dt, c);
      this.traffic.collide(k);
      this.skyTraffic.collide(k, U.time.value);
      // a moving car may have shoved it into something fixed: the fixed thing wins
      k.collide();
      this.rig.update(dt);
    } else k.syncModel(dt);

    for (const e of k.events) {
      if (e === 'liftoff') this.once('liftoff');
      else if (e.type === 'hit') { this.stats.hits++; this.stats.hitSum += e.strength; this.sound.impact(e.strength); this.hud.hit(Math.min(1, e.strength / 25)); }
      else if (e.type === 'land' && e.v > 6) this.sound.impact(e.v * 0.6);
    }
    k.events.length = 0;

    if (this.state === 'run') this.updateRun(dt);
    this.nav?.update(this.waypoint && !this.run ? this.waypoint : null, k.pos, k.fwd.x, k.fwd.z, performance.now(), dt);
    this.updateShards();
    this.updateWorldFlags();
    this.updateHud(dt, c);
    this.sound.update(dt, {
      speed: k.speed, throttle: c.throttle, boost: k.boosting ? 1 : 0, air: k.mode === 'air', alt: k.pos.y, vy: k.vel.y,
      inCloud: U.inCloud.value, covered: k.mode === 'ground' && k.pos.y > 0.5, paused: !!overlay,
    });
  }

  action(a) {
    const o = this.screens.open;
    if (a === 'start') a = 'pause'; // the gamepad's Start, in the game
    if (a === 'pause' && (o === 'agents' || o === 'terminal')) this.agents.close();
    else if (a === 'quit') { if (o === 'pause') this.quitToTitle(); }
    else if (a === 'pause') { if (o === 'map') this.screens.closeMap(); else if (o === 'results') this.screens.closeResults(); else this.pauseToggle(); }
    else if (a === 'map') this.mapToggle();
    else if (a === 'help') { if (!o) this.pauseToggle('controls'); }
    else if (o === 'results') { if (a === 'confirm') this.screens.closeResults(); else if (a === 'reset') { this.screens.closeResults(); this.startRun(this.screens.lastRun); } }
    else if (a === 'agents') { if (!o) this.agents?.toggleList(); }
    else if (a === 'autopilot') { if (!o || o === 'pause') this.cycleAutopilot(); }
    else if (o) return;
    else if (a === 'camera') this.rig.cycle();
    else if (a === 'reset') this.reset();
    else if (a === 'horn') this.sound.horn();
    else if (a === 'radio') {
      const on = this.sound.toggleRadio(), t = this.music?.current;
      this.hud.toast(on ? `RADIO ON · ${t && t.category !== 'neon fm' ? esc(t.title.toUpperCase()) : 'NEON FM 88.1'}` : 'RADIO OFF');
      this.screens.updateRadio();
    }
    else if (a === 'next') { if (this.music && !this.music.next()) this.hud.toast('NEON FM IS LIVE · PICK THE LIBRARY IN RADIO'); }
    else if (a === 'confirm' && this.nearRun !== null && this.nearRun !== undefined && !this.run) this.startRun(this.nearRun);
    else if (a === 'confirm' && this.nearAgent && !this.run) this.agents.openTerminal(this.nearAgent.agent.id);
  }

  updateRun(dt) {
    const r = this.run, d = r.def, k = this.kite;
    r.t += dt;
    const g = d.gates[r.gate];
    const last = r.gate === d.gates.length - 1;
    let passed = false;
    if (last && d.land) {
      passed = k.mode === 'ground' && Math.abs(k.pos.y - g.y) < 3 && Math.hypot(k.pos.x - g.x, k.pos.z - g.z) < 8;
    } else {
      // closest approach of this frame's motion to the gate centre, so fast passes still count
      const ab = this.dir.subVectors(k.pos, this.prevPos);
      const L2 = ab.lengthSq();
      const tt = L2 > 1e-6 ? THREE.MathUtils.clamp(((g.x - this.prevPos.x) * ab.x + (g.y - this.prevPos.y) * ab.y + (g.z - this.prevPos.z) * ab.z) / L2, 0, 1) : 0;
      const cx = this.prevPos.x + ab.x * tt, cy = this.prevPos.y + ab.y * tt, cz = this.prevPos.z + ab.z * tt;
      passed = (cx - g.x) ** 2 + (cy - g.y) ** 2 + (cz - g.z) ** 2 < d.radius * d.radius;
    }
    if (passed) {
      r.splits.push(r.t);
      if (r.best && r.best[r.gate] !== undefined) { r.delta = r.t - r.best[r.gate]; r.deltaT = 3; }
      r.gate++;
      this.visuals.gateState.value = r.gate;
      this.sound.chime(r.gate - 1, d.gates.length);
      if (r.gate >= d.gates.length) return this.finishRun();
    }
    r.deltaT -= dt;
    this.hud.updateRun(r.t, r.gate, d.gates.length, r.deltaT > 0 ? r.delta : null);
  }

  updateShards() {
    const p = this.kite.pos;
    for (let i = 0; i < this.shards.length; i++) {
      if (this.collected.has(i)) continue;
      const s = this.shards[i];
      if ((s.x - p.x) ** 2 + (s.y - p.y - 0.6) ** 2 + (s.z - p.z) ** 2 < 3.4 * 3.4) {
        this.collected.add(i);
        this.visuals.collectShard(i);
        this.sound.shard();
        const n = this.collected.size, N = this.shards.length;
        this.hud.setShards(n, N);
        this.hud.toast(`SHARD ${n} / ${N}`, 'mag');
        try { localStorage.setItem('nz.shards', JSON.stringify([...this.collected])); } catch {}
        if (n === N) { this.hud.toast('THE CITY IS LIT', 'big mag'); this.radio(RADIO.shardsAll, true); }
      }
    }
  }

  once(key) {
    if (this.flags[key]) return;
    this.flags[key] = true;
    this.radio(key === 'start' ? this.welcome() : RADIO[key], true);
    if (key === 'start') this.onWelcome?.();
  }

  // the radio's first words on the first ride: who is on shift, who needs you, then the weather
  welcome() {
    const on = [...(this.agents?.feed.agents.values() || [])].filter((a) => a.status !== 'offline');
    const n = on.length, need = on.filter((a) => a.status === 'waiting' || a.status === 'error').length;
    let t = 'Welcome to Agent Runner. ';
    if (!n) t += 'The city is quiet today: no agents on shift yet.';
    else if (n >= 3) t += `Today we have a packed schedule: ${words(n)} agents working hard.`;
    else t += `Today we have ${words(n)} agent${n > 1 ? 's' : ''} working hard.`;
    if (need) t += n === 1 ? ' It needs you.' : ` ${words(need, true)} of them need${need === 1 ? 's' : ''} you.`;
    return [RADIO.start[0], `${t} ${RADIO.start[1]}`];
  }

  radio(line, force) {
    if (!force && this.clock - this.lastRadio < 30) return;
    this.lastRadio = this.clock;
    this.hud.radio(line[0], line[1]);
    this.onRadioLine?.(line[0], line[1]); // NEON FM's own chatter: the radio voice reads it
  }

  updateWorldFlags() {
    const k = this.kite;
    // the welcome waits (up to 20 s) for the agent list, and for the voice when it will be read
    if (this.state === 'play' && this.flags.startT !== undefined && this.clock - this.flags.startT > 4 && (this.welcomeReady?.() !== false || this.clock - this.flags.startT > 20)) { this.once('start'); }
    if (k.pos.y > CITY.cloudBase && k.pos.y < CITY.cloudTop) this.once('cloud');
    if (k.pos.y > CITY.cloudTop + 40) this.once('above');
    if (k.mode === 'ground' && k.pos.y > CITY.zenith.pad - 2 && Math.hypot(k.pos.x, k.pos.z) < 30) this.once('pad');
    if (k.speed * 3.6 > 400) this.once('fast');
    // first visit to a district: maybe a word from the radio
    const d = this.district;
    if (d && !this.seen.has(d.en)) {
      this.seen.add(d.en);
      const pool = RADIO.district[d.type];
      if (pool && this.seen.size > 1 && Math.random() < 0.6) {
        const [en] = pool[Math.floor(Math.random() * pool.length)];
        this.radio(['NEON FM 88.1', en]);
      }
    }
    // run beacons: drive into one to be offered the run
    this.nearRun = null;
    if (!this.run && this.state === 'play') {
      this.runs.forEach((r, i) => {
        if (Math.hypot(k.pos.x - r.start.x, k.pos.z - r.start.z) < 12 && Math.abs(k.pos.y - r.start.y) < 10) this.nearRun = i;
      });
    }
    // parked at an agent's door, or in its beam: offer its terminal (a run beacon on the same spot wins)
    this.nearAgent = this.agents && !this.run && this.state === 'play' && this.nearRun === null ? this.agents.nearest(k.pos) : null;
    if (this.agents) this.agents.near = this.nearAgent;
    this.hud.prompt(this.nearRun !== null ? `<span class="key">${this.touch ? 'TAP' : 'ENTER'}</span>START ${this.runs[this.nearRun].en}`
      : this.nearAgent ? this.agents.prompt(this.touch) : null);
  }

  updateHud(dt, c) {
    const k = this.kite, cam = this.camera;
    if (this.autopilot.on && (this.apShown = (this.apShown || 0) + dt) > 0.25) { this.apShown = 0; this.hud.autopilot(this.autopilot.mode, this.autopilot.describe()); }
    cam.getWorldDirection(this.dir);
    const bearing = bearingOf(this.dir.x, this.dir.z);
    this.district = districtSeedAt(k.pos.x, k.pos.z);
    const markers = [], mapMarkers = [];
    if (this.run) {
      const d = this.run.def;
      for (let i = this.run.gate; i < d.gates.length; i++) {
        const g = d.gates[i];
        mapMarkers.push({ x: g.x, z: g.z, color: i === this.run.gate ? '#ff3df2' : 'rgba(59,232,255,0.6)', shape: 'ring', pin: i === this.run.gate });
      }
      const g = d.gates[this.run.gate];
      if (g) markers.push({ bearing: bearingOf(g.x - k.pos.x, g.z - k.pos.z), color: '#ff3df2' });
    } else {
      this.runs.forEach((r) => {
        mapMarkers.push({ x: r.start.x, z: r.start.z, color: '#ffb547', shape: 'dot', pin: false });
        if (Math.hypot(r.start.x - k.pos.x, r.start.z - k.pos.z) < 900) markers.push({ bearing: bearingOf(r.start.x - k.pos.x, r.start.z - k.pos.z), color: '#ffb547' });
      });
    }
    if (this.agents && !this.run) {
      const am = this.agents.markers(k.pos, bearingOf);
      markers.push(...am.hud);
      mapMarkers.push(...am.map);
    }
    if (this.waypoint) {
      mapMarkers.push({ x: this.waypoint.x, z: this.waypoint.z, color: '#3be8ff', shape: 'ring', pin: true });
      markers.push({ bearing: bearingOf(this.waypoint.x - k.pos.x, this.waypoint.z - k.pos.z), color: '#3be8ff' });
      if (Math.hypot(this.waypoint.x - k.pos.x, this.waypoint.z - k.pos.z) < 25) { this.waypoint = null; this.hud.toast('WAYPOINT REACHED', 'cyan'); }
    }
    this.shards.forEach((s, i) => {
      if (!this.collected.has(i) && Math.hypot(s.x - k.pos.x, s.z - k.pos.z) < 160) mapMarkers.push({ x: s.x, z: s.z, color: '#ff3df2', shape: 'gem' });
    });
    // lane: on a sky-lane altitude over an avenue
    let lane = null;
    if (k.mode === 'air') {
      for (const a of [...SKY_ALT.z, ...SKY_ALT.x]) if (Math.abs(k.pos.y - a) < 7) lane = a;
    }
    this.hud.update({
      speed: k.speed, boost: k.boosting ? 1 : Math.min(1, k.boostHeat || 0), mode: k.mode, lane, district: this.district,
      bearing, heading: -bearing / DEG, x: k.pos.x, z: k.pos.z, alt: k.pos.y, groundY: groundAt(this.city, k.pos.x, k.pos.z, k.pos.y), vy: k.vel.y,
      markers, mapMarkers, route: this.nav?.line(),
    }, dt);
  }

  mapState() {
    const markers = [];
    this.runs.forEach((r, i) => markers.push({ x: r.start.x, z: r.start.z, color: '#ffb547', shape: 'dot', label: `${String(i + 1).padStart(2, '0')} ${r.en}` }));
    this.shards.forEach((s, i) => markers.push({ x: s.x, z: s.z, color: '#ff3df2', shape: 'gem', dim: this.collected.has(i) }));
    if (this.agents) markers.push(...this.agents.mapMarkers());
    if (this.waypoint) markers.push({ x: this.waypoint.x, z: this.waypoint.z, color: '#3be8ff', shape: 'ring' });
    if (this.run) this.run.def.gates.slice(this.run.gate).forEach((g) => markers.push({ x: g.x, z: g.z, color: '#ff3df2', shape: 'ring' }));
    this.camera.getWorldDirection(this.dir);
    return { markers, route: this.nav?.line(), player: { x: this.kite.pos.x, z: this.kite.pos.z, bearing: Math.atan2(this.dir.x, -this.dir.z) } };
  }
}

// a count as it reads aloud
const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
function words(n, capital = false) {
  const w = NUMBERS[n] || String(n);
  return capital ? w[0].toUpperCase() + w.slice(1) : w;
}
