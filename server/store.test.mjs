import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, validate, LIMITS, OFFLINE_MS, PRUNE_ENDED_MS } from './store.mjs';
import { claudeCode, codex } from './adapters.mjs';

const ok = (e) => { const v = validate(e); assert.ok(v.ok, v.error); return v.event; };

test('validate rejects bad events', () => {
  assert.equal(validate(null).ok, false);
  assert.equal(validate([]).ok, false);
  assert.equal(validate({ status: 'working' }).ok, false);
  assert.equal(validate({ agent: '  ' }).ok, false);
  assert.equal(validate({ agent: 'a', status: 'sleeping' }).ok, false);
  assert.equal(validate({ agent: 'a', text: 5 }).ok, false);
  assert.equal(validate({ agent: 'a', meta: [] }).ok, false);
  assert.equal(validate({ agent: 'x'.repeat(LIMITS.id + 1) }).ok, false);
});

test('validate clamps text and normalises harness', () => {
  assert.equal(ok({ agent: 'a', text: 'x'.repeat(LIMITS.text + 10) }).text.length, LIMITS.text);
  assert.equal(ok({ agent: 'a', harness: 'Claude-Code' }).harness, 'claude-code');
  assert.equal(ok({ agent: 'a', end: 'yes' }).end, false);
});

test('status changes are notable only into waiting, error and done', () => {
  const s = new Store();
  const seen = [];
  s.on((kind, d) => { if (kind === 'agent') seen.push([d.agent.status, d.notable]); });
  s.apply(ok({ agent: 'a', status: 'working', name: 'A', harness: 'codex' }));
  s.apply(ok({ agent: 'a', status: 'waiting', message: 'Allow edit?' }));
  s.apply(ok({ agent: 'a', status: 'waiting' }));
  s.apply(ok({ agent: 'a', end: true }));
  assert.deepEqual(seen, [['working', false], ['waiting', true], ['waiting', false], ['done', true]]);
  const [a] = s.list();
  assert.equal(a.name, 'A');
  assert.equal(a.harness, 'codex');
});

test('output is CRLF and bounded at a line boundary', () => {
  const s = new Store();
  const line = 'y'.repeat(999) + '\n';
  for (let i = 0; i < 400; i++) s.apply(ok({ agent: 'a', text: line }));
  const out = s.output('a');
  assert.ok(out.text.length <= LIMITS.output);
  assert.ok(out.text.startsWith('y'));
  assert.ok(out.text.endsWith('\r\n'));
  // seq counts every character ever appended, trimmed or not
  assert.equal(out.seq, 400 * 1001);
});

test('message sets last line and writes a dim line to output', () => {
  const s = new Store();
  s.apply(ok({ agent: 'a', message: 'Running tests\nmore' }));
  assert.equal(s.list()[0].last, 'Running tests');
  assert.match(s.output('a').text, /Running tests/);
});

test('silent agents go offline, ended ones are pruned', () => {
  let t = 1000;
  const s = new Store({ now: () => t });
  s.apply(ok({ agent: 'a', status: 'working' }));
  s.apply(ok({ agent: 'b', end: true }));
  t += OFFLINE_MS + 1;
  const by = Object.fromEntries(s.list().map((a) => [a.id, a.status]));
  assert.deepEqual(by, { a: 'offline', b: 'done' });
  t += PRUNE_ENDED_MS;
  s.prune();
  assert.deepEqual(s.list().map((a) => a.id), ['a']);
});

test('claude code hook payloads map to events', () => {
  const base = { session_id: 's1', cwd: '/src/shop-api' };
  const e1 = claudeCode({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'fix the tests' }, { host: 'mbp' });
  assert.equal(e1.agent, 'claude-code:mbp:/src/shop-api');
  assert.equal(e1.name, 'shop-api');
  assert.equal(e1.status, 'working');
  assert.ok(validate(e1).ok);
  assert.equal(claudeCode({ ...base, hook_event_name: 'Notification', message: 'Claude needs your permission' }).status, 'waiting');
  assert.equal(claudeCode({ ...base, hook_event_name: 'Stop' }).status, 'done');
  assert.equal(claudeCode({ ...base, hook_event_name: 'SessionEnd' }).end, true);
  const post = claudeCode({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: 'a\nb' } });
  assert.match(post.text, /⎿/);
  assert.ok(claudeCode({ nope: 1 }).error);
});

test('codex notify payloads map to events', () => {
  const e = codex({ type: 'agent-turn-complete', 'thread-id': 't1', cwd: '/src/etl', 'input-messages': ['backfill'], 'last-assistant-message': 'Backfilled 3 days' }, { host: 'mbp' });
  assert.equal(e.agent, 'codex:mbp:/src/etl');
  assert.equal(e.status, 'done');
  assert.equal(e.meta.task, 'backfill');
  assert.ok(validate(e).ok);
  assert.ok(codex({}).error);
});
