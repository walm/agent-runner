// VR mode (WebXR: the Meta Quest browser, or a PC headset in Chrome). ENTER VR puts you in the KITE's seat, or on a
// chase seat behind it, with the Touch controllers driving. The DOM cannot show in a headset, so the HUD
// essentials, the agents list, the terminal and the name tags become objects in the world (panels.js, tags.js).
//
// The screen-space post chain does not run in a headset (three switches XR off inside it), so the scene is drawn
// straight to the eyes with the renderer's own tone mapping; the ground's planar reflection is screen-space too and
// is switched off. On the Quest, WebXR needs the WebGL backend: main.js picks it when a headset is there.
import * as THREE from 'three/webgpu';
import { Dash, ListPanel, TermPanel, Notice, TERM_SIZE } from './panels.js';
import { VRTags } from './tags.js';
import { styleOf } from '../agents/visuals.js';
import './xr.css';

// where the head sits, in the car's frame (x right, y up, -z ahead); 'local' space puts the head at the origin
const SEATS = { seat: new THREE.Vector3(0, 1.3, 0.1), chase: new THREE.Vector3(0, 3.1, 8.5) };
const DZ = 0.15; // stick dead zone
// What each VR DETAIL setting keeps of the city (main.js applies it; null is the whole city, as on the screen):
//   scale     share of the headset's recommended resolution
//   kitNear   metres of modelled facades, all at the low level of detail when lod0 is 0
//   shopNear  metres of modelled shopfronts
//   props     Temple Street's props: their level-of-detail distances and their end, as a share
//   carLod    metres of full-detail traffic
//   far       the far plane at street level; it grows with altitude
//   probe     frames per face of the car's reflection cube (each face is another view of the city)
//   cull      the small props' cull distances (lamps, awnings, roof clutter), as a share
//   signs     metres of neon signs and ad screens
const TIERS = {
  low: { scale: 0.75, kitNear: 0, lod0: 0, shopNear: 40, props: 0.35, carLod: 25, rain: 0.3, far: 1500, probe: 8, cull: 0.35, signs: 450, liteCar: true },
  medium: { scale: 0.9, kitNear: 60, lod0: 0, shopNear: 70, props: 0.6, carLod: 45, rain: 0.45, far: 2000, probe: 4, cull: 0.6, signs: 900, liteCar: true },
  high: null,
};
// A standalone headset (a phone-class GPU drawing two eyes at 72-90 Hz) starts on LOW, a PC headset on HIGH.
// ?vr=low|medium|high overrides the setting.
const PARAM = new URLSearchParams(location.search).get('vr');
const STANDALONE = /OculusBrowser|Quest|Pico|Wolvic/i.test(navigator.userAgent);
export function vrTier(setting) {
  const t = PARAM in TIERS ? PARAM : setting in TIERS ? setting : STANDALONE ? 'low' : 'high';
  return { name: t, cfg: TIERS[t] };
}

export async function vrSupported() {
  try { return !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr')); } catch { return false; }
}

const dz = (v) => (Math.abs(v) < DZ ? 0 : (v - Math.sign(v) * DZ) / (1 - DZ));

export class VRMode {
  // profile(tier): main.js trims the city to a tier of TIERS, or puts it back as it was (null)
  constructor({ renderer, scene, camera, ui, kite, rig, input, hud, ground, post, settings, profile }) {
    Object.assign(this, { renderer, scene, camera, kite, rig, input, hud, ground, post, settings, profile });
    this.tier = null; // the TIERS entry in use while presenting
    this.frames = 0;
    this.fps = 0;
    this.lastNow = 0;
    this.game = null;
    this.agents = null;
    this.view = 'seat';
    this.presenting = false;
    this.session = null;

    // the seat follows the car's position and heading, never its pitch or roll: the horizon stays level
    this.seat = new THREE.Group();
    this.seat.name = 'vr-seat';
    this.seat.visible = false;
    scene.add(this.seat);
    // a stand-in for the head in world space, for everything that reads camera.position (sky, culling, streaming)
    this.head = new THREE.PerspectiveCamera();
    this.head.matrixAutoUpdate = false;

    this.dash = new Dash();
    this.list = new ListPanel();
    this.term = new TermPanel();
    this.panels = new THREE.Group();
    this.panels.add(this.dash.mesh, this.list.mesh, this.term.mesh);
    this.seat.add(this.panels);
    this.tags = new VRTags();
    scene.add(this.tags.group);
    this.place();

    // what the headset shows while the city's shaders build for it: a notice in the dark, where the seat is
    this.warming = false;
    this.loadScene = new THREE.Scene();
    this.loadScene.background = new THREE.Color(0x020308);
    this.loadRoom = new THREE.Group();
    this.loadRoom.matrixAutoUpdate = false;
    this.notice = new Notice();
    this.notice.mesh.position.set(0, 0, -1.6);
    this.notice.show(true);
    this.notice.set('ENTERING THE CITY', 'BUILDING SHADERS FOR THE HEADSET');
    this.loadRoom.add(this.notice.mesh);
    this.loadScene.add(this.loadRoom);

    this.prev = { L: [], R: [] };
    this.repeat = 0;
    this.held = false;
    this.scroll = 0;
    this.tagSync = 0;

    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local');
    renderer.xr.setFoveation(1);

    this.button = document.createElement('button');
    this.button.className = 'btn xr-btn hidden';
    this.button.textContent = 'ENTER VR';
    this.button.addEventListener('click', () => this.toggle());
    ui.appendChild(this.button);
    vrSupported().then((ok) => this.button.classList.toggle('hidden', !ok));

    hud.onToast = (text, cls) => { if (this.presenting) this.dash.message(text, cls); };
  }

  bind(game, agents) {
    this.game = game;
    this.agents = agents;
  }

  // panels in the seat's frame: the dash low and tilted up, the list and terminal at reading distance
  place() {
    // behind the car the dash drops lower and nearer, under the car rather than over it
    const seat = this.view === 'seat';
    this.dash.mesh.position.set(0, seat ? -0.36 : -0.5, seat ? -0.62 : -0.5);
    this.dash.mesh.rotation.x = seat ? -0.6 : -0.9;
    this.list.mesh.position.set(0, -0.05, -1.3);
    this.term.mesh.position.set(0, 0, -1.45);
  }

  async toggle() {
    if (this.session) { this.session.end(); return; }
    let session;
    try {
      session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['layers'] });
    } catch (e) {
      console.warn('VR: no session', e);
      this.hud.toast('VR NOT AVAILABLE', 'mag');
      return;
    }
    this.session = session;
    session.addEventListener('end', () => this.exit());
    const tier = vrTier(this.settings.vrDetail);
    this.tier = tier.cfg;
    // the resolution is fixed when the session's layer is made
    this.renderer.xr.setFramebufferScaleFactor(tier.cfg ? tier.cfg.scale : 1);
    // the frame loop starts inside setSession: show the notice until the stereo shaders are built
    this.warming = true;
    try {
      await this.renderer.xr.setSession(session);
    } catch (e) {
      console.warn('VR: could not start', e);
      this.warming = false;
      session.end();
      return;
    }
    const t0 = performance.now();
    await this.enter();
    await this.warm();
    console.info(`VR: ${tier.name} detail, multiview ${this.renderer.xr.useMultiview()}, ready in ${Math.round(performance.now() - t0)} ms`);
    if (this.session === session) this.warming = false;
  }

  // Drawing to the headset (two eyes, its own framebuffer) needs its own variant of every pipeline. Built on first
  // sight they would freeze the headset for many seconds, so they are compiled here in the background, with
  // everything shown and unculled for the moment compileAsync collects the scene (that part is synchronous).
  warm() {
    const touched = [];
    this.tags.sync(this.agents.entries.values());
    this.scene.traverse((o) => {
      if (o.isMesh || o.isGroup || o.isSprite) touched.push([o, o.visible, o.frustumCulled]);
      if (o.isMesh || o.isSprite) o.frustumCulled = false;
      o.visible = true;
    });
    const job = this.renderer.compileAsync(this.scene, this.camera);
    for (const [o, v, f] of touched) { o.visible = v; o.frustumCulled = f; }
    return job.catch((e) => console.warn('VR: warm-up', e));
  }

  // faces of the car's reflection cube to redraw this frame: each one is a whole extra view of the city
  probeFaces() {
    this.frames++;
    return !this.tier ? 2 : this.frames % this.tier.probe === 0 ? 1 : 0;
  }

  // the frame's draw: the notice while warming, else the city
  render() {
    if (this.warming) {
      this.loadRoom.matrix.copy(this.seat.matrixWorld);
      this.loadRoom.matrixWorldNeedsUpdate = true;
      this.renderer.render(this.loadScene, this.camera);
    } else this.renderer.render(this.scene, this.camera);
  }

  async enter() {
    const g = this.game;
    this.presenting = true;
    this.button.textContent = 'EXIT VR';
    // menus are DOM: close what is open and start driving
    if (g.screens.open === 'pause') g.screens.closePause();
    if (g.screens.open === 'map') g.screens.closeMap();
    if (g.screens.open === 'results') g.screens.closeResults();
    if (g.state === 'title') g.startFree();
    this.rig.xr = true;
    this.agents.inVR = true;
    this.agents.term.fixed = TERM_SIZE;
    this.agents.term.fit();
    this.seat.add(this.camera);
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.identity();
    this.seat.visible = true;
    this.tags.group.visible = true;
    this.dash.show(true);
    this.ground.uReflOn.value = 0;
    this.profile(this.tier);
    if (this.tier?.liteCar) await this.kite.model.userData.setLite(true);
    this.dash.message('WELCOME TO THE CITY · X FOR AGENTS', 'cyan');
  }

  exit() {
    this.session = null;
    this.presenting = false;
    this.button.textContent = 'ENTER VR';
    this.camera.removeFromParent(); // the chase rig places it in world space again from the next frame
    this.rig.xr = false;
    this.renderer.toneMappingExposure = 1;
    if (this.tier) {
      this.profile(null);
      if (this.tier.liteCar) this.kite.model.userData.setLite(false);
      this.tier = null;
    }
    this.rig.snap = true;
    this.agents.inVR = false;
    this.agents.term.fixed = null;
    this.agents.term.fit();
    this.seat.visible = false;
    this.tags.group.visible = false;
    for (const p of [this.dash, this.list, this.term]) p.show(false);
    Object.assign(this.input.xr, { throttle: 0, steer: 0, lift: 0, boost: false });
  }

  // ---- per frame, before the game: the controllers ----
  poll(dt) {
    if (!this.presenting) return;
    let L = null, R = null;
    for (const s of this.session.inputSources) {
      if (!s.gamepad) continue;
      if (s.handedness === 'left') L = s.gamepad;
      else if (s.handedness === 'right') R = s.gamepad;
    }
    const b = (p, i) => (p?.buttons[i]?.value || 0);
    const ax = (p, i) => dz(p?.axes[i] || 0);
    const edge = (side, p, i) => {
      const on = b(p, i) > 0.5, was = this.prev[side][i];
      this.prev[side][i] = on;
      return on && !was;
    };
    // xr-standard: 0 trigger, 1 grip, 3 stick press, 4 A/X, 5 B/Y; axes 2/3 the stick
    const A = edge('R', R, 4), B = edge('R', R, 5), X = edge('L', L, 4), Y = edge('L', L, 5), trig = edge('R', R, 0), horn = edge('R', R, 3);
    const open = this.agents.open;
    const rsy = ax(R, 3);

    const c = this.input.xr;
    c.throttle = b(R, 0) - b(L, 0) || -ax(L, 3);
    c.steer = ax(L, 2);
    c.lift = -rsy;
    c.boost = b(L, 1) > 0.5 || b(R, 1) > 0.5;

    if (open === 'agents') {
      // hold the stick to keep moving down the list
      const sy = Math.abs(rsy) > Math.abs(ax(L, 3)) ? rsy : ax(L, 3);
      if (Math.abs(sy) < 0.5) this.held = false;
      else if (!this.held || (this.repeat -= dt) <= 0) {
        this.agents.panel.move(sy > 0 ? 1 : -1);
        this.repeat = this.held ? 0.12 : 0.4; // a pause after the first step, then quick steps
        this.held = true;
        this.list.key = null;
      }
      const id = this.agents.panel.selected();
      if (A && id) this.agents.drive(id);
      else if (trig && id) this.agents.warp(id);
      else if (B || X) this.agents.close();
    } else if (open === 'terminal') {
      // scroll: lines per second grow with the push
      this.scroll += rsy * Math.abs(rsy) * 40 * dt;
      const n = Math.trunc(this.scroll);
      if (n) { this.agents.term.term?.scrollLines(n); this.scroll -= n; }
      if (A || B) this.agents.close();
      else if (X) { this.agents.close(); this.agents.toggleList(); }
    } else {
      this.scroll = 0;
      if (A) this.input.queue.push('confirm');
      if (X) this.input.queue.push('agents');
      if (Y) { this.view = this.view === 'seat' ? 'chase' : 'seat'; this.place(); }
      if (horn) this.input.queue.push('horn');
    }
    if (open) { c.throttle = 0; c.steer = 0; c.lift = 0; c.boost = false; }
  }

  // ---- per frame, after the game: the seat, the head, the panels ----
  update(dt, now) {
    if (!this.presenting) return null;
    // the game's dt is capped at 50 ms; the dash's frame rate is not
    const ms = now - this.lastNow;
    this.lastNow = now;
    if (ms > 0 && ms < 1000) this.fps += (1000 / ms - this.fps) * 0.05;
    const k = this.kite, s = SEATS[this.view];
    const cy = Math.cos(k.yaw), sy = Math.sin(k.yaw);
    this.seat.position.set(k.pos.x + s.x * cy + s.z * sy, k.pos.y + s.y, k.pos.z - s.x * sy + s.z * cy);
    this.seat.rotation.set(0, k.yaw, 0);
    this.seat.updateMatrixWorld(true);
    // the head pose for this frame, in world space
    const xr = this.renderer.xr;
    xr.updateCamera(this.camera);
    const xc = xr.getCamera();
    this.head.matrixWorld.copy(xc.matrixWorld);
    this.head.matrix.copy(xc.matrixWorld);
    this.head.matrixWorldInverse.copy(xc.matrixWorld).invert();
    this.head.matrix.decompose(this.head.position, this.head.quaternion, this.head.scale);
    this.head.projectionMatrix.copy(xc.projectionMatrix);
    this.head.projectionMatrixInverse.copy(xc.projectionMatrixInverse);
    // the haze hides the far city at street level, less so up high, so the far plane grows with altitude
    if (this.tier) {
      const far = Math.min(12000, this.tier.far + Math.round(Math.max(0, k.pos.y) / 25) * 250);
      if (far !== this.camera.far) { this.camera.far = far; this.camera.updateProjectionMatrix(); }
    }
    this.head.near = this.camera.near;
    this.head.far = this.camera.far;
    this.head.layers.mask = this.camera.layers.mask;
    // the renderer's tone mapping stands in for the post chain's: a touch brighter for the bloom it lacks
    const P = this.post.params;
    this.renderer.toneMappingExposure = P.exposure.value * P.fade.value * 1.2;

    const t = now / 1000, a = this.agents;
    this.tagSync -= dt;
    if (this.tagSync <= 0) { this.tags.sync(a.entries.values()); this.tagSync = 0.5; }
    this.tags.update(this.head.position, t);

    const open = a.open;
    this.list.show(open === 'agents');
    this.term.show(open === 'terminal');
    this.dash.show(!open);
    if (open === 'agents') this.list.update(t, { order: a.panel.order, sel: a.panel.sel, entries: a.entries, connected: a.feed.connected });
    else if (open === 'terminal') this.term.update(t, a.term, a.entries.get(a.term.id)?.agent);
    else this.dash.update(t, this.dashState());
    return this.head;
  }

  dashState() {
    const k = this.kite, g = this.game, a = this.agents;
    let need = 0;
    for (const { agent } of a.entries.values()) if (agent.status === 'waiting' || agent.status === 'error') need++;
    let target = null;
    if (g.waypoint) {
      const dx = g.waypoint.x - k.pos.x, dz = g.waypoint.z - k.pos.z;
      // bearing of the waypoint against the car's nose (-z rotated by yaw), clockwise on the dash
      let rel = Math.atan2(-dx, -dz) - k.yaw;
      rel = -Math.atan2(Math.sin(rel), Math.cos(rel));
      const e = g.waypointAgent && a.entries.get(g.waypointAgent);
      target = { name: e ? e.agent.name : 'WAYPOINT', dist: Math.hypot(dx, dz), rel, color: e ? styleOf(e.agent.status).css : '#3be8ff' };
    }
    let prompt = null;
    if (g.nearRun !== null && g.nearRun !== undefined) prompt = `A  START ${g.runs[g.nearRun].en}`;
    else if (a.near) prompt = `A  OPEN TERMINAL · ${a.near.agent.name}`;
    return { speed: k.speed, alt: k.pos.y, mode: k.mode, agents: a.entries.size, need, linked: a.feed.connected, target, prompt, view: this.view, fps: Math.round(this.fps) };
  }
}
