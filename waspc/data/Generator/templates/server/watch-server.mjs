/** Keep nodemon's direct child alive until its entire owned server group stops. */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

function groupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function waitForGroup(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (groupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(20);
  }
  return true;
}
async function stopGroup(pid, graceMs, killWaitMs) {
  if (!groupExists(pid)) return;
  signalGroup(pid, 'SIGTERM');
  if (await waitForGroup(pid, graceMs)) return;
  signalGroup(pid, 'SIGKILL');
  if (!await waitForGroup(pid, killWaitMs)) throw new Error('Owned server process group did not stop.');
}

export async function supervise({ command = 'npm', args = ['run', 'bundle-and-start'],
  cwd = process.cwd(), graceMs = 5000, killWaitMs = 2000, platform = process.platform } = {}) {
  if (platform === 'win32') throw new Error('The development server supervisor requires POSIX process groups.');
  const child = spawn(command, args, { cwd, stdio: 'inherit', detached: true });
  let requestedSignal;
  let stopping;
  const stop = () => stopping ??= stopGroup(child.pid, graceMs, killWaitMs);
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGUSR2'].map(signal => [signal, () => {
    requestedSignal ??= signal;
    // Keep the supervisor alive: nodemon restarts only after this child exits.
    stop().catch(() => {}); // The awaited cleanup below reports a failure.
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    // npm/shell can exit first; descendants remain in the detached owned group.
    await stop();
    if (requestedSignal) return requestedSignal === 'SIGINT' ? 130 : requestedSignal === 'SIGTERM' ? 143 : 0;
    return result.code ?? (result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1);
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  supervise().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`[Wasp watcher] ${error.message}`);
    process.exitCode = 1;
  });
}
