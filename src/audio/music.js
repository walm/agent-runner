// The radio: what it plays, and who chooses. The listener picks a source and a category in the RADIO menu; an
// agent DJ (server/music.mjs, POST /api/radio) can pick for them while AGENT DJ is on, until the listener picks
// again, and the DJ's next pick takes over once more. The DJ's announcements, and NEON FM's own chatter, are read
// by the voice while RADIO VOICE is on: at once, or ("when": "break") in the gap after the track that is playing.
//
// A source is anything the radio can play from:
//   id, name          what the menu shows
//   available, note   false, and why, for one that is not there (yet)
//   live              plays one endless stream (no tracks to skip)
//   async load()      -> tracks: [{ id, title, artist, category }]
//   play(track) · pause() · resume() · stop()
//   onEnded, onError  set by the player
//   setLevel(v)       for a source that plays outside the game's audio graph: the radio's level, ducking included
// NEON FM and the music library play through the game's mix. Spotify (Web Playback SDK), YouTube Music (IFrame
// player) and Apple Music (MusicKit JS) play protected streams that Web Audio cannot take in, so they will follow
// the radio's volume and ducking through setLevel instead; each needs its own sign-in and app keys, and is listed
// here as coming.

// the game's own station as a category (the name server/music.mjs gives it too)
export const SYNTH = 'neon fm';

class NeonFm {
  id = 'neonfm'; name = 'NEON FM 88.1'; available = true; live = true;
  constructor(sound) { this.sound = sound; }
  async load() { return [{ id: 'neonfm', title: 'Live synth score', artist: 'NEON FM 88.1', category: SYNTH }]; }
  play() { this.sound.setSynth(true); }
  pause() { this.sound.setSynth(false); }
  resume() { this.sound.setSynth(true); }
  stop() { this.sound.setSynth(false); }
}

class Library {
  id = 'library'; name = 'MUSIC LIBRARY'; available = true; live = false;
  constructor(sound) {
    this.sound = sound;
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.onended = () => this.onEnded?.();
    this.el.onplaying = () => this.onPlaying?.();
    this.el.onerror = () => { if (this.el.getAttribute('src')) this.onError?.(this.el.error?.message || 'the track would not play'); };
  }

  async load() {
    const r = await fetch('/api/music').catch(() => null);
    if (!r?.ok || !/json/.test(r.headers.get('content-type') || '')) {
      this.available = false;
      this.note = 'needs the agent server';
      return [];
    }
    return (await r.json()).tracks;
  }

  play(t) {
    // through the radio's channel; never straight out, where the volume settings would not reach it
    if (!this.routed) this.routed = this.sound.connectMedia(this.el);
    if (!this.routed) return;
    this.el.src = t.url;
    this.el.play().catch((e) => this.onError?.(e.message));
  }

  pause() { this.el.pause(); }
  resume() { if (this.el.getAttribute('src')) this.el.play().catch(() => {}); }
  stop() { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); }
  // the server fetches a catalogue track whole the first time; ask for the next one early
  prefetch(t) { if (t?.url) fetch(t.url, { method: 'HEAD' }).catch(() => {}); }
}

const SOON = [
  ['spotify', 'SPOTIFY', 'coming: the Spotify Web Playback SDK (a Premium account and an app client id)'],
  ['youtube', 'YOUTUBE MUSIC', 'coming: the YouTube IFrame player'],
  ['apple', 'APPLE MUSIC', 'coming: MusicKit JS (a developer token)'],
].map(([id, name, note]) => ({ id, name, note, available: false }));

const BREAK_MAX = 90000; // ms a break waits for the voice before the music goes on regardless

export class MusicPlayer {
  // settings: radioSource, radioCategory ('all' or one), radioDj (0/1); hooks: onChange() for the menu,
  // onTrack(track) when one starts, onSay(announcement) when one is read or shown
  constructor(sound, voice, settings, { onChange, onTrack, onSay } = {}) {
    Object.assign(this, { sound, voice, settings, onChange, onTrack, onSay });
    this.sources = [new NeonFm(sound), new Library(sound), ...SOON];
    this.tracks = []; // every source's, loaded once the sound has started
    this.dj = null; // { dj, category, track, at } from the server
    this.override = 0; // the listener picked after this DJ pick
    this.current = null; // the track playing
    this.source = null; // the source playing it
    this.history = [];
    this.breaks = []; // announcements waiting for the end of the track
    this.fails = 0; // tracks in a row that would not play
    this.lines = 0; // NEON FM's lines read so far
    this.live = false; // the first ride's welcome is out: before that, the DJ's lines wait in held
    this.held = [];
    this.inBreak = false;
    for (const s of this.sources) {
      s.onEnded = () => this.ended();
      s.onError = (msg) => this.failed(msg);
      s.onPlaying = () => { this.fails = 0; };
    }
    sound.onRadio = (on) => (on ? this.source?.resume() : this.source?.pause());
  }

  // ---- what plays ----

  get categories() { return [...new Set(this.tracks.map((t) => t.category))]; }
  sourceOf(t) { return t.category === SYNTH ? this.sources[0] : this.sources[1]; }
  get djActive() { return !!(this.settings.radioDj && this.dj?.dj && (this.dj.category || this.dj.track) && this.dj.at > this.override); }

  // the choice in force: the DJ's, or the listener's
  choice() {
    if (this.djActive) return { category: this.dj.category, track: this.dj.track };
    const cat = this.settings.radioSource === 'neonfm' ? SYNTH : this.settings.radioCategory;
    return { category: cat === 'all' ? null : cat, track: null };
  }

  pool() {
    const { category } = this.choice();
    if (category === SYNTH) return this.tracks.filter((t) => t.category === SYNTH);
    const lib = this.tracks.filter((t) => t.category !== SYNTH && (!category || t.category === category));
    return lib.length ? lib : this.tracks.filter((t) => t.category === SYNTH); // nothing there: back to NEON FM
  }

  // called once the game's sound has started (it needs the AudioContext)
  async start() {
    if (this.started) return;
    this.started = true;
    const lists = await Promise.all(this.sources.filter((s) => s.available).map((s) => s.load().catch(() => [])));
    this.tracks = lists.flat();
    this.apply(true);
  }

  // re-evaluate after a setting, a DJ pick or the list changed: keep the track if it still fits
  apply(force = false) {
    if (!this.started) return this.onChange?.();
    const { track } = this.choice();
    const pool = this.pool();
    const want = track && this.tracks.find((t) => t.id === track);
    if (want && want.id !== this.current?.id) this.play(want);
    else if (force || !this.current || !pool.some((t) => t.id === this.current.id)) this.play(this.pick(pool));
    this.onChange?.();
  }

  pick(pool) {
    const recent = new Set(this.history.slice(-Math.min(pool.length - 1, 4)).map((t) => t.id));
    const fresh = pool.filter((t) => !recent.has(t.id));
    const from = fresh.length ? fresh : pool;
    return from[Math.floor(Math.random() * from.length)];
  }

  play(t) {
    if (!t) return;
    const src = this.sourceOf(t);
    if (this.source !== src) for (const s of this.sources) if (s.available && s !== src) s.stop();
    this.source = src;
    this.current = t;
    this.history.push(t);
    if (this.history.length > 50) this.history.shift();
    src.play(t);
    if (!this.sound.radio) src.pause();
    this.upcoming = src.live ? null : this.pick(this.pool().filter((x) => x.id !== t.id));
    if (this.upcoming) src.prefetch?.(this.upcoming);
    this.onTrack?.(t);
    this.onChange?.();
  }

  // the stations the HUD's STATION button steps through: NEON FM, all the music, then each category
  stations() {
    const lib = this.sources[1].available && this.tracks.some((t) => t.category !== SYNTH);
    return [
      { id: SYNTH, source: 'neonfm', name: 'NEON FM 88.1' },
      ...(lib ? [{ id: 'all', source: 'library', category: 'all', name: 'ALL MUSIC' }] : []),
      ...(lib ? this.categories.filter((c) => c !== SYNTH).map((c) => ({ id: c, source: 'library', category: c, name: c.toUpperCase() })) : []),
    ];
  }

  // the station on now, as stations() names it
  station() {
    const c = this.choice().category;
    return c === SYNTH ? SYNTH : c || 'all';
  }

  // ---- the listener ----

  next() {
    if (!this.current || this.source?.live) return false;
    this.play(this.upcoming && this.pool().some((t) => t.id === this.upcoming.id) ? this.upcoming : this.pick(this.pool()));
    return true;
  }

  prev() {
    if (this.history.length < 2 || this.source?.live) return false;
    this.history.pop();
    const t = this.history.pop();
    this.play(t);
    return true;
  }

  toggle() {
    this.sound.toggleRadio();
    this.onChange?.();
  }

  // a track picked in the menu: the listener's choice from here on
  playTrack(id) {
    const t = this.tracks.find((x) => x.id === id);
    if (!t) return;
    this.override = Date.now();
    this.settings.radioSource = t.category === SYNTH ? 'neonfm' : 'library';
    this.play(t);
  }

  // the source or category changed in the menu (a category is the library's)
  listenerPicked(key) {
    if (key === 'radioCategory') this.settings.radioSource = 'library';
    this.override = Date.now();
    this.apply();
  }

  // ---- the DJ ----

  setDj(state) {
    const music = state?.category !== this.dj?.category || state?.track !== this.dj?.track;
    this.dj = state;
    if (music) this.apply();
    else this.onChange?.();
  }

  skip() {
    if (this.settings.radioDj) this.next();
  }

  // the voice is loaded and RADIO VOICE is on
  get speaks() { return !!(this.settings.radioVoice && this.voice.enabled && this.voice.ready); }

  announce(a) {
    if (!this.settings.radioDj) return;
    // on the title nobody hears it: the last few wait for the welcome (goLive)
    if (!this.live) { this.held.push(a); if (this.held.length > 3) this.held.shift(); return; }
    // a break waits for the track to end; NEON FM never ends, and with the radio off there is nothing to wait for
    if (a.when === 'break' && this.speaks && this.source && !this.source.live && this.sound.radio) { this.breaks.push(a); return; }
    this.read(a);
  }

  read(a) {
    this.onSay?.(a);
    if (this.speaks) {
      this.sound.ident();
      this.voice.announce(a.id, a.from, a.text);
    }
  }

  // the welcome has been read: what the DJ said meanwhile follows it, unless it is old news
  goLive() {
    if (this.live) return;
    this.live = true;
    for (const a of this.held.splice(0)) if (Date.now() - a.at < 180000) this.announce({ ...a, when: 'now' });
  }

  // a line of NEON FM's own (the HUD has shown it already)
  speakLine(from, text) {
    if (!this.speaks) return;
    this.sound.ident();
    this.voice.announce(`fm${++this.lines}`, from, text);
  }

  // ---- the end of a track ----

  ended() {
    if (!this.breaks.length) return this.next();
    // the break: the music stops, the DJ speaks, the next track starts once the voice is done
    this.inBreak = true;
    for (const a of this.breaks.splice(0)) this.read(a);
    const go = () => {
      if (!this.inBreak) return;
      this.inBreak = false;
      this.voice.onIdle = null;
      clearTimeout(this.breakTimer);
      setTimeout(() => this.next(), 600);
    };
    this.voice.onIdle = go;
    this.breakTimer = setTimeout(go, BREAK_MAX);
    if (this.voice.idle) go();
  }

  failed(msg) {
    console.warn('radio:', this.current?.title, msg);
    // a few in a row (offline, no server): back to NEON FM, which needs nothing
    if (++this.fails >= 3) { this.fails = 0; this.play(this.tracks.find((t) => t.category === SYNTH)); return; }
    this.next();
  }
}
