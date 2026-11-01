// Talking to an agent from its terminal, push to talk: hold Space (X on a gamepad), say it, let go. The words are
// heard on this machine (stt.worker.js: Whistle, in WebAssembly) and sent to the agent server, which works out what
// they mean at the agent's prompt (intent.js: "select 2" presses 2, "yes" Enter, anything else is a message) and
// types it into the agent's own terminal (server/typer.mjs).
//
// The microphone opens on the first press (the browser asks once) and stays open while the terminal is, with a
// moment of audio kept from before the key went down, so the first word is not cut; it closes with the terminal.
// Nothing is recorded unless the key is held, and the sound never leaves the machine: only the words do.

const SR = 16000;
const PREROLL = 0.3, TAIL = 0.25; // seconds kept from before the press, and recorded after the release
const MIN = 0.3, MAX = 30; // a shorter clip is a slip of the finger; a longer one is cut (one pass of the model)
const KEYWORDS = ['select', 'option', 'yes', 'no', 'okay', 'go', 'go ahead', 'cancel', 'stop'];

// the microphone's audio, in blocks, off the audio thread
const WORKLET = `registerProcessor('ar-mic', class extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(2048); this.n = 0; } }
    return true;
  }
});`;

export class Talk {
  // api: the server's /api base; onState({ phase, text, tone, level }) redraws the terminal's talk line
  constructor(api, onState) {
    this.api = api;
    this.onState = onState;
    this.model = 'none'; // 'loading' | 'ready' | 'error'
    this.mic = null;
    this.phase = 'idle'; // 'listening' | 'hearing' | 'sending'
    this.held = false;
    this.chunks = [];
    this.pre = [];
    this.seq = 0;
    this.waiting = new Map(); // hear id -> resolve
    this.whenReady = [];
  }

  // the model, fetched the first time a terminal opens (17 MB once, then from the server's disk)
  prepare() {
    if (this.worker) return;
    this.model = 'loading';
    this.worker = new Worker(new URL('./stt.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.message(e.data);
    this.worker.onerror = (e) => this.message({ type: 'error', message: e.message || 'the speech worker failed' });
    this.worker.postMessage({ type: 'init', base: new URL(`${this.api}/stt/`, location.href).href });
    this.show();
  }

  message(d) {
    if (d.type === 'progress') { this.loadPct = d.total ? Math.round((d.loaded / d.total) * 100) : 0; this.show(); }
    else if (d.type === 'ready') { this.model = 'ready'; console.info(`[talk] speech model ready in ${d.ms} ms`); this.whenReady.splice(0).forEach((f) => f()); this.show(); }
    else if (d.type === 'error') {
      this.model = 'error';
      this.modelError = d.message;
      console.warn('[talk] speech model:', d.message);
      this.whenReady.splice(0).forEach((f) => f());
      this.worker?.terminate();
      this.worker = null; // the next terminal tries again
      this.show({ text: `SPEECH MODEL FAILED · ${d.message}`, tone: 'bad' });
    } else if (d.type === 'heard') { this.waiting.get(d.id)?.(d); this.waiting.delete(d.id); }
  }

  // the line under the terminal: what to do, or what is happening
  show(over) {
    if (over) {
      this.flash = { ...over, until: performance.now() + (over.hold ?? 6000) };
      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => this.show(), (over.hold ?? 6000) + 50);
    }
    let s;
    if (this.phase === 'listening') s = { text: 'LISTENING · LET GO TO SEND', tone: 'live', level: this.level || 0 };
    else if (this.phase === 'hearing') s = { text: this.model === 'loading' ? `LOADING THE SPEECH MODEL ${this.loadPct || 0}%` : 'HEARING …', tone: 'busy' };
    else if (this.phase === 'sending') s = { text: `“${this.heard}” …`, tone: 'busy' };
    else if (this.flash && performance.now() < this.flash.until) s = this.flash;
    else if (this.model === 'loading') s = { text: `LOADING THE SPEECH MODEL ${this.loadPct || 0}%`, tone: 'idle' };
    else s = { text: 'TALK', tone: 'idle', hint: true };
    this.onState?.({ phase: this.phase, ...s });
  }

  // the key went down: start listening (the microphone opens on the first press)
  async press(agent) {
    if (this.held || this.phase !== 'idle') return;
    this.held = true;
    this.agent = agent;
    this.chunks = this.pre.splice(0);
    this.phase = 'listening';
    this.started = performance.now();
    this.show();
    if (this.model === 'none' || this.model === 'error') this.prepare();
    try { await this.open(); } catch (err) {
      this.held = false;
      this.phase = 'idle';
      const msg = err?.name === 'NotAllowedError' ? 'THE MICROPHONE IS BLOCKED · ALLOW IT FOR THIS PAGE' : `NO MICROPHONE · ${err?.message || err}`;
      this.show({ text: msg, tone: 'bad', hold: 8000 });
    }
  }

  // the key came up: a moment more of sound, then hear it and send it
  release() {
    if (!this.held) return;
    this.held = false;
    clearTimeout(this.tail);
    this.tail = setTimeout(() => this.finish(), TAIL * 1000);
  }

  // the terminal closed mid-sentence: drop it
  cancel() {
    clearTimeout(this.tail);
    this.held = false;
    if (this.phase === 'listening') { this.phase = 'idle'; this.chunks = []; }
  }

  async open() {
    if (this.mic) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('this page cannot use a microphone (it needs https or localhost)');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'ar-mic');
    const mute = ctx.createGain();
    mute.gain.value = 0; // pulled by the output so it runs, heard by nobody
    src.connect(node).connect(mute).connect(ctx.destination);
    node.port.onmessage = (e) => this.block(e.data);
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    this.mic = { stream, ctx, rate: ctx.sampleRate };
  }

  // the terminal closed: the microphone goes too (the browser's recording light with it)
  close() {
    this.cancel();
    if (!this.mic) return;
    for (const t of this.mic.stream.getTracks()) t.stop();
    this.mic.ctx.close().catch(() => {});
    this.mic = null;
    this.pre = [];
  }

  block(buf) {
    const rate = this.mic?.rate || 48000;
    if (this.phase === 'listening') {
      this.chunks.push(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 4) sum += buf[i] * buf[i];
      this.level = Math.min(1, Math.sqrt(sum / (buf.length / 4)) * 6);
      this.show();
      if ((performance.now() - this.started) / 1000 > MAX) this.release();
    } else {
      this.pre.push(buf);
      let n = this.pre.reduce((a, b) => a + b.length, 0);
      while (this.pre.length > 1 && n - this.pre[0].length > PREROLL * rate) n -= this.pre.shift().length;
    }
  }

  async finish() {
    if (this.phase !== 'listening') return;
    const pcm = to16k(this.chunks, this.mic?.rate || SR);
    this.chunks = [];
    const agent = this.agent;
    if (pcm.length < MIN * SR) { this.phase = 'idle'; this.show({ text: 'HOLD THE KEY WHILE YOU TALK', tone: 'idle', hold: 3000 }); return; }
    this.phase = 'hearing';
    this.show();
    if (this.model === 'loading') await new Promise((r) => this.whenReady.push(r));
    if (this.model !== 'ready') { this.phase = 'idle'; this.show({ text: `SPEECH MODEL FAILED · ${this.modelError || ''}`, tone: 'bad' }); return; }
    const id = ++this.seq;
    const lang = this.language?.() || 'en';
    const words = [...KEYWORDS, ...(Array.isArray(agent?.meta?.choices) ? agent.meta.choices : [])];
    const heard = await new Promise((r) => { this.waiting.set(id, r); this.worker.postMessage({ type: 'hear', id, pcm, language: lang === 'auto' ? '' : lang, keywords: words.join('\n') }, [pcm.buffer]); });
    if (heard.error || !heard.text) {
      this.phase = 'idle';
      this.show(heard.error ? { text: `COULD NOT HEAR IT · ${heard.error}`, tone: 'bad' } : { text: 'NOTHING HEARD · TRY AGAIN, CLOSER', tone: 'idle', hold: 4000 });
      return;
    }
    console.info(`[talk] heard "${heard.text}" (${heard.language}, ${heard.ms} ms)`);
    this.heard = heard.text;
    this.phase = 'sending';
    this.show();
    const r = await this.say(agent.id, { text: heard.text });
    this.phase = 'idle';
    this.result(r, `“${heard.text}”`);
  }

  // an option picked in the terminal's list (a click, its number key, the d-pad and A): 1…9, 'yes' or 'no'
  async pick(agent, p) {
    if (!agent || this.phase !== 'idle') return;
    this.phase = 'sending';
    this.heard = typeof p === 'number' ? `${p}` : p.toUpperCase();
    this.show();
    const r = await this.say(agent.id, typeof p === 'number' ? { choose: p } : { answer: p });
    this.phase = 'idle';
    this.result(r, typeof p === 'number' ? `OPTION ${p}` : p.toUpperCase());
  }

  result(r, what) {
    if (r.ok && r.typed) this.show({ text: `${what} → ${r.label} · ${r.typed.toUpperCase()}`, tone: 'good' });
    else if (r.ok && r.queued) this.show({ text: `${what} → INBOX · ${r.why}`, tone: 'warn', hold: 10000 });
    else this.show({ text: `${what} NOT SENT · ${r.error || 'the server did not answer'}`, tone: 'bad', hold: 10000 });
  }

  async say(id, body) {
    try {
      // the token the page was opened with (?token=…), for a server that wants one
      const token = new URLSearchParams(location.search).get('token');
      const r = await fetch(`${this.api}/agents/${encodeURIComponent(id)}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Runner': 'input', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
      return await r.json().catch(() => ({ ok: false, error: `${r.status} ${r.statusText}` }));
    } catch (err) { return { ok: false, error: err?.message || String(err) }; }
  }
}

// the microphone's rate (48 or 44.1 kHz) down to the model's 16 kHz: each output sample is the mean of the input
// samples it covers, which is low-pass enough for speech
export function to16k(chunks, rate) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(n);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  if (rate === SR) return all;
  const ratio = rate / SR, m = Math.floor(n / ratio), out = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += all[j];
    out[i] = s / (b - a);
  }
  return out;
}
