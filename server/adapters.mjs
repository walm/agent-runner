// Harness adapters: turn a harness's own hook payload into a city event, so the hook on the harness side is a
// bare `curl --data-binary @-` with no jq or script. POST /api/hooks/<name>.
import { basename } from 'node:path';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', mag: '\x1b[35m', grey: '\x1b[90m' };
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function toolSummary(name, input = {}) {
  const arg = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? input.query;
  return arg !== undefined ? `${name}(${clip(arg, 120)})` : name;
}

// where the agent runs, for typing what the driver says into its terminal (typer.mjs): the host, and the process
// id the hook sends (`pid=$PPID`, the harness's own process)
function where(host, pid) {
  const n = Number(pid);
  return { ...(host ? { host } : {}), ...(Number.isInteger(n) && n > 1 ? { pid: n } : {}) };
}

// what the agent shows while it waits, so a spoken "select 2" or "yes" becomes the right key (src/agents/intent.js):
// prompt 'menu' (a choice, with its options' labels when known) or 'input' (a text prompt); null when it works
const MENU_CHOICES = ['Yes', "Yes, and don't ask again", 'No'];
const quiet = { prompt: null, choices: null };
const label = (o) => clip(typeof o === 'string' ? o : o?.label, 60);

// Claude Code hooks (settings.json "hooks"): every event gets the JSON on stdin with session_id, cwd and
// hook_event_name. One agent per host and working directory; the session id goes in meta.
export function claudeCode(p, { host, pid } = {}) {
  if (!p || typeof p !== 'object' || !p.hook_event_name) return { error: 'expected a Claude Code hook payload (hook_event_name missing)' };
  const cwd = p.cwd || 'unknown';
  const base = {
    agent: `claude-code:${host || 'local'}:${cwd}`,
    harness: 'claude-code',
    name: basename(cwd) || cwd,
    meta: { cwd, session: p.session_id, ...where(host, pid), ...(p.permission_mode ? { mode: p.permission_mode } : {}) },
  };
  const busy = { ...base, meta: { ...base.meta, ...quiet } };
  switch (p.hook_event_name) {
    case 'SessionStart':
      return { ...busy, status: 'idle', message: `Session ${p.source || 'started'}`, text: `${C.grey}── session ${p.source || 'start'} · ${p.session_id || ''} ──${C.reset}\n` };
    case 'UserPromptSubmit':
      return { ...busy, status: 'working', message: `Prompt: ${clip(p.prompt, 160)}`, meta: { ...busy.meta, task: clip(p.prompt, 200) }, text: `\n${C.mag}${C.bold}❯${C.reset} ${C.bold}${String(p.prompt ?? '').trim()}${C.reset}\n\n` };
    case 'PreToolUse': {
      // a question with options: the agent waits for a choice, which "select 2" or the option's words make
      const q = p.tool_name === 'AskUserQuestion' && [].concat(p.tool_input?.questions || [])[0];
      if (q?.options?.length) {
        const choices = q.options.slice(0, 9).map(label);
        return {
          ...base, status: 'waiting', message: clip(q.question || 'A question for you', 300),
          meta: { ...base.meta, prompt: 'menu', choices },
          text: `\n${C.mag}${C.bold}? ${q.question || ''}${C.reset}\n${choices.map((c, i) => `${C.mag}  ${i + 1}. ${c}${C.reset}`).join('\n')}\n`,
        };
      }
      return { ...busy, status: 'working', message: toolSummary(p.tool_name, p.tool_input), text: `${C.yellow}⏺${C.reset} ${C.bold}${toolSummary(p.tool_name, p.tool_input)}${C.reset}\n` };
    }
    case 'PermissionRequest':
      return {
        ...base, status: 'waiting', message: `Allow ${toolSummary(p.tool_name, p.tool_input)}?`,
        meta: { ...base.meta, prompt: 'menu', choices: MENU_CHOICES },
        text: `\n${C.mag}${C.bold}? Allow ${toolSummary(p.tool_name, p.tool_input)}?${C.reset}\n`,
      };
    case 'PostToolUse': {
      const r = p.tool_response;
      const body = typeof r === 'string' ? r : r?.stdout ?? r?.output ?? r?.content ?? (r ? JSON.stringify(r) : '');
      const lines = String(body ?? '').split('\n').filter(Boolean);
      const shown = lines.slice(0, 6).map((l) => `${C.grey}  ⎿  ${clip(l, 200)}${C.reset}`).join('\n');
      const more = lines.length > 6 ? `\n${C.grey}     … ${lines.length - 6} more lines${C.reset}` : '';
      // a tool that ran was allowed (or answered): the agent is at work again
      return { ...busy, status: 'working', text: shown ? `${shown}${more}\n` : undefined };
    }
    case 'Notification': {
      // newer Claude Codes say which kind; older ones only the words
      const type = p.notification_type || (/permission|approv|allow/i.test(p.message || '') ? 'permission_prompt' : /waiting for your input/i.test(p.message || '') ? 'idle_prompt' : '');
      const prompt = type === 'permission_prompt' || type === 'elicitation_dialog' ? 'menu' : type === 'idle_prompt' ? 'input' : null;
      return {
        ...base, status: 'waiting', message: clip(p.message || 'Needs your attention', 300),
        meta: { ...base.meta, prompt, choices: type === 'permission_prompt' ? MENU_CHOICES : null },
        text: `\n${C.mag}${C.bold}? ${p.message || 'Needs your attention'}${C.reset}\n`,
      };
    }
    case 'Stop':
      return { ...base, status: 'done', message: 'Finished, waiting for the next prompt', meta: { ...base.meta, prompt: 'input', choices: null }, text: `\n${C.green}${C.bold}✔ Turn finished${C.reset}\n` };
    case 'SubagentStop':
      return { ...base, message: 'Subagent finished' };
    case 'PreCompact':
      return { ...base, message: 'Compacting context', text: `${C.dim}… compacting context${C.reset}\n` };
    case 'SessionEnd':
      return { ...base, end: true, message: `Session ended${p.reason ? ` (${p.reason})` : ''}`, text: `${C.grey}── session end ──${C.reset}\n` };
    default:
      return { ...base, message: p.hook_event_name };
  }
}

// Codex `notify` (config.toml: notify = [...]) runs a program with one JSON argument after each turn, e.g.
// { "type": "agent-turn-complete", "thread-id", "turn-id", "cwd", "input-messages": [...], "last-assistant-message" }.
// Field names have moved between Codex versions, so both spellings are read and anything missing is tolerated.
export function codex(p, { host, pid } = {}) {
  if (!p || typeof p !== 'object' || !p.type) return { error: 'expected a Codex notify payload (type missing)' };
  const cwd = p.cwd || p['working-directory'] || 'codex';
  const thread = p['thread-id'] || p.thread_id || p['session-id'];
  const base = { agent: `codex:${host || 'local'}:${cwd}`, harness: 'codex', name: basename(cwd) || cwd, meta: { cwd, ...where(host, pid), ...(thread ? { session: thread } : {}) } };
  if (p.type === 'agent-turn-complete') {
    const asked = [].concat(p['input-messages'] || p.input_messages || []).join(' ');
    const said = String(p['last-assistant-message'] ?? p.last_assistant_message ?? '').trim();
    return {
      ...base, status: 'done',
      message: said ? clip(said, 200) : 'Turn complete',
      meta: { ...base.meta, prompt: 'input', ...(asked ? { task: clip(asked, 200) } : {}) },
      text: `${asked ? `\n${C.mag}${C.bold}❯${C.reset} ${C.bold}${asked}${C.reset}\n\n` : ''}${said ? `${said}\n` : ''}${C.green}${C.bold}✔ Turn complete${C.reset}\n`,
    };
  }
  return { ...base, message: p.type };
}

export const ADAPTERS = { 'claude-code': claudeCode, codex };
