// Files the server fetches once and keeps on disk (the voice model, the radio's catalogue), and serving files
// with byte ranges, which media elements need (Safari will not play audio from a server without them).
// AGENT_CITY_CACHE sets where they go (default ~/.cache/agent-runner, shared by `npm run dev` and the app).
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CACHE_DIR = process.env.AGENT_CITY_CACHE || join(homedir(), '.cache', 'agent-runner');

const downloads = new Map(); // file -> Promise, while it is being fetched

export const sizeOf = (file) => stat(file).then((s) => (s.isFile() ? s.size : -1), () => -1);

// Fetch url into file, once: a second caller while it runs waits for the same download. onStart(total) and
// onChunk(bytes) see it as it arrives (the voice model passes it straight on to the game, for its progress bar).
// The download goes on should those callers go away, so the next start finds it done.
export function download(url, file, { onStart, onChunk } = {}) {
  if (downloads.has(file)) return downloads.get(file);
  const job = (async () => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${new URL(url).host} answered HTTP ${r.status}`);
    const total = +r.headers.get('content-length') || 0;
    onStart?.(total);
    await mkdir(dirname(file), { recursive: true });
    const part = `${file}.${process.pid}.part`;
    const out = createWriteStream(part);
    let n = 0;
    try {
      for await (const chunk of r.body) {
        n += chunk.length;
        onChunk?.(chunk);
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
  })().finally(() => downloads.delete(file));
  downloads.set(file, job);
  return job;
}

export const downloading = (file) => downloads.has(file);

// a file, whole or the one byte range asked for
export async function serveFile(req, res, file, type, headers = {}) {
  const size = await sizeOf(file);
  if (size < 0) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"ok":false,"error":"no such file"}'); }
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', ...headers };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = size - 1;
  if (m && (m[1] || m[2])) {
    start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
    end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  } else res.writeHead(200, { ...base, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}
