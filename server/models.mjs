// The models the game runs in the browser, kept on disk by the server so the game downloads them once per machine
// and not once per browser profile: a web view's storage (the desktop app's above all) does not reliably outlive
// a restart. The first request for a file downloads it from Hugging Face, streaming it to that request while it
// is written to disk; later ones are served from the cache.
//
//   GET /api/voice/<file>  the agent voice: Supertonic 3 (~400 MB), read out by src/audio/tts.worker.js
//   GET /api/stt/<file>    talking to agents: Whistle (17 MB) in the Needle engine's WebAssembly build (1 MB),
//                          run by src/agents/stt.worker.js
//
// Only the files of each model's one pinned revision can be asked for, so the server never fetches anything else.
import { join } from 'node:path';
import { CACHE_DIR, download, downloading, serveFile, sizeOf } from './cache.mjs';

const HF = 'https://huggingface.co';
const TTS_REV = 'aafc6e32416a594460b32413efc49d7fe4ce6d46';
const NEEDLE_REV = 'd6c7d6a2e9655505e0f8e23339356dd1705900eb';
const WHISTLE_REV = '741118687e1f008f06d1351a402a731274789790';

const MODELS = {
  voice: {
    label: 'the voice model',
    dir: join(CACHE_DIR, 'supertonic-3', TTS_REV.slice(0, 12)),
    // the path asked for is the path in the repo
    url: (rel) => /^(onnx\/(duration_predictor|text_encoder|vector_estimator|vocoder)\.onnx|onnx\/(tts|unicode_indexer)\.json|voice_styles\/[FM][1-5]\.json)$/.test(rel)
      && `${HF}/supertone-oss-archive/supertonic-3/resolve/${TTS_REV}/${rel}`,
  },
  stt: {
    label: 'the speech model',
    dir: join(CACHE_DIR, 'whistle', `${WHISTLE_REV.slice(0, 12)}-${NEEDLE_REV.slice(0, 12)}`),
    url: (rel) => ({
      'needle.js': `${HF}/Cactus-Compute/needle3/resolve/${NEEDLE_REV}/wasm/needle.js`,
      'needle.wasm': `${HF}/Cactus-Compute/needle3/resolve/${NEEDLE_REV}/wasm/needle.wasm`,
      'whistle.cact': `${HF}/Cactus-Compute/whistle/resolve/${WHISTLE_REV}/whistle.cact`,
    })[rel],
  },
};

const typeOf = (rel) => (rel.endsWith('.json') ? 'application/json' : rel.endsWith('.js') ? 'text/javascript' : rel.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');

export async function serveModelFile(kind, req, res, rel) {
  const m = MODELS[kind];
  const src = m?.url(rel);
  if (!src) return reply(res, 404, `not a file of ${m?.label || 'a model'}`);
  const file = join(m.dir, rel);
  if ((await sizeOf(file)) < 0) {
    // someone else is fetching it: wait, then read it from disk like any cached file
    if (downloading(file)) {
      try { await download(null, file); } catch (e) { return reply(res, 502, `could not download ${m.label}: ${e.message}`); }
    } else {
      try {
        await download(src, file, {
          onStart: (total) => res.writeHead(200, { 'Content-Type': typeOf(rel), ...(total && { 'Content-Length': total }), 'Cache-Control': 'no-cache' }),
          onChunk: (chunk) => { if (!res.destroyed) res.write(chunk); },
        });
        return res.end();
      } catch (e) {
        console.warn(`[agent-city] ${m.label}, ${rel}: ${e.message}`);
        if (!res.headersSent) return reply(res, 502, `could not download ${m.label}: ${e.message}`);
        return res.destroy(); // mid-stream: the client must not take a cut file for a whole one
      }
    }
  }
  return serveFile(req, res, file, typeOf(rel));
}

function reply(res, code, error) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error }));
}
