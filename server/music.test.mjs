import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// the user's music folder and the cache, for this test only (read when music.mjs loads)
const dir = await mkdtemp(join(tmpdir(), 'agent-runner-music-'));
process.env.AGENT_CITY_MUSIC = join(dir, 'music');
process.env.AGENT_CITY_CACHE = join(dir, 'cache');
await mkdir(join(dir, 'music', 'Focus'), { recursive: true });
await writeFile(join(dir, 'music', 'Focus', 'Some Artist - Deep Work.mp3'), 'x');
await writeFile(join(dir, 'music', 'loose_track.ogg'), 'x');
await writeFile(join(dir, 'music', 'notes.txt'), 'x');
const { Radio, library, categoriesOf, SYNTH } = await import('./music.mjs');

test('the library: the catalogue, then the user\'s files by folder', async () => {
  const tracks = await library();
  assert.ok(tracks.some((t) => t.id === 'synth-wave' && t.source === 'catalogue' && t.licence === 'CC0' && !t.cached));
  const own = tracks.filter((t) => t.source === 'local');
  assert.deepEqual(own.map((t) => [t.category, t.artist, t.title]), [['focus', 'Some Artist', 'Deep Work'], ['my music', '', 'loose track']]);
  assert.deepEqual(categoriesOf(tracks), [SYNTH, 'synthwave', 'cyberpunk', 'ambient', 'focus', 'my music']);
});

test('the DJ picks music and makes announcements', async () => {
  const sent = [];
  const radio = new Radio((kind, data) => sent.push([kind, data]));
  assert.equal((await radio.post(null)).ok, false);
  assert.equal((await radio.post({ name: 'x' })).ok, false); // nothing to do

  let r = await radio.post({ name: 'DJ', category: 'Cyberpunk', announce: '  Hello city.  ', when: 'break' });
  assert.ok(r.ok);
  assert.equal(r.radio.category, 'cyberpunk');
  assert.equal(r.radio.dj.name, 'DJ');
  const a = sent.find(([k]) => k === 'radio-announce')[1];
  assert.deepEqual([a.text, a.from, a.when], ['Hello city.', 'DJ', 'break']);

  r = await radio.post({ category: 'jazz' });
  assert.equal(r.radio.category, 'cyberpunk'); // unknown: the music stays
  assert.match(r.warnings[0], /no category "jazz"/);

  r = await radio.post({ track: 'deep work' });
  assert.deepEqual([r.radio.track, r.radio.category], ['local:Focus/Some Artist - Deep Work.mp3', 'focus']);

  r = await radio.post({ category: 'any', skip: true });
  assert.deepEqual([r.radio.category, r.radio.track], [null, null]);
  assert.ok(sent.some(([k]) => k === 'radio-skip'));

  r = await radio.post({ announce: 'x'.repeat(5000), when: 'whenever' });
  assert.equal(sent.at(-1)[1].text.length, 1200);
  assert.equal(sent.at(-1)[1].when, 'now');

  radio.clear();
  assert.equal(radio.view().dj, null);
  assert.equal(radio.recent.length, 2);
});
