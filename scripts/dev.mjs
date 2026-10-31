// `npm run dev`: the agent server (with mock agents unless --no-mock) and Vite, together; Ctrl-C stops both.
// --lan: Vite on every interface over https (self-signed), for a headset on the same network. The agent server
// stays on 127.0.0.1: the headset reaches it through Vite's /api proxy.
import { spawn } from 'node:child_process';

const mock = !process.argv.includes('--no-mock');
const lan = process.argv.includes('--lan');
const procs = [
  spawn(process.execPath, ['server/index.mjs', ...(mock ? ['--mock'] : [])], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', lan ? '0.0.0.0' : '127.0.0.1', '--port', '5200'], {
    stdio: 'inherit',
    env: lan ? { ...process.env, HTTPS: '1' } : process.env,
  }),
];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
};
for (const p of procs) p.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
