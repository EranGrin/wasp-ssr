/** Keep nodemon's direct child alive until its entire owned server group stops. */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// Signal 0 includes unreaped zombies. They cannot execute or retain listeners,
// but PID 1 in a container may leave them in the owned group indefinitely.
// Only a complete, stable /proc census can establish a zombie-only group.
export function linuxGroupState(group, { procRoot = '/proc', selfPid = process.pid,
  readText = path => readFileSync(path, 'utf8'), listEntries = readdirSync } = {}) {
  try {
    const mount = readText(`${procRoot}/self/mountinfo`).split('\n').find(line => {
      const [fields, filesystem] = line.split(' - ');
      return fields?.split(' ')[4] === '/proc' && filesystem?.startsWith('proc ');
    });
    if (!mount || /\bhidepid=(?!0(?:,|\s|$))[^,\s]+/.test(mount)) return 'unknown';
    const census = () => listEntries(procRoot).filter(name => /^\d+$/.test(name)).sort();
    const before = census();
    if (!before.includes(String(selfPid))) return 'unknown';
    const stat = pid => {
      const text = readText(`${procRoot}/${pid}/stat`);
      // comm can itself contain spaces and parentheses; fields start after its
      // final closing parenthesis. Field 22 (starttime) guards against PID reuse.
      const end = text.lastIndexOf(')');
      if (!text.startsWith(`${pid} (`) || end < 0 || text.slice(end, end + 2) !== ') ') throw new Error('Invalid proc stat');
      const fields = text.slice(end + 2).trim().split(/\s+/);
      if (fields.length < 20 || !/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[19]) || fields[0].length !== 1) throw new Error('Invalid proc stat');
      return { group: Number(fields[2]), state: fields[0], start: fields[19] };
    };
    const observed = [];
    let hasZombie = false;
    for (const pid of before) {
      // Any unread listed PID leaves membership unknown, even if its name
      // reappears before the final census.
      const record = stat(pid);
      observed.push([pid, record]);
      if (record.group !== group) continue;
      if (record.state !== 'Z') return 'live';
      hasZombie = true;
    }
    if (!hasZombie) return 'unknown';
    for (const [pid, initial] of observed) {
      const record = stat(pid);
      // Recheck every member: an initially unrelated live process can join
      // the owned group without changing the set of visible PID names.
      if (record.group !== initial.group || record.start !== initial.start) return 'unknown';
      if (record.group === group && record.state !== 'Z') return 'unknown';
    }
    // A process forked during enumeration may not have been inspected. Retry
    // rather than classifying a partial or changing view as stopped.
    if (JSON.stringify(before) !== JSON.stringify(census())) return 'unknown';
    return 'zombie-only';
  } catch { return 'unknown'; }
}

export function groupExists(pid, { platform = process.platform, procOptions } = {}) {
  try {
    process.kill(-pid, 0);
    return platform !== 'linux' || linuxGroupState(pid, procOptions) !== 'zombie-only';
  }
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
