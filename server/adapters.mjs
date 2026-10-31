// Harness adapters: turn a harness's own hook payload into a city event, so the hook on the harness side is a
// bare `curl --data-binary @-` with no jq or script. POST /api/hooks/<name>.
import { basename } from 'node:path';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', mag: '\x1b[35m', grey: '\x1b[90m' };
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function toolSummary(name, input = {}) {
  const arg = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? input.query;
  return arg !== undefined ? `${name}(${clip(arg, 120)})` : name;
}

// Claude Code hooks (settings.json "hooks"): every event gets the JSON on stdin with session_id, cwd and
// hook_event_name. One agent per host and working directory; the session id goes in meta.
export function claudeCode(p, { host } = {}) {
  if (!p || typeof p !== 'object' || !p.hook_event_name) return { error: 'expected a Claude Code hook payload (hook_event_name missing)' };
  const cwd = p.cwd || 'unknown';
  const base = {
    agent: `claude-code:${host || 'local'}:${cwd}`,
    harness: 'claude-code',
    name: basename(cwd) || cwd,
    meta: { cwd, session: p.session_id, ...(p.permission_mode ? { mode: p.permission_mode } : {}) },
  };
  switch (p.hook_event_name) {
    case 'SessionStart':
      return { ...base, status: 'idle', message: `Session ${p.source || 'started'}`, text: `${C.grey}── session ${p.source || 'start'} · ${p.session_id || ''} ──${C.reset}\n` };
    case 'UserPromptSubmit':
      return { ...base, status: 'working', message: `Prompt: ${clip(p.prompt, 160)}`, meta: { ...base.meta, task: clip(p.prompt, 200) }, text: `\n${C.mag}${C.bold}❯${C.reset} ${C.bold}${String(p.prompt ?? '').trim()}${C.reset}\n\n` };
    case 'PreToolUse':
      return { ...base, status: 'working', message: toolSummary(p.tool_name, p.tool_input), text: `${C.yellow}⏺${C.reset} ${C.bold}${toolSummary(p.tool_name, p.tool_input)}${C.reset}\n` };
    case 'PostToolUse': {
      const r = p.tool_response;
      const body = typeof r === 'string' ? r : r?.stdout ?? r?.output ?? r?.content ?? (r ? JSON.stringify(r) : '');
      const lines = String(body ?? '').split('\n').filter(Boolean);
      const shown = lines.slice(0, 6).map((l) => `${C.grey}  ⎿  ${clip(l, 200)}${C.reset}`).join('\n');
      const more = lines.length > 6 ? `\n${C.grey}     … ${lines.length - 6} more lines${C.reset}` : '';
      return { ...base, text: shown ? `${shown}${more}\n` : undefined };
    }
    case 'Notification':
      return { ...base, status: 'waiting', message: clip(p.message || 'Needs your attention', 300), text: `\n${C.mag}${C.bold}? ${p.message || 'Needs your attention'}${C.reset}\n` };
    case 'Stop':
      return { ...base, status: 'done', message: 'Finished, waiting for the next prompt', text: `\n${C.green}${C.bold}✔ Turn finished${C.reset}\n` };
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
export function codex(p, { host } = {}) {
  if (!p || typeof p !== 'object' || !p.type) return { error: 'expected a Codex notify payload (type missing)' };
  const cwd = p.cwd || p['working-directory'] || 'codex';
  const thread = p['thread-id'] || p.thread_id || p['session-id'];
  const base = { agent: `codex:${host || 'local'}:${cwd}`, harness: 'codex', name: basename(cwd) || cwd, meta: { cwd, ...(thread ? { session: thread } : {}) } };
  if (p.type === 'agent-turn-complete') {
    const asked = [].concat(p['input-messages'] || p.input_messages || []).join(' ');
    const said = String(p['last-assistant-message'] ?? p.last_assistant_message ?? '').trim();
    return {
      ...base, status: 'done',
      message: said ? clip(said, 200) : 'Turn complete',
      meta: { ...base.meta, ...(asked ? { task: clip(asked, 200) } : {}) },
      text: `${asked ? `\n${C.mag}${C.bold}❯${C.reset} ${C.bold}${asked}${C.reset}\n\n` : ''}${said ? `${said}\n` : ''}${C.green}${C.bold}✔ Turn complete${C.reset}\n`,
    };
  }
  return { ...base, message: p.type };
}

export const ADAPTERS = { 'claude-code': claudeCode, codex };
