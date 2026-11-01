// What a spoken line asks an agent for, given what the agent is showing. Pure: the game (talk.js) shows the
// answer before it is sent, the server tests run it too.
//
// An agent at a choice (a permission prompt, a question with options: `prompt: 'menu'`, or `waiting` with no
// prompt given) takes quick actions as key presses:
//   "select 2", "option two", "the second one", "select b"  -> the key 2 (letters count a = 1, b = 2, …)
//   an option's own words ("yes, and don't ask again")       -> that option's number, when the choices are known
//   "yes", "go", "okay", "that's okay", "do it"              -> Enter, which takes the highlighted (first) option
//   "no", "deny", "cancel"                                   -> Escape
//   anything else                                            -> Escape, then the words as a message
// Otherwise the words are typed as a message and sent with Enter, except a bare "stop" / "cancel" / "wait", which is
// Escape: in Claude Code and Codex that interrupts a working agent.
//
// Returns { kind, label, keys, text }: keys is a list of { key } ('enter', 'escape', '1'…'9') and { text } steps.

const NUM = { one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9 };
const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, last: -1 };
const LETTER = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, bee: 2, be: 2, see: 3, sea: 3, dee: 4 };

// a "yes" is made only of these words, with at least one strong one ("that is" alone is not a yes)
const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'alright', 'all', 'right', 'go', 'ahead', 'do', 'it', 'approve', 'approved', 'allow', 'accept', 'confirm', 'proceed', 'continue', "that's", 'that', 'is', 'fine', 'sounds', 'looks', 'good', 'great', 'lgtm', 'please', 'for', 'run', 'ship', 'just', 'then', 'perfect', 'press', 'hit', 'enter', 'return']);
const YES_STRONG = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'alright', 'go', 'approve', 'approved', 'allow', 'accept', 'confirm', 'proceed', 'continue', 'fine', 'good', 'great', 'lgtm', 'do', 'run', 'ship', 'perfect', 'enter', 'return']);
const NO_WORDS = new Set(['no', 'nope', 'nah', "don't", 'do', 'not', 'deny', 'reject', 'cancel', 'never', 'mind', 'please', 'it', 'that', 'thanks', 'thank', 'you']);
const NO_STRONG = new Set(['no', 'nope', 'nah', "don't", 'deny', 'reject', 'cancel', 'never']);
const STOP = /^(stop|cancel|wait|hold on|abort|interrupt|escape|stop it|stop that|stop stop)( please)?$/;
const FILLER = /^(uh|um|er|erm|hmm|so|well|and|okay so|ok so)\s+/;

export function clean(said) {
  return String(said ?? '').toLowerCase().replace(/[’`]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

// "select 2", "option b", "the second one", "number two", "2", "b" → 1…9 (or -1 for "the last one"), else 0
export function choiceOf(s, bare) {
  const m = /^(?:(select|choose|pick|option|number|answer|press|take|go with|select option|choose option|pick option|select number|pick number)\s+)?(?:the\s+)?(?:option\s+|number\s+)?(\S+)(?:\s+(?:one|option|please))?$/.exec(s);
  if (!m) return 0;
  const verb = !!m[1], w = m[2];
  let n = /^[1-9]$/.test(w) ? +w : NUM[w] || ORD[w] || 0;
  // a bare letter only counts after a verb ("select b"), or on its own at a choice ("b")
  if (!n && LETTER[w] && (verb || bare)) n = LETTER[w];
  // a bare number word is a choice only when it is all that was said ("two", "the second one"), not "to" or "for"
  if (!verb && !/^[1-9]$/.test(w) && !ORD[w] && !(bare && (NUM[w] || LETTER[w])) && !/\bnumber\b|\boption\b/.test(s)) return 0;
  if (!verb && (w === 'to' || w === 'too' || w === 'for' || w === 'won' || w === 'ate')) return 0;
  return n;
}

const only = (words, all, strong) => words.length > 0 && words.every((w) => all.has(w)) && words.some((w) => strong.has(w));

export function intent(said, { status, prompt, choices } = {}) {
  const text = String(said ?? '').trim();
  let s = clean(text);
  while (FILLER.test(s)) s = s.replace(FILLER, '');
  const words = s ? s.split(' ') : [];
  if (!words.length) return { kind: 'none', label: 'NOTHING HEARD', keys: [], text: '' };
  const menu = prompt === 'menu' || (status === 'waiting' && !prompt);
  const press = (n, label) => ({ kind: 'choose', label: label || `PRESS ${n}`, keys: [{ key: String(n) }], text });
  if (menu) {
    const opts = Array.isArray(choices) ? choices.map((c) => clean(c)) : [];
    // the option's own words first: an option can itself be "yes" or "no"
    if (opts.length) {
      let at = opts.indexOf(s);
      // the start of a longer option ("yes and don't ask again" for "Yes, and don't ask again for npm commands")
      if (at < 0 && s.length >= 5) at = opts.findIndex((o) => o.startsWith(s));
      // an option inside what was said ("yes please"), the longest one
      if (at < 0) {
        const hit = opts.map((o, i) => [o, i]).filter(([o]) => o.length > 2 && s.includes(o)).sort((a, b) => b[0].length - a[0].length)[0];
        if (hit) at = hit[1];
      }
      if (at >= 0 && at < 9) return press(at + 1, `PRESS ${at + 1} · ${String(choices[at]).toUpperCase().slice(0, 40)}`);
    }
    let n = choiceOf(s, true);
    if (n === -1) n = opts.length || 0;
    if (n > 0) return press(n, opts[n - 1] ? `PRESS ${n} · ${String(choices[n - 1]).toUpperCase().slice(0, 40)}` : undefined);
    if (only(words, YES_WORDS, YES_STRONG)) return { kind: 'yes', label: 'YES · ENTER', keys: [{ key: 'enter' }], text };
    if (only(words, NO_WORDS, NO_STRONG) || STOP.test(s)) return { kind: 'no', label: 'NO · ESC', keys: [{ key: 'escape' }], text };
    // something else at a choice: decline it, then say what to do instead (Claude Code's "tell Claude what to do
    // differently")
    return { kind: 'message', label: 'ESC · MESSAGE', keys: [{ key: 'escape' }, { text }, { key: 'enter' }], text };
  }
  if (STOP.test(s)) return { kind: 'stop', label: 'STOP · ESC', keys: [{ key: 'escape' }], text };
  return { kind: 'message', label: 'MESSAGE', keys: [{ text }, { key: 'enter' }], text };
}
