// What a spoken line becomes at an agent's prompt (src/agents/intent.js), and what the hooks say the agent shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intent, choiceOf, clean } from '../src/agents/intent.js';
import { claudeCode, codex } from './adapters.mjs';

const MENU = { status: 'waiting', prompt: 'menu' };
const keys = (said, at) => intent(said, at).keys;

test('quick actions at a menu', () => {
  assert.deepEqual(keys('Select 2.', MENU), [{ key: '2' }]);
  assert.deepEqual(keys('select B', MENU), [{ key: '2' }]);
  assert.deepEqual(keys('option three', MENU), [{ key: '3' }]);
  assert.deepEqual(keys('the second one', MENU), [{ key: '2' }]);
  assert.deepEqual(keys('number one', MENU), [{ key: '1' }]);
  assert.deepEqual(keys('2', MENU), [{ key: '2' }]);
  assert.deepEqual(keys('b', MENU), [{ key: '2' }]);
  assert.deepEqual(keys('go with c', MENU), [{ key: '3' }]);
  for (const yes of ['yes', 'Yes, that\'s okay.', 'go', 'GO!', 'okay', 'that\'s fine', 'do it', 'sure, go ahead', 'yes please', 'press enter', 'um okay'])
    assert.deepEqual(keys(yes, MENU), [{ key: 'enter' }], yes);
  for (const no of ['no', 'No thanks', 'deny', 'cancel', 'nope', 'don\'t'])
    assert.deepEqual(keys(no, MENU), [{ key: 'escape' }], no);
});

test('a waiting agent with no prompt given is at a choice too', () => {
  assert.deepEqual(keys('yes', { status: 'waiting' }), [{ key: 'enter' }]);
  assert.deepEqual(keys('select 1', { status: 'waiting' }), [{ key: '1' }]);
});

test('an option is picked by its own words', () => {
  const at = { ...MENU, choices: ['Yes', "Yes, and don't ask again for npm commands", 'No'] };
  assert.deepEqual(keys('yes and don\'t ask again', at), [{ key: '2' }]);
  assert.deepEqual(keys('yes', at), [{ key: '1' }]);
  assert.deepEqual(keys('no', at), [{ key: '3' }]);
  const q = { ...MENU, choices: ['Postgres', 'SQLite', 'Keep the JSON files'] };
  assert.deepEqual(keys('SQLite', q), [{ key: '2' }]);
  assert.deepEqual(keys('keep the json files', q), [{ key: '3' }]);
  assert.deepEqual(keys('the last one', q), [{ key: '3' }]);
  assert.equal(intent('sqlite', q).label, 'PRESS 2 · SQLITE');
});

test('anything else at a menu declines it and says why', () => {
  assert.deepEqual(keys('use the staging database instead', MENU), [{ key: 'escape' }, { text: 'use the staging database instead' }, { key: 'enter' }]);
});

test('at a text prompt everything is a message, "yes" too', () => {
  const at = { status: 'done', prompt: 'input' };
  assert.deepEqual(keys('Please run the tests again.', at), [{ text: 'Please run the tests again.' }, { key: 'enter' }]);
  assert.deepEqual(keys('yes', at), [{ text: 'yes' }, { key: 'enter' }]);
  assert.deepEqual(keys('select 2', at), [{ text: 'select 2' }, { key: 'enter' }]);
  // to and for are words, not numbers
  assert.deepEqual(keys('to', MENU), [{ key: 'escape' }, { text: 'to' }, { key: 'enter' }]);
});

test('stop interrupts a working agent', () => {
  assert.deepEqual(keys('Stop!', { status: 'working' }), [{ key: 'escape' }]);
  assert.deepEqual(keys('wait', { status: 'working' }), [{ key: 'escape' }]);
  assert.deepEqual(keys('stop using mocks in the tests', { status: 'working' }), [{ text: 'stop using mocks in the tests' }, { key: 'enter' }]);
});

test('silence is nothing', () => {
  assert.equal(intent('', MENU).kind, 'none');
  assert.equal(intent(' . ', MENU).keys.length, 0);
});

test('helpers', () => {
  assert.equal(clean('That’s  OKAY!'), "that's okay");
  assert.equal(choiceOf('select ninth', false), 9);
  assert.equal(choiceOf('go', true), 0);
});

const hook = (o) => ({ session_id: 's', cwd: '/w/app', ...o });

test('the hooks say what the agent shows, and where it runs', () => {
  const ask = claudeCode(hook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] } }), { host: 'mac', pid: '4242' });
  assert.equal(ask.status, 'waiting');
  assert.equal(ask.meta.prompt, 'menu');
  assert.deepEqual(ask.meta.choices, ['Postgres', 'SQLite']);
  assert.equal(ask.meta.pid, 4242);
  assert.equal(ask.meta.host, 'mac');
  const perm = claudeCode(hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }));
  assert.equal(perm.meta.prompt, 'menu');
  assert.equal(perm.meta.choices.length, 3);
  assert.equal(claudeCode(hook({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })).meta.prompt, 'menu');
  assert.equal(claudeCode(hook({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' })).meta.prompt, 'input');
  assert.equal(claudeCode(hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })).message, 'Allow Bash(rm -rf build)?');
  // back at work: no prompt, and a bad pid is left out
  const work = claudeCode(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), { pid: 'x' });
  assert.equal(work.meta.prompt, null);
  assert.equal(work.meta.pid, undefined);
  assert.equal(claudeCode(hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })).status, 'working');
  assert.equal(claudeCode(hook({ hook_event_name: 'Stop' })).meta.prompt, 'input');
  assert.equal(codex({ type: 'agent-turn-complete', cwd: '/w' }, { pid: 77 }).meta.pid, 77);
});
