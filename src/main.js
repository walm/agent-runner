import './core/yield.js';
import * as THREE from 'three/webgpu';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { U, loadTex, loadArray } from './core/shared.js';
import { createPost } from './core/post.js';
import { Governor } from './core/governor.js';
import { generateCity, CITY } from './city/layout.js';
import { buildLightmap } from './city/lightmap.js';
import { createBuildings } from './city/buildings.js';
import FAC from './city/facades.json';
import { createGround, LAYER_NOREFL, LAYER_KIT } from './city/ground.js';
import { loadFacadeKits, createFacadeKit } from './city/facadekit.js';
import { loadShopKit, createShopKit } from './city/shopkit.js';
import { loadDistrict, createDistrict, groundUV, insideRegion, EXPO } from './city/district.js';
import { createSky } from './atmos/sky.js';
import { createClouds } from './atmos/clouds.js';
import { installFog } from './atmos/fog.js';
import { FlyCam } from './debug/flycam.js';
import { createSigns } from './city/signs.js';
import { createAdScreens, drawAdAtlas, loadAdFonts, createAviationLights } from './city/adscreens.js';
import { createProps } from './city/props.js';
import { createZenith } from './city/zenith.js';
import './ui/base.css';
import './ui/ui.css';
import { Hud } from './ui/hud.js';
import { Screens } from './ui/screens.js';
import { drawCityMap } from './ui/citymap.js';
import { createTouch, isTouch } from './ui/touch.js';
import { Sound } from './audio/audio.js';
import { Voice } from './audio/voice.js';
import { MusicPlayer } from './audio/music.js';
import { Lightning } from './atmos/lightning.js';
import { buildRuns, buildShards, RunVisuals, RunBook } from './game/runs.js';
import { Game } from './game/game.js';
import { Attract } from './game/attract.js';
import { Bot } from './debug/bot.js';
import { cullChunks } from './city/instancing.js';
import { createKiteModel, createReflectionProbe } from './vehicle/model.js';
import { Kite } from './vehicle/kite.js';
import { CameraRig } from './vehicle/camera.js';
import { Input } from './core/input.js';
import { buildHeightmap } from './city/heightmap.js';
import { createRain } from './atmos/rain.js';
import { Traffic } from './life/traffic.js';
import { SkyTraffic } from './life/skytraffic.js';
import { AgentLayer } from './agents/agents.js';
import { VRMode, vrSupported } from './xr/vr.js';
import { Nav } from './game/nav.js';
import { NavVisuals } from './game/navvis.js';

const params = new URLSearchParams(location.search);
const WARM_STALL_MS = 8000; // the boot stops waiting for its shader warm-up once nothing has compiled for this long

const DEFAULTS = { quality: 'auto', rain: 1, traffic: 1, vrDetail: 'auto', voice: 0, agentVoice: 1, radioVoice: 1, volume: 0.8, background: 1, music: 0.6, voiceVolume: 1, radioSource: 'neonfm', radioCategory: 'all', radioDj: 1, fov: 60, hud: 1, shake: 1 };
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('nz.settings') || '{}') }; } catch { return { ...DEFAULTS }; }
}

const ui = document.getElementById('ui');
ui.insertAdjacentHTML('beforeend', `<div id="fade"></div><div id="loader"><div class="lw">
  <div class="lt"><b>AGENT RUNNER</b></div><div class="bar"><i></i></div><div class="st">BOOTING</div></div></div>`);
const loaderBar = ui.querySelector('#loader .bar i'), loaderSt = ui.querySelector('#loader .st');
function progress(f, text) {
  loaderBar.style.width = `${Math.round(f * 100)}%`;
  loaderSt.textContent = text;
  return new Promise((r) => requestAnimationFrame(() => r()));
}

async function loadTextures() {
  const [roadAlbedo, roadNormal, roadRao, walkAlbedo, walkNormal, walkRao, concreteAlbedo, shutterAlbedo, signs, facAlbedo, facMask, facNormal, shopAlbedo, shopMask] = await Promise.all([
    loadTex('/tex/road_albedo.webp', { srgb: true }),
    loadTex('/tex/road_normal.webp'),
    loadTex('/tex/road_rao.webp'),
    loadTex('/tex/walk_albedo.webp', { srgb: true }),
    loadTex('/tex/walk_normal.webp'),
    loadTex('/tex/walk_rao.webp'),
    loadTex('/tex/concrete_albedo.webp', { srgb: true }),
    loadTex('/tex/shutter_albedo.webp', { srgb: true }),
    loadTex('/tex/signs.webp', { srgb: true, repeat: false }),
    loadArray('/tex/facade_albedo.webp', FAC.size, { srgb: true }),
    loadArray('/tex/facade_mask.webp', FAC.maskSize),
    loadArray('/tex/facade_normal.webp', FAC.normalSize),
    loadTex('/tex/shop_albedo.webp', { srgb: true }),
    loadTex('/tex/shop_mask.webp'),
  ]);
  const env = await new HDRLoader().loadAsync('/tex/env_night.hdr');
  env.mapping = THREE.EquirectangularReflectionMapping;
  // the panorama's lamps peak at ~20000 against a p99.9 of ~47; a smooth pane mirrors such a texel as a white flare,
  // so they are capped (half floats of positive values order like their bits)
  const cap = THREE.DataUtils.toHalfFloat(64);
  const d = env.image.data;
  for (let i = 0; i < d.length; i++) if ((i & 3) !== 3 && (d[i] & 0x7fff) > cap) d[i] = d[i] & 0x8000 ? 0 : cap;
  const facades = { albedo: facAlbedo, mask: facMask, normal: facNormal };
  return { roadAlbedo, roadNormal, roadRao, walkAlbedo, walkNormal, walkRao, concreteAlbedo, shutterAlbedo, signs, env, facades, shopAlbedo, shopMask };
}

async function boot() {
  const canvas = document.getElementById('gl');
  // ?xremu (dev only): an emulated Quest 3 (Meta's IWER), to try VR without a headset
  if (import.meta.env.DEV && params.has('xremu')) {
    const { XRDevice, metaQuest3 } = await import('iwer');
    const device = new XRDevice(metaQuest3);
    device.installRuntime({ forceInstall: true });
    window.__xrdevice = device;
  }
  // WebXR over WebGPU needs XRGPUBinding, which no headset browser ships yet: with a headset there, use WebGL.
  // A headset draws without the post chain (and its FXAA), so the canvas gets MSAA instead.
  const webxr = !params.has('flat') && (await vrSupported());
  const webgpu = !!navigator.gpu && !params.has('webgl') && !(webxr && typeof XRGPUBinding === 'undefined');
  // multiview draws both eyes in one pass (OVR_multiview2, on the Quest); ?nomv turns it off
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: webxr, multiview: webxr && !params.has('nomv'), powerPreference: 'high-performance', reversedDepthBuffer: webgpu, forceWebGL: !webgpu });
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  await renderer.init();
  // which graphics API this page got, for anyone looking in before boot is done (the desktop app's diagnostics)
  window.__nzBoot = { backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl', webxr };
  // the emulator's XR framebuffer is null (the canvas itself), which three's WebGL state cannot use as a WeakMap key
  if (import.meta.env.DEV && window.__xrdevice && renderer.backend.state) renderer.backend.state.currentDrawbuffers = new Map();
  await progress(0.08, 'LOADING TEXTURES');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.25, 12000);
  camera.layers.enable(LAYER_NOREFL);
  camera.layers.enable(LAYER_KIT);

  const [tex, city, kits, shopKitData, districtData] = await Promise.all([loadTextures(), Promise.resolve(generateCity()), loadFacadeKits(), loadShopKit(), loadDistrict(renderer, { small: isTouch() })]);
  scene.environment = tex.env;
  scene.environmentIntensity = 0.1;
  scene.environmentRotation.y = 1.2;

  await progress(0.3, 'RAISING THE CITY');
  const lightmap = buildLightmap(city);
  // inside Temple Street the light at street level is Blender's; the consumers scale this map by ~2.4 against albedo
  lightmap.district = { ground: districtData.ground, uv: groundUV, inside: insideRegion, scale: EXPO / 2.4 };
  installFog(scene, lightmap);

  const sky = createSky();
  scene.add(sky.mesh);
  const clouds = createClouds(lightmap);
  scene.add(clouds.group);
  const buildings = createBuildings(city, tex, lightmap, tex.facades, new Set(kits.map((k) => k.meta.layer)));
  scene.add(buildings.group);
  const facadeKit = createFacadeKit(city, kits, tex.facades, lightmap, tex);
  scene.add(facadeKit.group);
  const district = createDistrict(districtData);
  scene.add(district.group);
  const shopKit = createShopKit(city, shopKitData, lightmap);
  scene.add(shopKit.group);
  const ground = createGround(city, tex, lightmap);
  scene.add(ground.group);
  const signs = createSigns(city, tex);
  scene.add(signs.group);
  await loadAdFonts();
  const adAtlas = drawAdAtlas(isTouch());
  const ads = createAdScreens(city, adAtlas);
  scene.add(ads.group);
  scene.add(createAviationLights(city).group);
  const props = createProps(city, tex, lightmap);
  scene.add(props.group);
  scene.add(createZenith(city).group);
  const heightTex = buildHeightmap(city);
  const rain = createRain(lightmap, heightTex);
  scene.add(rain.group);
  const traffic = new Traffic(city, lightmap);
  await traffic.load();
  scene.add(traffic.group);
  const sky2 = new SkyTraffic(city);
  scene.add(sky2.group);

  await progress(0.55, 'TRAFFIC AND WEATHER');
  const hemi = new THREE.HemisphereLight(0x3a3060, 0x120a14, 0.35);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(0x8090c0, 0.25);
  moon.position.copy(U.moonDir.value).multiplyScalar(1000);
  scene.add(moon);

  const post = createPost(renderer, scene, camera);
  const gov = new Governor((s) => post.setScale(s), { min: 0.5, max: 1 });

  const probe = createReflectionProbe(128);
  const model = createKiteModel(probe.texture);
  await model.userData.build(lightmap);
  scene.add(model);
  const kite = new Kite(city, model);
  const street = city.xs.reduce((a, l) => (l.w < 20 && Math.abs(l.p + 720) < Math.abs(a.p + 720) ? l : a), city.xs[0]);
  kite.place(street.p - 5.4, 0, -150, 0); // pulled in at the kerb, mid-block
  const rig = new CameraRig(camera, kite, city);
  const input = new Input();

  const runs = buildRuns(city);
  const shards = buildShards(city);
  const visuals = new RunVisuals();
  scene.add(visuals.group);
  const settings = loadSettings();
  const sound = new Sound(settings);
  const lightning = new Lightning((d) => sound.thunder(d));
  const mapImage = drawCityMap(city);
  const book = new RunBook(runs);
  const touch = isTouch();
  if (touch) ui.classList.add('touch');
  const hud = new Hud(ui, mapImage);
  hud.onPrompt = () => input.queue.push('confirm');
  let game;
  const screens = new Screens(ui, {
    settings, runs: book, mapImage,
    onStart: () => game.startFree(),
    onResume: () => game.pauseToggle(),
    onRun: (i) => game.startRun(i),
    onReset: () => game.reset(),
    onEndRun: () => game.endRun(),
    onQuit: () => game.quitToTitle(),
    onWaypoint: (x, z) => game.setWaypoint(x, z),
    onUi: () => { sound.start(); sound.ui(); },
    onSetting: (k) => applySetting(k),
  });
  // built before the warm-up so its beacons compile with everything else
  const agents = new AgentLayer({ city, ui, screens, hud, adAtlas });
  // the voice (Settings > VOICE loads it): it reads what the agents finish or fail (AGENT VOICE) and the radio's
  // announcements (RADIO VOICE). Its state shows in the settings row and as toasts
  const voice = new Voice(sound, (state, info) => {
    screens.voiceState = state === 'loading' ? `DOWNLOADING ${info.pct}%` : state === 'ready' ? 'SARAH · EN · 1.25×' : state === 'error' ? 'FAILED' : '';
    screens.updateVoiceState?.();
    if (state === 'ready') hud.toast('VOICE READY · SARAH', 'cyan');
    else if (state === 'error') { hud.toast('VOICE FAILED TO LOAD', 'mag'); console.warn('voice:', info.message); settings.voice = 0; screens.updateVoiceState?.(true); }
  });
  // AGENT VOICE: 1 reads a task's end (done, failed), 2 every message line as well
  agents.onMessage = (a, urgent) => { if (settings.agentVoice === 2) voice.say(a.id, a.name, a.last, urgent); };
  agents.onTaskEnd = (a) => { if (settings.agentVoice >= 1) voice.say(a.id, a.name, a.last, a.status === 'error', a.status === 'error' ? 'failed' : 'finished'); };
  // the radio (the RADIO menu): NEON FM or the music library, picked by the listener or an agent DJ
  // the HUD takes markup; track names and announcements come from files and agents
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const radio = new MusicPlayer(sound, voice, settings, {
    onChange: () => { screens.updateRadio(); showNowPlaying(); },
    onTrack: (t) => { if (t.category !== 'neon fm') hud.toast(esc(`♪ ${t.title}${t.artist ? ` · ${t.artist}` : ''}`.toUpperCase()), 'radio'); },
    onSay: (a) => hud.radio(esc(a.from), esc(a.text.length > 220 ? `${a.text.slice(0, a.text.lastIndexOf(' ', 220))}…` : a.text)),
  });
  // lower right: what the radio plays, and ON AIR while it speaks
  function showNowPlaying() {
    const t = radio.current, dj = radio.djActive ? radio.dj.dj.name : '';
    const fm = !t || t.category === 'neon fm';
    hud.nowPlaying({
      on: !!t && sound.radio,
      label: (fm ? 'NEON FM 88.1' : `RADIO · ${t.category}`).toUpperCase() + (dj ? ` · DJ ${dj.toUpperCase()}` : ''),
      title: fm ? 'Live synth score' : t.title,
      artist: fm ? 'the city, after dark' : t.artist,
    });
  }
  sound.onRadio = ((toggle) => (on) => { toggle(on); showNowPlaying(); })(sound.onRadio);
  voice.onSpeak = (isRadio, on) => hud.onAir(isRadio && on);
  sound.onStart = () => radio.start();
  agents.feed.onRadio = (s) => radio.setDj(s);
  agents.feed.onAnnounce = (a) => radio.announce(a);
  agents.feed.onSkip = () => radio.skip();
  screens.radio = radio;
  screens.sound = sound;
  scene.add(agents.group);
  const nav = new Nav(city);
  const navVis = new NavVisuals(hud.el);
  scene.add(navVis.group);
  const touchUi = createTouch(ui, input);
  const fade = ui.querySelector('#fade');
  const attract = new Attract(camera, kite, city, fade);
  function applySetting(k) {
    try { localStorage.setItem('nz.settings', JSON.stringify(settings)); } catch {}
    if (k === 'quality' || k === 'all') {
      const q = settings.quality;
      gov.locked = q !== 'auto';
      const scale = { auto: gov.scale, high: 1, medium: 0.75, low: 0.58 }[q];
      gov.scale = scale;
      post.setScale(scale);
      rain.setQuality(q === 'low' ? 0.45 : q === 'medium' ? 0.75 : 1);
    }
    if (k === 'rain' || k === 'all') { U.rain.value = settings.rain; rain.group.visible = settings.rain > 0; }
    if (k === 'traffic' || k === 'all') {
      traffic.density = settings.traffic;
      traffic.group.visible = settings.traffic > 0;
      sky2.group.visible = settings.traffic > 0 && !vr.tier;
    }
    if (['volume', 'background', 'music', 'voiceVolume', 'all'].includes(k)) sound.applySettings();
    if (k === 'radioSource' || k === 'radioCategory') radio.listenerPicked(k);
    if (k === 'radioDj') radio.apply();
    if (k === 'voice' || k === 'all') voice.setEnabled(!!settings.voice);
    if (k === 'fov' || k === 'all') rig.fovBase = settings.fov;
    if (k === 'hud' || k === 'all') { hud.show(!!settings.hud && game && game.state !== 'title'); }
    if (k === 'shake' || k === 'all') rig.shakeScale = settings.shake;
  }
  game = new Game({ city, kite, rig, camera, input, hud, screens, sound, music: radio, visuals, runs, book, shards, settings, attract, traffic, skyTraffic: sky2, touch, agents, nav });
  game.onRadioLine = (who, text) => radio.speakLine(who, text);
  game.onWelcome = () => radio.goLive();
  game.welcomeReady = () => !!agents.feed.synced && (!settings.voice || !settings.radioVoice || voice.ready);
  agents.bind(game);
  // a lighter VR city (the tiers are in xr/vr.js): modelled facades and shopfronts only close by (the photo facades
  // take over sooner), Temple Street's props at lower detail, no sky traffic, thinner rain; null puts it all back
  const full = { kitNear: U.kitNear.value, lod0: facadeKit.lod0, shopNear: U.shopNear.value, props: 1, carLod: traffic.lodNear };
  function vrProfile(t) {
    const p = t || full;
    U.kitNear.value = p.kitNear;
    facadeKit.lod0 = p.lod0;
    U.shopNear.value = p.shopNear;
    facadeKit.update(U.kitCenter.value.clone(), true);
    shopKit.list(U.kitCenter.value);
    district.setDetail(p.props);
    traffic.lodNear = p.carLod;
    for (const g of [signs.group, ads.group]) {
      g.userData.maxDist = t ? t.signs / t.cull : Infinity; // cullChunks scales it by t.cull again
      if (!t) for (const m of g.children) m.visible = true;
    }
    if (t) {
      sky2.group.visible = false;
      rain.setQuality(t.rain);
    } else {
      camera.far = 12000;
      camera.updateProjectionMatrix();
      applySetting('quality');
      applySetting('traffic');
    }
  }
  const vr = new VRMode({ renderer, scene, camera, ui, kite, rig, input, hud, ground, post, settings, profile: vrProfile });
  vr.bind(game, agents);
  applySetting('all');

  const fly = new FlyCam(camera, canvas);
  const cam = params.get('cam');
  fly.enabled = !!cam || params.has('fly');
  if (cam) {
    const [x, y, z, yaw, pitch] = cam.split(',').map(Number);
    fly.set(x, y, z, yaw, pitch);
  }
  const car = params.get('car');
  if (car) {
    const [x, y, z, yaw] = car.split(',').map(Number);
    kite.place(x, y, z, yaw);
  }

  facadeKit.update(camera.position, true);
  shopKit.list(U.kitCenter.value);
  district.warm();
  // warm-up: compile every pipeline and upload every buffer now, so nothing hitches the first time it comes into view
  {
    const touched = [];
    scene.traverse((o) => {
      if (o.isMesh || o.isGroup) touched.push([o, o.visible, o.frustumCulled]);
      if (o.isMesh) o.frustumCulled = false;
      o.visible = true;
    });
    await progress(0.75, 'COMPILING SHADERS');
    // compileAsync builds for the current render target, and the scene is never drawn straight to the canvas: it goes
    // into the post pass, the ground mirror and the car's cube probe. Compiled for the canvas, every one of those
    // variants was built synchronously in the first frames instead (a 0.5–3 s freeze on the title screen).
    // The render context is also keyed by call depth, and compileAsync always looks its context up at depth 0. The
    // scene pass draws at depth 2: the output quad renders FXAA's render-to-texture, which renders the scene pass.
    // Measured with renderer._renderContexts; if the post chain changes, so does this number.
    const prevTarget = renderer.getRenderTarget();
    const contexts = renderer._renderContexts, getContext = contexts.get;
    const jobs = [], done = [0, 0, 0], total = [1, 1, 1];
    let moved = performance.now();
    for (const [target, cam, depth] of [[post.scenePass.renderTarget, camera, 2], [ground.reflRT, ground.mirrorCam, 0], [probe.rt, probe.cam.children[0], 0]]) {
      renderer.setRenderTarget(target);
      contexts.get = (rt, mrt) => getContext.call(contexts, rt, mrt, depth);
      const i = jobs.length;
      jobs.push(renderer.compileAsync(scene, cam, null, (e) => {
        done[i] = e.loaded; total[i] = e.total; moved = performance.now();
        const f = (done[0] + done[1] + done[2]) / (total[0] + total[1] + total[2]);
        loaderBar.style.width = `${Math.round((0.75 + 0.2 * f) * 100)}%`;
        loaderSt.textContent = `COMPILING SHADERS ${Math.round(f * 100)}%`;
      }));
      contexts.get = getContext;
    }
    renderer.setRenderTarget(prevTarget);
    // Chrome takes ~3.3 s, WebKit ~7–10 s, and a minute on its first run, when Metal compiles every shader cold. As
    // long as pipelines keep finishing the wait goes on: cut short, the rest compiled in one frozen first frame. A
    // safety net all the same: should nothing finish for WARM_STALL_MS, the boot goes on without the rest.
    const t0 = performance.now();
    const settled = await new Promise((resolve) => {
      const watch = setInterval(() => { if (performance.now() - moved > WARM_STALL_MS) { clearInterval(watch); resolve(false); } }, 500);
      Promise.all(jobs).then(() => { clearInterval(watch); resolve(true); });
    });
    window.__nzBoot.warmMs = Math.round(performance.now() - t0);
    if (!settled) console.warn(`warm-up: nothing compiled for ${WARM_STALL_MS / 1000} s; going on without the rest`);
    await progress(0.95, 'IGNITION');
    ground.updateReflection(renderer, scene, camera, true);
    post.render();
    for (const [o, v, f] of touched) { o.visible = v; o.frustumCulled = f; }
    district.update(camera);
  }

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  let last = performance.now();
  let prevCam = camera.position.clone();
  const t0 = performance.now();
  function frame(now) {
    // the frame that ends a headset session can come without a time, and the XR frame clock need not be the page's
    if (!Number.isFinite(now)) now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    // in a headset the camera sits in the car's seat: everything that follows the eye follows vr.head instead
    const xr = vr.presenting;
    if (!xr) gov.tick(now - last);
    last = now;
    // the traffic moves to where this frame draws it before the car is moved and pushed out of it, or every
    // collision would be against where the traffic was a frame ago
    U.time.value = (now - t0) / 1000;
    traffic.update(dt, (xr ? vr.head : camera).position, U.time.value, kite);
    vr.poll(dt);
    if (fly.enabled) fly.update(dt);
    else game.update(dt);
    const view = vr.update(dt, now) || camera;
    agents.update(view, kite);
    navVis.update(nav, kite, view, game.state === 'play' && !fly.enabled, game.waypointAgent ? agents.entries.get(game.waypointAgent)?.agent.name ?? 'WAYPOINT' : 'WAYPOINT', xr);
    lightning.update(dt, view.position);
    U.carPos.value.copy(kite.pos);
    U.carFwd.value.copy(kite.fwd);
    U.camPos.value.copy(view.position);
    U.camVel.value.copy(view.position).sub(prevCam).divideScalar(Math.max(dt, 1e-3));
    prevCam.copy(view.position);
    sky.update(view);
    if (facadeKit.update(view.position)) shopKit.list(U.kitCenter.value);
    district.update(view);
    cullChunks(scene, view.position, xr && vr.tier ? vr.tier.cull : 1);
    clouds.update(view);
    probe.update(renderer, scene, kite.model.position, [kite.model, rain.group], xr ? vr.probeFaces() : 2);
    if (xr) vr.render();
    else {
      ground.updateReflection(renderer, scene, camera);
      post.render();
    }
  }
  probe.update(renderer, scene, kite.model.position, [kite.model, rain.group], 6);
  renderer.setAnimationLoop(frame);

  await progress(1, 'READY');
  ui.querySelector('#loader').classList.add('done');
  if (touch) touchUi.show(true);
  const runParam = params.get('run');
  if (fly.enabled) hud.show(false);
  else if (runParam !== null) { game.startFree(); game.startRun(+runParam); }
  else if (params.has('play')) game.startFree();
  else game.title();
  if (params.has('bot')) game.bot = new Bot();
  if (params.get('agent')) { if (game.state === 'title') game.startFree(); agents.warpWhenSeen(params.get('agent')); }
  if (touch) game.touchUi = touchUi;

  window.__nz = { renderer, scene, camera, post, gov, city, lightmap, fly, U, ground, facadeKit, shopKit, district, kite, rig, input, traffic, game, runs, shards, sound, hud, screens, agents, nav, vr, voice, ready: true, backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl' };
}

boot().catch((e) => {
  console.error(e);
  const msg = !navigator.gpu && /WebGL|context/i.test(String(e)) ? 'This browser could not start WebGL or WebGPU.' : String(e.message || e);
  ui.querySelector('#loader .lw')?.insertAdjacentHTML('beforeend', `<div class="err">${msg}</div>`);
});
