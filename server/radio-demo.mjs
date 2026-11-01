// A demo DJ: a show of made-up news (GitHub, Slack, CI, the calendar), with music picked to go with it, so you can
// hear what an agent DJ does before you set one up. The mock agents (`npm run dev`) run it in-process; on its own
// it posts to a running server, the desktop app's too:
//   npm run radio:demo [-- --every 30]        AGENT_CITY_URL (default http://127.0.0.1:5210), AGENT_CITY_TOKEN
// A real DJ posts the same requests (docs/AGENT-API.md, The radio), with what it found instead of this script.
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const DJ = { agent: 'demo-radio', name: 'Agent Radio' };

export const SHOW = [
  { category: 'synthwave', from: 'AGENT RADIO', announce: 'You are tuned to Agent Radio, the station your agents run. News from your queues, and music for the drive.' },
  { from: 'GITHUB', when: 'break', announce: 'Pull request one forty two, add retries to the payment webhook, has two approvals and green checks. It is ready to merge.' },
  { from: 'SLACK · #PLATFORM', announce: 'From the platform channel: the staging database migration finished in eleven minutes, and the deploy freeze lifts at six.' },
  { category: 'cyberpunk', from: 'CI', announce: 'The nightly build failed on the billing service: two tests time out against the sandbox. The last green build was yesterday at noon.' },
  { from: 'CALENDAR', announce: 'Your design review starts in fifteen minutes, in the Kowloon room.' },
  { skip: true, from: 'AGENT RADIO', announce: 'Not feeling this one. Next.' },
  { from: 'GITHUB', when: 'break', announce: 'Three pull requests wait for your review. The oldest, a typo fix in the onboarding docs, has waited four days.' },
  { category: 'ambient', from: 'AGENT RADIO', when: 'break', announce: 'Quiet hour. Nothing urgent in the queues. Something slower for the drive.' },
  { from: 'DEPLOYS', announce: 'Version two point four of the API is live in production. Error rates are flat and latency is down eight percent.' },
  { category: 'neon fm', from: 'AGENT RADIO', announce: 'Handing over to NEON FM, the city\'s own station, for a while. Back with more soon.' },
  { category: 'synthwave', from: 'SLACK · #RANDOM', announce: 'And from the random channel: someone left a cake in the kitchen on the fourth floor. It will not last.' },
];

// post(body) sends one request (null back: nobody listens, the segment waits); every: seconds between segments;
// first: seconds before the first
export function runRadioDemo(post, { every = 45, first = 2 } = {}) {
  let i = 0;
  const next = async () => {
    let wait = every;
    try {
      const r = await post({ ...DJ, ...SHOW[i % SHOW.length] });
      if (r === null) wait = 2; // nobody listens yet: ask again soon
      else { i++; if (r?.ok === false) console.warn('[radio-demo]', r.error); }
    } catch (e) { console.warn('[radio-demo]', e.message); }
    setTimeout(next, wait * 1000).unref?.();
  };
  setTimeout(next, first * 1000).unref?.();
}

// on its own: post over HTTP until stopped (the basename check: compiled into the app's server, argv[1] is that)
if (process.argv[1] === fileURLToPath(import.meta.url) && basename(process.argv[1]) === 'radio-demo.mjs') {
  const url = `${process.env.AGENT_CITY_URL || 'http://127.0.0.1:5210'}/api/radio`;
  const token = process.env.AGENT_CITY_TOKEN;
  const at = process.argv.indexOf('--every');
  const every = at > 0 ? +process.argv[at + 1] || 45 : 45;
  console.log(`[radio-demo] on the air at ${url}, a segment every ${every} s (ctrl-c to stop)`);
  const post = async (body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
    const j = await r.json();
    console.log(`[radio-demo] ${body.from}: ${body.announce.slice(0, 70)}…${body.category ? ` · music: ${body.category}` : ''}${body.skip ? ' · skip' : ''}`);
    return j;
  };
  runRadioDemo(post, { every, first: 0 });
  setInterval(() => {}, 1 << 30); // keep running: the show's timers do not
  process.on('SIGINT', async () => { await fetch(url, { method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {} }).catch(() => {}); process.exit(0); });
}
