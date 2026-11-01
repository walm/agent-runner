// The agent voice's model files (Supertonic 3, ~400 MB), kept on disk by the server so the game downloads them
// once per machine and not once per browser profile: a web view's storage (the desktop app's above all) does not
// reliably outlive a restart. GET /api/voice/<file> serves a file from the cache; the first request for one
// downloads it from Hugging Face, streaming it to that request while it is written to disk.
//
// Only the files of the one pinned revision can be asked for, so the server never fetches anything else.
// AGENT_CITY_CACHE sets where they go (default ~/.cache/agent-runner, shared by `npm run dev` and the app).
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const REV = 'aafc6e32416a594460b32413efc49d7fe4ce6d46';
const REPO = `https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/${REV}`;
const DIR = join(process.env.AGENT_CITY_CACHE || join(homedir(), '.cache', 'agent-runner'), 'supertonic-3', REV.slice(0, 12));
const FILES = /^(onnx\/(duration_predictor|text_encoder|vector_estimator|vocoder)\.onnx|onnx\/(tts|unicode_indexer)\.json|voice_styles\/[FM][1-5]\.json)$/;

const downloads = new Map(); // file -> Promise, while one is being fetched

const typeOf = (rel) => (rel.endsWith('.json') ? 'application/json' : 'application/octet-stream');

export async function serveVoiceFile(res, rel) {
  if (!FILES.test(rel)) return notFound(res);
  const file = join(DIR, rel);
  const size = await stat(file).then((s) => s.size, () => -1);
  if (size < 0) {
    // someone else is fetching it: wait, then read it from disk like any cached file
    if (downloads.has(rel)) await downloads.get(rel).catch(() => {});
    else {
      const job = download(rel, file, res);
      downloads.set(rel, job);
      try { await job; } catch (e) {
        console.warn(`[agent-city] voice model ${rel}: ${e.message}`);
        if (!res.headersSent) return failed(res, e);
        res.destroy(); // mid-stream: the client must not take a cut file for a whole one
      } finally { downloads.delete(rel); }
      return;
    }
    return serveVoiceFile(res, rel);
  }
  res.writeHead(200, { 'Content-Type': typeOf(rel), 'Content-Length': size, 'Cache-Control': 'no-cache' });
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// fetch a file into DIR, passing it on to res as it arrives; the download goes on should res go away, so the
// next start finds it done
async function download(rel, file, res) {
  const r = await fetch(`${REPO}/${rel}`);
  if (!r.ok) throw new Error(`Hugging Face answered HTTP ${r.status}`);
  const total = +r.headers.get('content-length') || 0;
  res.writeHead(200, { 'Content-Type': typeOf(rel), ...(total && { 'Content-Length': total }), 'Cache-Control': 'no-cache' });
  await mkdir(dirname(file), { recursive: true });
  const part = `${file}.${process.pid}.part`;
  const out = createWriteStream(part);
  let n = 0;
  try {
    for await (const chunk of r.body) {
      n += chunk.length;
      if (!res.destroyed) res.write(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
    }
    await new Promise((ok, no) => out.end((e) => (e ? no(e) : ok())));
    if (total && n !== total) throw new Error(`the download stopped short (${n} of ${total} bytes)`);
    await rename(part, file);
  } catch (e) {
    out.destroy();
    await rm(part, { force: true });
    throw e;
  }
  res.end();
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not a voice model file' }));
}

function failed(res, e) {
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: `could not download the voice model: ${e.message}` }));
}
