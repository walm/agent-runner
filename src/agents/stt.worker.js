// Hearing the driver: Whistle (Cactus Compute's 17 MB speech-to-text model, Apache-2.0) in the Needle engine's
// WebAssembly build, on the CPU, off the main thread. The files come from the agent server's model cache
// (GET /api/stt/…, server/models.mjs), which fetches them from Hugging Face once.
//
// in:  { type: 'init', base }                                   base: the URL /api/stt/ resolves to
//      { type: 'hear', id, pcm (Float32Array, 16 kHz mono), language, keywords }
// out: { type: 'progress', loaded, total } · { type: 'ready', ms } · { type: 'error', message }
//      { type: 'heard', id, text, language, ms }
let M = null, out = 0;
const CAP = 1 << 16;

self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === 'init') {
    try { await init(d.base); } catch (err) { postMessage({ type: 'error', message: err?.message || String(err) }); }
  } else if (d.type === 'hear') {
    try { postMessage({ type: 'heard', id: d.id, ...hear(d.pcm, d.language, d.keywords) }); } catch (err) { postMessage({ type: 'heard', id: d.id, error: err?.message || String(err) }); }
  }
};

async function init(base) {
  const t0 = performance.now();
  // the engine's loader is a classic script (it declares createNeedle); a module worker cannot importScripts it
  const src = await (await must(fetch(`${base}needle.js`))).text();
  const createNeedle = new Function(`${src}\nreturn createNeedle;`)();
  // this build looks for needle.wasm beside the script (the worker's URL) and takes no locateFile: hand it the bytes
  const wasmBinary = new Uint8Array(await (await must(fetch(`${base}needle.wasm`))).arrayBuffer());
  M = await createNeedle({ wasmBinary });
  const cact = await download(`${base}whistle.cact`);
  // the engine reads the model where it lies, so its bytes stay allocated for good
  const p = M._malloc(cact.length);
  M.HEAPU8.set(cact, p);
  if (M._needle_load(p, BigInt(cact.length)) < 0) throw new Error(`the speech model did not load: ${M.UTF8ToString(M._needle_last_error())}`);
  out = M._malloc(CAP);
  postMessage({ type: 'ready', ms: Math.round(performance.now() - t0) });
}

async function must(p) {
  const r = await p;
  if (!r.ok) throw new Error(`${r.url.split('/').pop()}: ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return r;
}

// the model with a progress count: 17 MB the first time, from the server's disk after that
async function download(url) {
  const r = await must(fetch(url));
  const total = +r.headers.get('content-length') || 0;
  if (!r.body) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader(), parts = [];
  let loaded = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    if (performance.now() - last > 100) { last = performance.now(); postMessage({ type: 'progress', loaded, total }); }
  }
  const all = new Uint8Array(loaded);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return all;
}

// a NUL-terminated UTF-8 copy in the engine's memory (0 for none); the caller frees it
function cstr(s) {
  if (!s) return 0;
  const b = new TextEncoder().encode(s);
  const p = M._malloc(b.length + 1);
  M.HEAPU8.set(b, p);
  M.HEAPU8[p + b.length] = 0;
  return p;
}

function hear(pcm, language, keywords) {
  if (!M) throw new Error('the speech model is not loaded');
  const t0 = performance.now();
  const pp = M._malloc(pcm.length * 4), lp = cstr(language), kp = cstr(keywords);
  try {
    // a view made after the mallocs: growing the memory replaces its buffer
    new Float32Array(M.HEAPU8.buffer, pp, pcm.length).set(pcm);
    const n = M._needle_transcribe(pp, pcm.length, lp, kp, 0, out, CAP);
    if (n < 0) throw new Error(M.UTF8ToString(M._needle_last_error()));
    const r = JSON.parse(M.UTF8ToString(out));
    return { text: (r.text || '').trim(), language: r.language || '', ms: Math.round(performance.now() - t0) };
  } finally {
    M._free(pp);
    if (lp) M._free(lp);
    if (kp) M._free(kp);
  }
}
