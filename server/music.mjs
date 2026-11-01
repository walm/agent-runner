// The radio's music and its DJ.
//
// Music: a catalogue of CC0 tracks from OpenGameArt (credited in CREDITS.md), downloaded into the cache the first
// time each is played, and the user's own files in ~/Music/Agent Runner (AGENT_CITY_MUSIC): a file in a folder
// is in that folder's category ("~/Music/Agent Runner/focus/x.mp3" is in "focus"), a loose one in "my music".
//
// The DJ: any agent can run the radio with POST /api/radio: pick the music by category (or a track), skip, and
// make announcements, which the game reads out with the agent voice between or over the music.
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import { CACHE_DIR, download, serveFile, sizeOf } from './cache.mjs';

const OGA = 'https://opengameart.org';
export const CATALOG = [
  { id: 'synth-wave', title: 'Synth Wave', artist: 'Pro Sensory (Alex McCulloch)', category: 'synthwave', file: '/sites/default/files/Synth%20Wave.mp3', bytes: 7682216, page: '/content/synth-wave' },
  { id: 'rocking-the-synth-machine', title: 'Rocking the Synth Machine', artist: 'Pro Sensory (Alex McCulloch)', category: 'synthwave', file: '/sites/default/files/rocking_the_synth_machine_2.mp3', bytes: 3266234, page: '/content/rocking-the-synth-machine' },
  { id: 'futility-belt', title: 'Futility Belt', artist: 'iamoneabe', category: 'synthwave', file: '/sites/default/files/futilitybelt.mp3', bytes: 17169857, page: '/content/futility-belt' },
  { id: 'approach', title: 'Approach', artist: 'Ruskerdax', category: 'cyberpunk', file: '/sites/default/files/ruskerdax_-_approach.mp3', bytes: 7712043, page: '/content/approach' },
  { id: 'pyro', title: 'Pyro', artist: 'cinameng', category: 'cyberpunk', file: '/sites/default/files/pyro_4.mp3', bytes: 8590105, page: '/content/pyro' },
  { id: 'cyberpunk-moonlight-sonata', title: 'Cyberpunk Moonlight Sonata', artist: 'Joth', category: 'cyberpunk', file: '/sites/default/files/Cyberpunk%20Moonlight%20Sonata_0.mp3', bytes: 2338920, page: '/content/cyberpunk-moonlight-sonata' },
  { id: 'corrupt-data-stream', title: 'Corrupt Data Stream', artist: 'Tsorthan Grove', category: 'ambient', file: '/sites/default/files/corrupt_data_stream.mp3', bytes: 4557218, page: '/content/corrupt-data-stream' },
  { id: 'synthwave-4k', title: 'Calm Ambient 1 (Synthwave 4k)', artist: 'cynicmusic', category: 'ambient', file: '/sites/default/files/001_Synthwave_4k.mp3', bytes: 2527398, page: '/content/calm-ambient-1-synthwave-4k' },
];
// the game's own station: the score it synthesises, as a category the DJ can pick
export const SYNTH = 'neon fm';

const MUSIC_DIR = resolve(process.env.AGENT_CITY_MUSIC || join(homedir(), 'Music', 'Agent Runner'));
const CATALOG_DIR = join(CACHE_DIR, 'music');
const TYPES = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac' };
const LOOSE = 'my music';

// every track: the catalogue's, then the user's ("Artist - Title.mp3" reads as that, else the name is the title)
export async function library() {
  const tracks = [];
  for (const t of CATALOG) {
    tracks.push({
      id: t.id, title: t.title, artist: t.artist, category: t.category, source: 'catalogue', licence: 'CC0', page: OGA + t.page,
      cached: (await sizeOf(join(CATALOG_DIR, `${t.id}.mp3`))) === t.bytes, url: `/api/music/file?id=${t.id}`,
    });
  }
  let files = [];
  try { files = await readdir(MUSIC_DIR, { recursive: true }); } catch { /* no folder: no own music */ }
  for (const rel of files.sort()) {
    if (!TYPES[extname(rel).toLowerCase()] || rel.split(sep).some((p) => p.startsWith('.'))) continue;
    const parts = rel.split(sep);
    const name = parts.at(-1).slice(0, -extname(rel).length).replace(/_/g, ' ').trim();
    const [artist, title] = name.includes(' - ') ? name.split(/ - (.+)/) : ['', name];
    const id = `local:${parts.join('/')}`;
    tracks.push({ id, title, artist, category: parts.length > 1 ? parts[0].toLowerCase() : LOOSE, source: 'local', cached: true, url: `/api/music/file?id=${encodeURIComponent(id)}` });
  }
  return tracks;
}

export const categoriesOf = (tracks) => [SYNTH, ...new Set(tracks.map((t) => t.category))];

// GET /api/music/file?id=…: a catalogue track (fetched first, if this is its first play) or one of the user's
export async function serveTrack(req, res, id) {
  if (id?.startsWith('local:')) {
    const file = resolve(MUSIC_DIR, id.slice(6));
    if (!file.startsWith(MUSIC_DIR + sep) || !TYPES[extname(file).toLowerCase()]) return reply(res, 404, 'no such track');
    return serveFile(req, res, file, TYPES[extname(file).toLowerCase()]);
  }
  const t = CATALOG.find((c) => c.id === id);
  if (!t) return reply(res, 404, 'no such track');
  const file = join(CATALOG_DIR, `${t.id}.mp3`);
  // whole before it is served: a media element asks for byte ranges from the start
  if ((await sizeOf(file)) !== t.bytes) {
    try { await download(OGA + t.file, file); } catch (e) {
      console.warn(`[agent-city] music ${t.id}: ${e.message}`);
      return reply(res, 502, `could not download the track: ${e.message}`);
    }
  }
  return serveFile(req, res, file, 'audio/mpeg');
}

// ---- the DJ ----

export const RADIO_LIMITS = { announce: 1200, from: 60, name: 80 };

export class Radio {
  constructor(emit) {
    this.emit = emit; // (kind, data) to the game's stream
    this.state = { dj: null, category: null, track: null, at: 0 };
    this.recent = []; // the last announcements
    this.seq = 0;
  }

  // POST /api/radio: { agent?, name?, category?, track?, skip?, announce?, from?, when? }
  async post(b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, error: 'body must be a JSON object' };
    const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    const agent = str(b.agent, RADIO_LIMITS.name) || 'radio';
    const name = str(b.name, RADIO_LIMITS.name) || agent;
    const announce = str(b.announce ?? b.say, RADIO_LIMITS.announce);
    const when = b.when === 'break' ? 'break' : 'now';
    if (!announce && b.category === undefined && b.track === undefined && !b.skip) return { ok: false, error: 'nothing to do: give category, track, skip or announce' };
    const tracks = await library();
    const cats = categoriesOf(tracks);
    const warnings = [];
    let { category, track } = this.state;
    if (b.category !== undefined) {
      const c = String(b.category || '').trim().toLowerCase();
      if (!c || c === 'any' || c === 'all') { category = null; track = null; }
      else if (cats.includes(c)) { category = c; track = null; }
      else warnings.push(`no category "${c}" (have: ${cats.join(', ')}); the music stays as it is`);
    }
    if (b.track !== undefined) {
      const q = String(b.track || '').trim().toLowerCase();
      const t = tracks.find((x) => x.id.toLowerCase() === q) || tracks.find((x) => `${x.artist} ${x.title}`.toLowerCase().includes(q));
      if (t) { track = t.id; category = t.category; } else warnings.push(`no track matches "${q}"`);
    }
    this.state = { dj: { agent, name, at: Date.now() }, category, track, at: Date.now() };
    this.emit('radio', this.view());
    if (b.skip) this.emit('radio-skip', { at: Date.now() });
    let a;
    if (announce) {
      a = { id: ++this.seq, text: announce, from: str(b.from, RADIO_LIMITS.from) || name, dj: name, when, at: Date.now() };
      this.recent.push(a);
      if (this.recent.length > 20) this.recent.shift();
      this.emit('radio-announce', a);
    }
    return { ok: true, radio: this.view(), categories: cats, ...(a && { announcement: a.id }), ...(warnings.length && { warnings }) };
  }

  // DELETE /api/radio: the DJ steps off; the game goes back to the listener's own choice
  clear() {
    this.state = { dj: null, category: null, track: null, at: Date.now() };
    this.emit('radio', this.view());
  }

  view() { return { ...this.state }; }
}

function reply(res, code, error) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error }));
}
