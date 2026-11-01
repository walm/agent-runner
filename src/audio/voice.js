// The agents read out loud: each new message line an agent sends, spoken by Supertonic 3 (tts.worker.js) in the
// voice "Sarah" (style F1), English, at 1.25x, through the game's own mix with the music ducked under it.
// Off until the VOICE setting turns it on, which downloads the model once (~400 MB).
//
// A city of busy agents says more than anyone can listen to, so: one line waits per agent (a newer one replaces
// it), what needs you goes first, and a line that has waited too long is dropped.
const VOICE = 'F1', LANG = 'en', SPEED = 1.25;
const MAX_WAIT = 20000; // ms a line may wait before it is stale
const MAX_LEN = 180; // characters of a line that are read

export class Voice {
  // sound: the game's Sound (its AudioContext and mix); onStatus(state, info): 'loading' {pct}, 'ready'
  // {backend}, 'error' {message}, 'off'
  constructor(sound, onStatus) {
    this.sound = sound;
    this.onStatus = onStatus;
    this.enabled = false;
    this.worker = null;
    this.ready = false;
    this.queue = []; // { agent, text, urgent, at }
    this.busy = false; // a line is being made or spoken
    this.seq = 0;
  }

  setEnabled(on) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) {
      this.queue.length = 0;
      this.source?.stop();
      this.onStatus?.('off');
      return;
    }
    if (this.worker) { if (this.ready) this.onStatus?.('ready', { backend: this.backend }); return; }
    this.worker = new Worker(new URL('./tts.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.message(e.data);
    this.worker.onerror = (e) => this.fail(e.message || 'the voice worker failed');
    this.onStatus?.('loading', { pct: 0 });
    this.worker.postMessage({ type: 'init', voice: VOICE });
  }

  // a new line from an agent; urgent when it needs you or failed
  say(agent, name, text, urgent = false) {
    if (!this.enabled) return;
    const line = clean(text);
    if (!line) return;
    const who = String(name || agent).split(' · ')[0];
    const i = this.queue.findIndex((q) => q.agent === agent);
    if (i >= 0) this.queue.splice(i, 1);
    this.queue.push({ agent, text: `${who}: ${line}`, urgent, at: performance.now() });
    this.next();
  }

  next() {
    if (!this.ready || this.busy || !this.enabled) return;
    const now = performance.now();
    this.queue = this.queue.filter((q) => now - q.at < MAX_WAIT);
    if (!this.queue.length) return;
    const i = Math.max(0, this.queue.findIndex((q) => q.urgent));
    const [q] = this.queue.splice(i, 1);
    this.busy = true;
    this.pending = ++this.seq;
    this.worker.postMessage({ type: 'say', id: this.pending, text: q.text, lang: LANG, speed: SPEED });
  }

  message(m) {
    if (m.type === 'progress') this.onStatus?.('loading', { pct: Math.round((m.loaded / m.total) * 100) });
    else if (m.type === 'ready') {
      this.ready = true;
      this.backend = m.backend;
      if (this.enabled) this.onStatus?.('ready', { backend: m.backend });
      this.next();
    } else if (m.type === 'audio' && m.id === this.pending) this.play(m.pcm, m.sampleRate);
    else if (m.type === 'error') {
      if (!this.ready) this.fail(m.message);
      else { console.warn('voice:', m.message); this.busy = false; this.next(); }
    }
  }

  fail(message) {
    this.onStatus?.('error', { message });
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.enabled = false;
    this.busy = false;
  }

  play(pcm, sampleRate) {
    const s = this.sound, ctx = s.ctx;
    // no sound until the first key or click has started the game's audio: a suspended context would never end
    // the line, and the queue would wait on it for good
    if (!ctx || ctx.state !== 'running' || !this.enabled) { this.busy = false; this.next(); return; }
    const buf = ctx.createBuffer(1, pcm.length, sampleRate);
    buf.copyToChannel(pcm, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = 1.1;
    src.connect(g).connect(s.mix);
    s.duck?.(true);
    this.source = src;
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      this.source = null;
      s.duck?.(false);
      // a breath between lines
      setTimeout(() => { this.busy = false; this.next(); }, 250);
    };
    src.onended = end;
    // should the context stall mid-line, the queue still moves on
    setTimeout(end, (pcm.length / sampleRate) * 1000 + 1500);
    src.start();
  }
}

// what is worth reading of a message line: not tool calls (Claude Code reports each as a message), not the
// user's own prompt read back, no markup; a long line is cut at a word
function clean(text) {
  let t = String(text || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/[`*_>#]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || /^[A-Za-z][\w.-]*\(.*\)$/.test(t) || /^Prompt: /.test(t)) return '';
  if (t.length > MAX_LEN) t = t.slice(0, t.lastIndexOf(' ', MAX_LEN) > 80 ? t.lastIndexOf(' ', MAX_LEN) : MAX_LEN) + '.';
  return t;
}
