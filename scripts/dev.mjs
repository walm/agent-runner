// `npm run dev`: the agent server (with mock agents unless --no-mock) and Vite, together; Ctrl-C stops both.
import { spawn } from 'node:child_process';

const mock = !process.argv.includes('--no-mock');
const procs = [
  spawn(process.execPath, ['server/index.mjs', ...(mock ? ['--mock'] : [])], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5200'], { stdio: 'inherit' }),
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
