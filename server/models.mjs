// The agent voice's model files (Supertonic 3, ~400 MB), kept on disk by the server so the game downloads them
// once per machine and not once per browser profile: a web view's storage (the desktop app's above all) does not
// reliably outlive a restart. GET /api/voice/<file> serves a file from the cache; the first request for one
// downloads it from Hugging Face, streaming it to that request while it is written to disk.
//
// Only the files of the one pinned revision can be asked for, so the server never fetches anything else.
import { join } from 'node:path';
import { CACHE_DIR, download, downloading, serveFile, sizeOf } from './cache.mjs';

const REV = 'aafc6e32416a594460b32413efc49d7fe4ce6d46';
const REPO = `https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/${REV}`;
const DIR = join(CACHE_DIR, 'supertonic-3', REV.slice(0, 12));
const FILES = /^(onnx\/(duration_predictor|text_encoder|vector_estimator|vocoder)\.onnx|onnx\/(tts|unicode_indexer)\.json|voice_styles\/[FM][1-5]\.json)$/;

const typeOf = (rel) => (rel.endsWith('.json') ? 'application/json' : 'application/octet-stream');

export async function serveVoiceFile(req, res, rel) {
  if (!FILES.test(rel)) return reply(res, 404, 'not a voice model file');
  const file = join(DIR, rel);
  if ((await sizeOf(file)) < 0) {
    // someone else is fetching it: wait, then read it from disk like any cached file
    if (downloading(file)) {
      try { await download(null, file); } catch (e) { return reply(res, 502, `could not download the voice model: ${e.message}`); }
    } else {
      try {
        await download(`${REPO}/${rel}`, file, {
          onStart: (total) => res.writeHead(200, { 'Content-Type': typeOf(rel), ...(total && { 'Content-Length': total }), 'Cache-Control': 'no-cache' }),
          onChunk: (chunk) => { if (!res.destroyed) res.write(chunk); },
        });
        return res.end();
      } catch (e) {
        console.warn(`[agent-city] voice model ${rel}: ${e.message}`);
        if (!res.headersSent) return reply(res, 502, `could not download the voice model: ${e.message}`);
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
