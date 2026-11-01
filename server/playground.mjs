// The playground: a mock agent to practise talking to agents on (README: Talk to your agents). It runs with the
// other mock agents (`--mock`, the app's Demo Agents) and asks what a real Claude Code asks: a question with
// options, a permission prompt, and "what next?" at its prompt. It has no terminal: what the driver says or picks
// in the game reaches it in the server (index.mjs talk(), meta.input 'mock'), already read by intent.js, and it
// answers in its terminal as a real agent would.
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', mag: '\x1b[35m', cyan: '\x1b[36m', grey: '\x1b[90m' };

export const PLAYGROUND = 'claude-code:mbp-walm:playground';

const QUESTIONS = [
  { q: 'Which database should the cache use?', options: ['Postgres', 'SQLite', 'Redis', 'Keep the JSON files'] },
  { q: 'Which test runner should I set up?', options: ['Vitest', 'Jest', 'node:test'] },
  { q: 'What colour should the deploy button be?', options: ['Cyan', 'Magenta', 'Amber', 'Green', 'Red'] },
  { q: 'Where should the new endpoint live?', options: ['/api/v2/orders', '/api/orders/v2', '/orders, no prefix'] },
];
const COMMANDS = ['npm run migrate', 'rm -rf build', 'git push --force-with-lease', 'docker compose down'];
const PERMIT = (cmd) => ['Yes', `Yes, and don't ask again for ${cmd.split(' ')[0]} commands`, 'No, and tell Claude what to do differently'];

// post(events) ingests; returns { id, answer(meant) } for talk() in index.mjs
export function runPlayground(post, { fast = false } = {}) {
  const k = fast ? 0.4 : 1;
  const base = { agent: PLAYGROUND, harness: 'claude-code', name: 'playground · talk to me' };
  const say = (e) => post({ ...base, ...e });
  const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000 * k));
  let reply = null; // resolves the question being asked
  let stopped = false; // "stop" while it works

  // ask and wait for the driver; meta says what the game should offer
  const ask = (e) => new Promise((r) => { reply = r; say(e); });

  async function work(what, steps = 3) {
    stopped = false;
    say({ status: 'working', message: what, meta: { prompt: null, choices: null, task: what } });
    for (let i = 0; i < steps; i++) {
      await sleep(1.6);
      if (stopped) {
        say({ text: `${C.red}  ⎿  Interrupted by user${C.reset}\n` });
        return false;
      }
      const tool = ['Read', 'Edit', 'Bash'][i % 3];
      say({ message: `${tool} src/cache.ts`, text: `${C.yellow}⏺${C.reset} ${C.bold}${tool}${C.reset}(src/cache.ts)\n${C.grey}  ⎿  ${20 + i * 37} lines${C.reset}\n` });
    }
    return true;
  }

  async function prompt(message) {
    // at its prompt: anything said is the next task
    const m = await ask({ status: 'done', message, meta: { prompt: 'input', choices: null }, text: `\n${C.green}${C.bold}✔${C.reset} ${message}\n${C.grey}  (say anything: it becomes the next task)${C.reset}\n` });
    if (m.kind === 'stop' || m.kind === 'none') return;
    say({ text: `\n${C.mag}${C.bold}❯${C.reset} ${C.bold}${m.text}${C.reset}\n\n` });
    await work(m.text, 3);
  }

  async function question(n) {
    const { q, options } = QUESTIONS[n % QUESTIONS.length];
    const m = await ask({
      status: 'waiting', message: q, meta: { prompt: 'menu', choices: options, task: 'Set up the order cache' },
      text: `\n${C.mag}${C.bold}? ${q}${C.reset}\n${options.map((o, i) => `${C.mag}  ${i + 1}. ${o}${C.reset}`).join('\n')}\n`,
    });
    const at = m.kind === 'choose' ? +m.keys[0].key - 1 : m.kind === 'yes' ? 0 : -1;
    if (options[at]) {
      say({ text: `${C.green}  ⎿  ${at + 1}. ${options[at]}${C.reset}\n` });
      await work(`Going with ${options[at]}`, 2);
    } else if (m.kind === 'choose') {
      say({ text: `${C.red}  ⎿  There is no option ${m.keys[0].key}: there are ${options.length}${C.reset}\n` });
      return question(n);
    } else if (m.kind === 'message') {
      say({ text: `${C.grey}  ⎿  None of those${C.reset}\n${C.mag}${C.bold}❯${C.reset} ${C.bold}${m.text}${C.reset}\n` });
      await work(`Doing it your way: ${m.text}`, 2);
    } else {
      say({ text: `${C.grey}  ⎿  Dismissed${C.reset}\n` });
      await prompt('Skipped the question. What should I do instead?');
    }
  }

  async function permission(n) {
    const cmd = COMMANDS[n % COMMANDS.length];
    const choices = PERMIT(cmd);
    const m = await ask({
      status: 'waiting', message: `Allow Bash(${cmd})?`, meta: { prompt: 'menu', choices },
      text: `\n${C.mag}${C.bold}? Allow ${C.reset}${C.bold}Bash(${cmd})${C.mag}${C.bold}?${C.reset}\n${choices.map((o, i) => `${C.mag}  ${i + 1}. ${o}${C.reset}`).join('\n')}\n`,
    });
    const at = m.kind === 'choose' ? +m.keys[0].key : m.kind === 'yes' ? 1 : m.kind === 'no' ? 3 : 0;
    if (at === 1 || at === 2) {
      say({ text: `${C.green}  ⎿  ${at === 2 ? `allowed, and ${cmd.split(' ')[0]} will not be asked about again` : 'allowed'}${C.reset}\n${C.grey}$ ${cmd}${C.reset}\n${C.green}  done in 1.2 s${C.reset}\n` });
      await work('Carrying on', 1);
    } else if (m.kind === 'message') {
      say({ text: `${C.red}  ⎿  Denied${C.reset}\n${C.mag}${C.bold}❯${C.reset} ${C.bold}${m.text}${C.reset}\n` });
      await work(m.text, 2);
    } else {
      say({ text: `${C.red}  ⎿  Denied${C.reset}\n` });
      await prompt(`I did not run ${cmd}. What should I do instead?`);
    }
  }

  (async () => {
    await sleep(2);
    say({ status: 'idle', meta: { cwd: '~/src/playground', model: 'claude-opus-5-5', input: 'mock' }, text: `${C.grey}claude-code · a mock agent to practise on · hold Space here and talk${C.reset}\n` });
    for (let n = 0; ; n++) {
      await sleep(2);
      await question(n);
      await sleep(2);
      await permission(n);
      await sleep(2);
      await prompt('Finished the step. What next?');
    }
  })();

  return {
    id: PLAYGROUND,
    // what the driver said or picked, read by intent.js; returns a note for the game when it was not a reply
    answer(meant) {
      if (reply) { const r = reply; reply = null; r(meant); return null; }
      if (meant.kind === 'stop' || meant.kind === 'no') { stopped = true; return 'interrupted'; }
      say({ text: `${C.grey}  (queued: ${meant.text})${C.reset}\n` });
      return 'queued until it is done';
    },
  };
}
