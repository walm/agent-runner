// Supertonic 3 text to speech, in a worker so the game's frames never wait on it. The pipeline is the one of
// Supertone's own demo (huggingface.co/spaces/Supertone/supertonic-3): text ids -> duration predictor -> text
// encoder -> a few denoising steps of the vector estimator -> vocoder, 44.1 kHz mono.
//
// The weights (~400 MB, OpenRAIL-M) come from the Hugging Face archive of the open release, pinned to one
// revision. The agent server keeps them on disk (server/models.mjs: downloaded once, there for every later start);
// without that server (a static host) they come straight from Hugging Face into the Cache Storage. Only the voice
// style in use is fetched.
//
// in:  { type: 'init', voice }                  out: { type: 'progress', loaded, total } ... { type: 'ready', backend }
//      { type: 'say', id, text, lang, speed }   out: { type: 'audio', id, pcm (Float32Array), sampleRate }
//                                              or { type: 'error', id?, message }
import * as ort from 'onnxruntime-web/webgpu';

const REPO = 'https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/aafc6e32416a594460b32413efc49d7fe4ce6d46';
const MODELS = { dp: 'onnx/duration_predictor.onnx', enc: 'onnx/text_encoder.onnx', est: 'onnx/vector_estimator.onnx', voc: 'onnx/vocoder.onnx' };
const SIZES = { dp: 3700147, enc: 36416150, est: 256534781, voc: 101424195 }; // for the progress bar before the headers arrive
const CACHE = 'supertonic-3';
const STEPS = 6; // denoising steps: the demo's quality slider, 2-16

let sessions = null, cfg = null, indexer = null, style = null;
let local = false; // the agent server had the files

const LOCAL = '/api/voice/';

// a file from the agent server, else from the Cache Storage, else downloaded from Hugging Face and cached
async function fetchModel(path, onBytes) {
  const r = await fetch(LOCAL + path).catch(() => null);
  // a static host may answer any path with the game's index.html
  if (r?.ok && !/text\/html/.test(r.headers.get('content-type') || '')) { local = true; return read(r, onBytes); }
  return fetchCached(path, onBytes);
}

async function fetchCached(path, onBytes) {
  const url = `${REPO}/${path}`;
  const cache = await caches.open(CACHE).catch(() => null);
  const hit = await cache?.match(url);
  if (hit) { const b = await hit.arrayBuffer(); onBytes?.(b.byteLength); return b; }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  const buf = await read(r, onBytes);
  await cache?.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  return buf;
}

// a response's body, reporting progress as it arrives
async function read(r, onBytes) {
  const reader = r.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
    onBytes?.(value.length);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf.buffer;
}

async function init(voice, prefer) {
  const total = Object.values(SIZES).reduce((a, b) => a + b, 0);
  let loaded = 0, last = 0;
  const onBytes = (n) => {
    loaded += n;
    const now = performance.now();
    if (now - last > 200) { last = now; postMessage({ type: 'progress', loaded, total }); }
  };
  const json = async (p) => JSON.parse(new TextDecoder().decode(await fetchModel(p)));
  [cfg, indexer, style] = await Promise.all([json('onnx/tts.json'), json('onnx/unicode_indexer.json'), json(`voice_styles/${voice}.json`)]);
  const bufs = Object.fromEntries(await Promise.all(Object.entries(MODELS).map(async ([k, p]) => [k, await fetchModel(p, onBytes)])));
  postMessage({ type: 'progress', loaded: total, total });
  // the copy an earlier version kept in this browser is not needed beside the server's
  if (local) caches.delete(CACHE).catch(() => {});
  // WebGPU where the worker has it, else WebAssembly on one thread (the page is not cross-origin isolated)
  ort.env.wasm.numThreads = 1;
  let backend = 'webgpu';
  try {
    if (prefer === 'wasm' || !self.navigator?.gpu) throw new Error('no WebGPU here');
    sessions = await open(bufs, 'webgpu');
  } catch {
    backend = 'wasm';
    sessions = await open(bufs, 'wasm');
  }
  style = {
    ttl: new ort.Tensor(style.style_ttl.type || 'float32', Float32Array.from(style.style_ttl.data.flat(Infinity)), style.style_ttl.dims),
    dp: new ort.Tensor(style.style_dp.type || 'float32', Float32Array.from(style.style_dp.data.flat(Infinity)), style.style_dp.dims),
  };
  postMessage({ type: 'ready', backend });
}

async function open(bufs, ep) {
  const opts = { executionProviders: [ep], graphOptimizationLevel: 'all' };
  const out = {};
  for (const [k, b] of Object.entries(bufs)) out[k] = await ort.InferenceSession.create(new Uint8Array(b), opts);
  return out;
}

// the demo's text clean-up, then the language tags the model reads
function prepare(text, lang) {
  text = text.normalize('NFKD')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '')
    .replace(/[–‑—]/g, '-').replace(/_/g, ' ').replace(/[“”]/g, '"').replace(/[‘’´`]/g, "'")
    .replace(/[[\]|/#→←]/g, ' ').replace(/[♥☆♡©\\]/g, '')
    .replaceAll('@', ' at ').replaceAll('e.g.,', 'for example,').replaceAll('i.e.,', 'that is,')
    .replace(/ ([,.!?;:'])/g, '$1').replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'")\]}…]$/.test(text)) text += '.';
  return `<${lang}>${text}</${lang}>`;
}

async function say(text, lang, speed) {
  const s = sessions;
  const t = prepare(text, lang);
  const chars = Array.from(t);
  // characters the model has no index for read as 0, as in the demo's fallback
  const ids = BigInt64Array.from(chars.map((c) => BigInt(Math.max(0, indexer[c.charCodeAt(0)] ?? 0))));
  const L = ids.length;
  const textIds = new ort.Tensor('int64', ids, [1, L]);
  const textMask = new ort.Tensor('float32', new Float32Array(L).fill(1), [1, 1, L]);
  const dp = await s.dp.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
  // speed -> a factor on the predicted duration, as the demo maps its slider
  const dur = dp.duration.data[0] / (speed + 0.05);
  const enc = await s.enc.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });
  const sr = cfg.ae.sample_rate, chunk = cfg.ae.base_chunk_size * cfg.ttl.chunk_compress_factor;
  const wavLen = Math.floor(dur * sr);
  const T = Math.max(1, Math.floor((wavLen + chunk - 1) / chunk));
  const D = cfg.ttl.latent_dim * cfg.ttl.chunk_compress_factor;
  // start from noise, then let the estimator denoise it step by step
  const latent = new Float32Array(D * T);
  for (let i = 0; i < latent.length; i++) latent[i] = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  const latentMask = new ort.Tensor('float32', new Float32Array(T).fill(1), [1, 1, T]);
  const total = new ort.Tensor('float32', Float32Array.of(STEPS), [1]);
  for (let step = 0; step < STEPS; step++) {
    const r = await s.est.run({
      noisy_latent: new ort.Tensor('float32', latent, [1, D, T]), text_emb: enc.text_emb, style_ttl: style.ttl,
      text_mask: textMask, latent_mask: latentMask, total_step: total, current_step: new ort.Tensor('float32', Float32Array.of(step), [1]),
    });
    latent.set(r.denoised_latent.data);
  }
  const v = await s.voc.run({ latent: new ort.Tensor('float32', latent, [1, D, T]) });
  return { pcm: v.wav_tts.data.slice(0, wavLen), sampleRate: sr };
}

// one job at a time, in order
let chain = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data;
  chain = chain.then(async () => {
    try {
      if (m.type === 'init') await init(m.voice, m.backend);
      else if (m.type === 'say') {
        if (!sessions) throw new Error('not loaded');
        const { pcm, sampleRate } = await say(m.text, m.lang, m.speed);
        postMessage({ type: 'audio', id: m.id, pcm, sampleRate }, [pcm.buffer]);
      }
    } catch (err) {
      postMessage({ type: 'error', id: m.id, message: String(err?.message || err) });
    }
  });
};
