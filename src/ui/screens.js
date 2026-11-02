// Title, pause (settings, controls, runs), full map and run results.
import { MAP, toMap, districtLabels } from './citymap.js';
import { fmtTime, route } from './hud.js';
import { CITY } from '../city/layout.js';
import { esc } from '../core/esc.js';
import { PAD } from '../core/input.js';

const CONTROLS = [
  ['Thrust / brake', 'W / S'],
  ['Steer', 'A / D'],
  ['Lift off / climb', 'SPACE'],
  ['Descend / land (in the air)', 'C'],
  ['Boost', 'SHIFT'],
  ['Drift', 'SHIFT + turn at speed'],
  ['Camera', 'V'],
  ['Map', 'M'],
  ['Reset to street', 'R'],
  ['Horn', 'F'],
  ['Radio on/off · next track', 'B · N'],
  ['All sound off/on', 'K · THE SPEAKER IN THE HUD'],
  ['Agents list', 'G'],
  ['In the list: drive · autopilot there · warp', 'ENTER · P · W'],
  ['Terminal at an agent\'s door', 'ENTER'],
  ['Talk to the agent (in its terminal): hold, speak, let go', 'SPACE · GAMEPAD X'],
  ['Type to the agent (in its terminal)', 'ENTER · TYPE · ENTER SENDS · ESC LEAVES'],
  ['Pick an option while it waits at a choice', '1–9 · CLICK · GAMEPAD D-PAD + A'],
  ['Say at its prompt', '“SELECT 2” · “SELECT B” · “YES” · “GO” · “NO” · “STOP” · ANY SENTENCE'],
  ['Autopilot: off, agent, cruise, turbo, tour', 'P · R-STICK PRESS'],
  ['Menu', 'ESC'],
  ['Quit to main menu (in the menu)', 'Q'],
  ['Gamepad: drive', 'RT/LT · L-STICK · R-STICK LIFT · RB BOOST'],
  ['Gamepad: buttons', 'A ENTER · B HORN · X AGENTS · Y CAMERA · START MENU · BACK MAP · R-STICK PRESS AUTOPILOT'],
  ['Gamepad: radio', 'D-PAD UP ON/OFF · LEFT/RIGHT TRACK · DOWN STATION'],
  ['Gamepad: menus', 'D-PAD/STICK CHOOSE · A PICK · B BACK · LB/RB TABS'],
];

const REPO = 'https://github.com/billpwchan/neon-zenith';
const SITE = location.origin;

// third-party models in the build, and what each licence asks
const CREDITS = [
  ['Lotus Esprit Hover GT 2076', 'maomornity', 'CC BY 4.0', '79fef7f8b1174bf69305e8c28431d26d', 'your car'],
  ['Toyota Crown Comfort (Hong Kong taxi)', 'zxgod118', 'CC BY 4.0', 'a8f3ad22901643809ca72450ac3cc5f6', 'taxis'],
  ['Generic passenger car pack', 'comrade1280', 'CC BY 4.0', '20f9af9b8a404d5cb022ac6fe87f21f5', 'private cars'],
  ['toyota coaster 2017', 'Emmetv96', 'CC BY 4.0', 'b59e858adf6944ecba44bd4ce88acfa5', 'minibuses'],
  ['Low Poly 2013 Toyota HiAce', 'Alvin.Woodly', 'CC BY 4.0', 'f83b4ed4d8534efb81def77b6c1b642d', 'vans'],
  ['Hong Kong KMB Bus Game Ready', 'softmind', 'CC BY 4.0', '1e0d21d8fb1d426c80f65e11c11abdd7', 'buses'],
  ['Asian Shop Pack Free Gameready', 'abhayexe', 'CC BY 4.0', '2f603ad8d5c640f7b9794f6916f9fbdd', 'shopfronts'],
  ['Procedural Hong Kong building', 'udayjeet', 'CC BY 4.0', '528a732e84c44fd49c4726f341014a23', 'facade kit'],
  ['Full Gameready City Buildings III [HongKong]', 'abhayexe', 'CC BY 4.0', '03a5255bb9624d4e82cb8e15e0070b70', 'facades, facade kit'],
  ['Japanese Vending Machine', 'filadog', 'CC BY 4.0', '4768555100004c75b5167d1aa02c683b', 'Temple Street'],
];

export class Screens {
  constructor(root, { settings, runs, onStart, onResume, onRun, onSetting, onReset, onWaypoint, onEndRun, onQuit, onAutopilot, onUi, mapImage }) {
    this.root = root;
    this.settings = settings;
    this.runs = runs;
    this.cb = { onStart, onResume, onRun, onSetting, onReset, onWaypoint, onEndRun, onQuit, onAutopilot, onUi };
    this.mapImage = mapImage;
    this.open = null;
    root.insertAdjacentHTML('beforeend', `
      <div id="title" class="hidden">
        <div class="t-wrap">
          <div class="t-kicker">AGENT CITY · 2077 · RAIN ALL NIGHT</div>
          <div class="t-title"><span>AGENT</span><br><span>RUNNER</span></div>
          <div class="t-en">ONE BUILDING PER AGENT</div>
          <div class="t-tag">Every agent has a building. Drive the rain-soaked streets to whoever needs you, pull up at the door and read their terminal.</div>
          <div class="t-menu">
            <button class="btn primary" data-act="start">FREE RIDE</button>
            <button class="btn" data-act="runs">RUNS</button>
            <button class="btn" data-act="radio">RADIO</button>
            <button class="btn" data-act="settings">SETTINGS</button>
            <button class="btn" data-act="controls">CONTROLS</button>
            <button class="btn" data-act="credits">CREDITS</button>
          </div>
          <div class="t-press">PRESS ENTER</div>
        </div>
        <div class="t-foot">A FORK OF NEON ZENITH BY BILL CHAN · MIT<br>WEBGPU · THREE.JS · POLY HAVEN CC0 · MODELS CC BY · FONTS OFL</div>
      </div>
      <div id="pause" class="screen hidden"><div class="sheet"></div></div>
      <div id="mapscreen" class="screen hidden">
        <canvas></canvas>
        <div class="map-legend">
          <h3>CITY MAP</h3>
          <div><i style="background:#3be8ff;transform:rotate(45deg)"></i>YOU</div>
          <div><i style="background:#ffb547;border-radius:50%"></i>RUN START</div>
          <div><i style="background:#ff3df2;transform:rotate(45deg)"></i>SHARD</div>
          <div><i style="background:#ff3df2;border-radius:50%"></i>THE ZENITH</div>
          <div><i style="border:1px solid #3be8ff"></i>WAYPOINT</div>
          <div><i style="background:linear-gradient(90deg,#3be8ff,#ff3df2);border-radius:50%"></i>AGENT (G FOR LIST)</div>
        </div>
        <button class="btn map-close interactive" data-act="closemap">CLOSE · M</button>
        <div class="map-tip">CLICK TO SET A WAYPOINT · DRAG TO PAN · WHEEL TO ZOOM</div>
      </div>
      <div id="results" class="screen hidden"><div class="sheet"></div></div>`);
    this.title = root.querySelector('#title');
    this.pause = root.querySelector('#pause');
    this.pauseSheet = this.pause.querySelector('.sheet');
    this.mapEl = root.querySelector('#mapscreen');
    this.mapCanvas = this.mapEl.querySelector('canvas');
    this.results = root.querySelector('#results');
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      this.cb.onUi?.();
      this.act(b.dataset.act, b.dataset);
    });
    root.addEventListener('click', (e) => { const a = e.target.closest('a[target=_blank]'); if (a) setTimeout(() => a.blur(), 0); });
    this.view = { cx: 0, cz: 0, zoom: 1 };
    this.bindMap();
  }

  act(a, data) {
    const cb = this.cb;
    if (a === 'start') cb.onStart();
    else if (a === 'resume') cb.onResume();
    else if (a === 'runs') this.showPause('runs');
    else if (a === 'settings') this.showPause('settings');
    else if (a === 'radio') this.showPause('radio');
    else if (a === 'radio-prev') this.radio?.prev();
    else if (a === 'radio-next') this.radio?.next();
    else if (a === 'radio-toggle') this.radio?.toggle();
    else if (a === 'track') this.radio?.playTrack(data.id);
    else if (a === 'controls') this.showPause('controls');
    else if (a === 'credits') this.showPause('credits');
    else if (a === 'menu') this.showPause('menu');
    else if (a === 'run') cb.onRun(+data.i);
    else if (a === 'reset') cb.onReset();
    else if (a === 'endrun') { this.closePause(); cb.onEndRun(); }
    else if (a === 'quit') cb.onQuit();
    else if (a === 'autopilot') { cb.onAutopilot(data.mode); this.showPause(this.tab); }
    else if (a === 'closemap') this.closeMap();
    else if (a === 'set') { this.settings[data.k] = isNaN(+data.v) ? data.v : +data.v; cb.onSetting(data.k); this.showPause(this.tab); }
    else if (a === 'closeres') this.closeResults();
    else if (a === 'retry') { this.closeResults(); cb.onRun(+data.i); }
    else if (a === 'share') this.shareRun(+data.i, +data.t, data.m);
  }

  showTitle(on) {
    clearTimeout(this.titleOut);
    this.title.classList.toggle('hidden', !on);
    if (!on) return;
    // shown again from the menu: from dark, and the tubes catch again
    this.title.classList.remove('out');
    this.title.querySelectorAll('.on').forEach((e) => e.classList.remove('on'));
    const spans = this.title.querySelectorAll('.t-title span');
    // ignite the words one by one, like tubes catching
    spans.forEach((s, i) => setTimeout(() => s.classList.add('on'), 500 + i * 420));
    setTimeout(() => this.title.querySelectorAll('.t-en, .t-tag, .t-menu, .t-press').forEach((e) => e.classList.add('on')), 1500);
  }

  hideTitle() {
    this.title.classList.add('out');
    this.titleOut = setTimeout(() => this.title.classList.add('hidden'), 800);
  }

  // the radio tab: what plays, the controls, where it comes from, and who picks (the player is audio/music.js)
  radioBody(seg) {
    const m = this.radio;
    if (!m) return '';
    const s = this.settings, t = m.current, live = m.source?.live;
    // what plays, whoever picked it (the DJ, while it is on air)
    const srcOn = m.source?.id || s.radioSource;
    const catOn = m.djActive ? m.choice().category || 'all' : s.radioCategory;
    const sources = `<span class="seg">${m.sources.map((src) => src.available
      ? `<button class="${srcOn === src.id ? 'on' : ''}" data-act="set" data-k="radioSource" data-v="${src.id}">${src.name}</button>`
      : `<button class="soon" disabled title="${esc(src.note)}">${src.name}<i>SOON</i></button>`).join('')}</span>`;
    const lib = m.categories.filter((c) => c !== 'neon fm');
    const dj = m.dj?.dj;
    const djNote = !s.radioDj ? 'OFF' : !dj ? 'NO DJ ON AIR' : m.djActive ? `${esc(dj.name).toUpperCase()} PICKS` : `${esc(dj.name).toUpperCase()} · YOU PICKED`;
    const tracks = m.tracks.filter((x) => x.category !== 'neon fm' && (catOn === 'all' || x.category === catOn));
    const cats = `<span class="seg">${[['all', 'ALL'], ...lib.map((c) => [c, c.toUpperCase()])].map(([v, l]) => `<button class="${catOn === v ? 'on' : ''}" data-act="set" data-k="radioCategory" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</span>`;
    return `<div class="radio">
      <div class="np"><div class="np-t"><small>${!this.sound?.radio ? 'RADIO OFF' : m.inBreak ? 'ON AIR' : 'NOW PLAYING'}</small>
        <b>${esc(t?.title || '—')}</b><span>${esc(t?.artist || '')}${t?.category ? ` · ${esc(t.category).toUpperCase()}` : ''}</span></div>
        <div class="np-c"><button class="btn" data-act="radio-prev" ${live ? 'disabled' : ''}>◀◀</button><button class="btn primary" data-act="radio-toggle">${this.sound?.radio ? '❚❚' : '▶'}</button><button class="btn" data-act="radio-next" ${live ? 'disabled' : ''}>▶▶</button></div></div>
      <div class="row"><span>SOURCE</span>${sources}</div>
      ${srcOn === 'library' ? `<div class="row"><span>CATEGORY</span>${cats}</div>` : ''}
      <div class="row"><span>AGENT DJ <small class="hint">${djNote}</small></span>${seg('radioDj', [[1, 'ON'], [0, 'OFF']])}</div>
      ${srcOn === 'library' ? `<div class="tracks">${tracks.map((x) => `<div class="trk ${x.id === t?.id ? 'sel' : ''}" data-act="track" data-id="${esc(x.id)}">
        <span>${esc(x.title)}<small>${esc(x.artist)}</small></span><span>${esc(x.category).toUpperCase()}</span></div>`).join('') || '<p class="empty">No tracks here. Put your own in ~/Music/Agent Runner (a folder per category).</p>'}</div>` : '<p class="empty">NEON FM plays the city\'s own score, live: it follows your speed and height.</p>'}
    </div>`;
  }

  // the autopilot's mode changed: the menu's row shows it
  updateAutopilot(mode) {
    this.apMode = mode;
    if (this.open === 'pause' && this.tab === 'menu') this.showPause('menu');
  }

  // a setting changed outside the menu (K mutes): redraw its tab when it is open
  updateSettings() {
    if (this.open === 'pause' && this.tab === 'settings') this.showPause('settings');
  }

  // the radio's state changed: redraw its tab when it is open
  updateRadio() {
    if (this.open === 'pause' && this.tab === 'radio') this.showPause('radio');
  }

  // the voice's download progress or state beside its setting; rerender when the setting itself changed under it
  updateVoiceState(rerender = false) {
    if (this.open !== 'pause' || this.tab !== 'settings') return;
    if (rerender) { this.showPause('settings'); return; }
    const el = this.pause.querySelector('.voice-st');
    if (el) el.textContent = this.voiceState || '';
  }

  showPause(tab = 'menu') {
    this.tab = tab;
    this.open = 'pause';
    this.pause.classList.remove('hidden');
    const s = this.settings;
    const seg = (k, opts) => `<span class="seg">${opts.map(([v, l]) => `<button class="${String(s[k]) === String(v) ? 'on' : ''}" data-act="set" data-k="${k}" data-v="${v}">${l}</button>`).join('')}</span>`;
    const slider = (k, min, max, step) => `<span class="val">${s[k]}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${s[k]}" data-k="${k}">`;
    const tabs = `<div class="tabs">
      <button class="btn ${tab === 'menu' ? 'sel' : ''}" data-act="menu">PAUSED</button>
      <button class="btn ${tab === 'runs' ? 'sel' : ''}" data-act="runs">RUNS</button>
      <button class="btn ${tab === 'radio' ? 'sel' : ''}" data-act="radio">RADIO</button>
      <button class="btn ${tab === 'settings' ? 'sel' : ''}" data-act="settings">SETTINGS</button>
      <button class="btn ${tab === 'controls' ? 'sel' : ''}" data-act="controls">CONTROLS</button>
      <button class="btn ${tab === 'credits' ? 'sel' : ''}" data-act="credits">CREDITS</button></div>`;
    let body = '';
    if (tab === 'menu') {
      body = `<div class="runs">
        <div class="runc" data-act="resume"><div class="ix">▶</div><div class="nm"><small>RESUME · ESC</small></div><div></div></div>
        ${this.inRun
          ? `<div class="runc" data-act="reset"><div class="ix">↺</div><div class="nm"><small>RESTART RUN · R</small></div><div></div></div>
        <div class="runc" data-act="endrun"><div class="ix">×</div><div class="nm"><small>END RUN</small></div><div></div></div>`
          : `<div class="runc" data-act="reset"><div class="ix">↺</div><div class="nm"><small>BACK TO THE STREET · R</small></div><div></div></div>`}
        ${this.atTitle || this.inRun ? '' : `<div class="row ap-row"><span>AUTOPILOT <small class="hint">P</small></span><span class="seg">${[['off', 'OFF'], ['agent', 'AGENT'], ['cruise', 'CRUISE'], ['turbo', 'TURBO'], ['tour', 'TOUR']].map(([m, l]) => `<button class="${this.apMode === m ? 'on' : ''}" data-act="autopilot" data-mode="${m}">${l}</button>`).join('')}</span></div>`}
        ${this.atTitle ? '' : `<div class="runc" data-act="quit"><div class="ix">⏏</div><div class="nm"><small>QUIT TO MAIN MENU · Q</small></div><div></div></div>`}
      </div>`;
    } else if (tab === 'runs') {
      body = `<div class="runs">${this.runs.list.map((r, i) => {
        const best = this.runs.best(i);
        const medal = best ? this.runs.medal(i, best) : null;
        return `<div class="runc" data-act="run" data-i="${i}"><div class="ix">0${i + 1}</div><div class="nm"><small>${r.en}</small><div class="ds">${r.desc}</div></div>
          <div class="bt">${best ? `<b>${fmtTime(best)}${medal ? `<span class="medal ${medal}"></span>` : ''}</b>BEST` : `<b>—</b>GOLD ${fmtTime(r.medals[0])}`}</div></div>`;
      }).join('')}</div>`;
    } else if (tab === 'settings') {
      body = `
        <div class="row"><span>QUALITY</span>${seg('quality', [['auto', 'AUTO'], ['high', 'HIGH'], ['medium', 'MEDIUM'], ['low', 'LOW']])}</div>
        <div class="row"><span>RAIN</span>${seg('rain', [[1, 'STORM'], [0.6, 'STEADY'], [0.25, 'DRIZZLE'], [0, 'OFF']])}</div>
        <div class="row"><span>TRAFFIC</span>${seg('traffic', [[1, 'BUSY'], [0.5, 'HALF'], [0.2, 'QUIET'], [0, 'OFF']])}</div>
        <div class="row"><span>VOICE <small class="voice-st">${this.voiceState || ''}</small></span>${seg('voice', [[0, 'OFF'], [1, 'ON']])}</div>
        <div class="row sub ${s.voice ? '' : 'dim'}"><span>AGENT VOICE <small class="hint">WHEN A TASK ENDS</small></span>${seg('agentVoice', [[0, 'OFF'], [1, 'DONE · FAILED'], [2, 'EVERY MESSAGE']])}</div>
        <div class="row sub ${s.voice ? '' : 'dim'}"><span>RADIO VOICE <small class="hint">DJ · NEON FM</small></span>${seg('radioVoice', [[0, 'OFF'], [1, 'ON']])}</div>
        <div class="row"><span>TALK LANGUAGE <small class="hint">HOLD SPACE IN A TERMINAL</small></span>${seg('talkLang', [['en', 'EN'], ['auto', 'AUTO'], ['de', 'DE'], ['fr', 'FR'], ['es', 'ES'], ['it', 'IT'], ['nl', 'NL'], ['pl', 'PL']])}</div>
        <div class="row"><span>VR DETAIL</span>${seg('vrDetail', [['auto', 'AUTO'], ['low', 'LOW'], ['medium', 'MEDIUM'], ['high', 'HIGH']])}</div>
        <div class="row"><span>SOUND <small class="hint">K · THE HUD'S SPEAKER</small></span>${seg('mute', [[0, 'ON'], [1, 'MUTED']])}</div>
        <div class="row ${s.mute ? 'dim' : ''}"><span>MASTER VOLUME</span><span>${slider('volume', 0, 1, 0.05)}</span></div>
        <div class="row"><span>BACKGROUND <small class="hint">RAIN · CITY · CAR</small></span><span>${slider('background', 0, 1, 0.05)}</span></div>
        <div class="row"><span>RADIO / MUSIC</span><span>${slider('music', 0, 1, 0.05)}</span></div>
        <div class="row"><span>VOICE VOLUME <small class="hint">AGENTS · DJ</small></span><span>${slider('voiceVolume', 0, 1, 0.05)}</span></div>
        <div class="row"><span>FIELD OF VIEW</span><span>${slider('fov', 50, 80, 1)}</span></div>
        <div class="row"><span>HUD</span>${seg('hud', [[1, 'ON'], [0, 'OFF']])}</div>
        <div class="row"><span>CAMERA SHAKE</span>${seg('shake', [[1, 'ON'], [0, 'OFF']])}</div>`;
    } else if (tab === 'radio') {
      body = this.radioBody(seg);
    } else if (tab === 'credits') {
      body = `<div class="cred">${CREDITS.map(([name, by, lic, id, use]) => `<a href="https://sketchfab.com/3d-models/${id}" target="_blank" rel="noopener"><span>${name}<small>${use}</small></span><span>${by}<small>${lic}</small></span></a>`).join('')}
        <p>Textures, air-conditioners, crates and bags: Poly Haven, CC0. Distant office facades: ambientCG, CC0. Radio music (CC0, OpenGameArt): Pro Sensory, iamoneabe, Ruskerdax, cinameng, Joth, Tsorthan Grove and cynicmusic. Fonts: Oxanium, JetBrains Mono, Monoton, Tilt Neon, Neonderthaw and Noto Serif TC, under the SIL Open Font License. The models were re-exported and compressed for the web, and the building models sliced and rendered into facades; <a href="${REPO}/blob/main/CREDITS.md" target="_blank" rel="noopener">CREDITS.md</a> has the details. Licences: <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>, <a href="https://openfontlicense.org" target="_blank" rel="noopener">SIL OFL 1.1</a>, <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noopener">CC0</a>.</p>
        <p class="src">Agent Runner is a fork of Neon Zenith by Bill Chan, open source under the MIT licence: <a href="${REPO}" target="_blank" rel="noopener">github.com/billpwchan/neon-zenith</a> ★</p></div>`;
    } else {
      body = `<div class="ctl">${CONTROLS.map(([a, k]) => `<div><span>${a}</span><span>${k}</span></div>`).join('')}</div>`;
    }
    this.pauseSheet.innerHTML = `<h2>AGENT RUNNER</h2>${tabs}${body}`;
    this.pauseSheet.querySelectorAll('input[type=range]').forEach((inp) => {
      inp.addEventListener('input', () => {
        this.settings[inp.dataset.k] = +inp.value;
        inp.previousElementSibling.textContent = inp.value;
        this.cb.onSetting(inp.dataset.k);
      });
    });
  }

  closePause() {
    this.pause.classList.add('hidden');
    if (this.open === 'pause') this.open = null;
  }

  // ---- map ----
  bindMap() {
    const c = this.mapCanvas;
    let drag = null, moved = false;
    c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, cx: this.view.cx, cz: this.view.cz }; moved = false; });
    addEventListener('pointerup', (e) => {
      if (drag && !moved && this.open === 'map') {
        const p = this.screenToWorld(e.clientX, e.clientY);
        this.cb.onWaypoint(p.x, p.z);
      }
      drag = null;
    });
    addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      const s = this.mapScale();
      this.view.cx = drag.cx - dx / s;
      this.view.cz = drag.cz - dy / s;
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.view.zoom = Math.max(0.6, Math.min(5, this.view.zoom * Math.exp(-e.deltaY * 0.0015)));
    }, { passive: false });
  }

  mapScale() {
    const r = this.mapCanvas.getBoundingClientRect();
    return (Math.min(r.width, r.height) / (MAP.extent * 2)) * this.view.zoom;
  }

  screenToWorld(px, py) {
    const r = this.mapCanvas.getBoundingClientRect();
    const s = this.mapScale();
    return { x: this.view.cx + (px - r.left - r.width / 2) / s, z: this.view.cz + (py - r.top - r.height / 2) / s };
  }

  // a gamepad on the map: the left stick pans, the triggers (or the right stick) zoom, A sets the waypoint at the
  // crosshair in the middle (drawn once the pad has been used here)
  padMap(input, dt, onWaypoint) {
    const ax = input.padAxes, e = input.padEdges, v = this.view;
    const z = input.padTrig[1] - input.padTrig[0] - (Math.abs(ax[3]) > 0.3 ? ax[3] : 0);
    if (ax[0] || ax[1] || z || e.has(PAD.A)) this.padOnMap = true;
    if (ax[0] || ax[1]) {
      v.cx = Math.max(-MAP.extent, Math.min(MAP.extent, v.cx + (ax[0] * 900 * dt) / v.zoom));
      v.cz = Math.max(-MAP.extent, Math.min(MAP.extent, v.cz + (ax[1] * 900 * dt) / v.zoom));
    }
    if (z) v.zoom = Math.max(0.6, Math.min(5, v.zoom * Math.exp(z * dt * 1.6)));
    if (e.has(PAD.A)) onWaypoint(v.cx, v.cz);
  }

  openMap(player) {
    this.open = 'map';
    this.padOnMap = false;
    this.mapEl.classList.remove('hidden');
    this.view.cx = player.x * 0.5;
    this.view.cz = player.z * 0.5;
    this.view.zoom = 1.15;
  }

  closeMap() {
    this.mapEl.classList.add('hidden');
    if (this.open === 'map') this.open = null;
  }

  drawMap(state) {
    if (this.open !== 'map') return;
    const c = this.mapCanvas;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const r = c.getBoundingClientRect();
    if (c.width !== Math.round(r.width * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#03040a';
    g.fillRect(0, 0, r.width, r.height);
    const s = this.mapScale();
    const k = MAP.size / (MAP.extent * 2);
    const ox = r.width / 2 - this.view.cx * s, oz = r.height / 2 - this.view.cz * s;
    const W = (x) => ox + x * s, Z = (z) => oz + z * s;
    g.imageSmoothingEnabled = true;
    g.drawImage(this.mapImage, W(-MAP.extent), Z(-MAP.extent), MAP.size / k * s, MAP.size / k * s);
    // district names
    g.textAlign = 'center';
    for (const d of districtLabels()) {
      g.fillStyle = 'rgba(232,240,255,0.7)';
      g.font = `600 ${Math.round(9 + this.view.zoom * 1.5)}px "Oxanium Variable", sans-serif`;
      g.fillText(d.en.split('').join(String.fromCharCode(8202)), W(d.x), Z(d.z));
    }
    if (state.route) route(g, state.route, (p) => [W(p.x), Z(p.z)], 8, 4);
    // markers
    for (const m of state.markers) {
      g.save();
      g.translate(W(m.x), Z(m.z));
      if (m.label) { g.fillStyle = m.color; g.font = '500 10px "Oxanium Variable"'; g.textAlign = 'left'; g.fillText(m.label, 9, 4); }
      g.fillStyle = m.color; g.strokeStyle = m.color;
      if (m.shape === 'ring') { g.lineWidth = 1.5; g.beginPath(); g.arc(0, 0, 6, 0, Math.PI * 2); g.stroke(); }
      else if (m.shape === 'dot') { g.beginPath(); g.arc(0, 0, 4.5, 0, Math.PI * 2); g.fill(); }
      else { g.rotate(Math.PI / 4); g.globalAlpha = m.dim ? 0.3 : 1; g.fillRect(-3.5, -3.5, 7, 7); }
      g.restore();
    }
    // player
    g.save();
    g.translate(W(state.player.x), Z(state.player.z));
    g.rotate(state.player.bearing);
    g.fillStyle = '#3be8ff';
    g.shadowColor = '#3be8ff'; g.shadowBlur = 10;
    g.beginPath(); g.moveTo(0, -11); g.lineTo(7, 8); g.lineTo(0, 4); g.lineTo(-7, 8); g.closePath(); g.fill();
    g.restore();
    // the pad's crosshair: where A puts the waypoint
    if (this.padOnMap) {
      const cx = r.width / 2, cy = r.height / 2;
      g.strokeStyle = '#3be8ff'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(cx, cy, 9, 0, Math.PI * 2); g.stroke();
      g.beginPath();
      for (const [x0, y0, x1, y1] of [[-18, 0, -12, 0], [12, 0, 18, 0], [0, -18, 0, -12], [0, 12, 0, 18]]) { g.moveTo(cx + x0, cy + y0); g.lineTo(cx + x1, cy + y1); }
      g.stroke();
      g.fillStyle = '#3be8ff'; g.font = '500 10px "Oxanium Variable"'; g.textAlign = 'center';
      g.fillText('A · WAYPOINT', cx, cy + 32);
    }
  }

  // ---- results ----
  showResults(i, time, best, medal, newBest) {
    this.open = 'results';
    this.lastRun = i;
    const r = this.runs.list[i];
    const sheet = this.results.querySelector('.sheet');
    const names = ['GOLD', 'SILVER', 'BRONZE'];
    sheet.innerHTML = `<h2>${r.en}</h2>
      <div class="sub">${newBest ? 'NEW BEST' : 'RUN COMPLETE'}</div>
      <div class="big">${fmtTime(time)}</div>
      <div class="sub">BEST ${fmtTime(best)}</div>
      <div class="medalrow">${r.medals.map((m, k) => `<span class="${time <= m ? 'got' : ''}">${names[k]} ${fmtTime(m)}<span class="medal ${['gold', 'silver', 'bronze'][k]}" style="opacity:${time <= m ? 1 : 0.2}"></span></span>`).join('')}</div>
      <div class="foot"><button class="btn" data-act="share" data-i="${i}" data-t="${time}" data-m="${medal || ''}">SHARE</button><button class="btn" data-act="retry" data-i="${i}">RETRY · R</button><button class="btn primary" data-act="closeres">CONTINUE · ENTER</button></div>
      <a class="src" href="${REPO}" target="_blank" rel="noopener">OPEN SOURCE ON GITHUB ★</a>`;
    this.results.classList.remove('hidden');
  }

  // a time to beat travels with a link that drops the reader straight into the same run
  async shareRun(i, t, medal) {
    const r = this.runs.list[i];
    const url = `${SITE}/?run=${i}`;
    const text = `${r.en} · ${fmtTime(t)}${medal ? ` · ${medal.toUpperCase()}` : ''} in Agent Runner. Beat it, in your browser:`;
    const btn = this.results.querySelector('[data-act=share]');
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) { await navigator.share({ title: 'Agent Runner', text, url }); return; }
      await navigator.clipboard.writeText(`${text} ${url}`);
      btn.innerHTML = 'LINK COPIED';
    } catch { /* share sheet dismissed or clipboard denied */ }
  }

  closeResults() {
    this.results.classList.add('hidden');
    if (this.open === 'results') this.open = null;
  }
}
