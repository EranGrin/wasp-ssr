import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { supervise, linuxGroupState, groupExists, darwinGroupState } from '../../data/Generator/templates/server/watch-server.mjs';
const helper = new URL('../../data/Generator/templates/server/watch-server.mjs', import.meta.url).href;
const posix = { skip: process.platform === 'win32', timeout: 10_000 };
function procFixture(records, options = {}) {
  const files = new Map(Object.entries(records).map(([pid, { state, group, start = '100' }]) => {
    const fields = Array(20).fill('0');
    fields[0] = state; fields[1] = '1'; fields[2] = String(group); fields[19] = start;
    return [`/proc/${pid}/stat`, `${pid} (fixture (nested comm)) ${fields.join(' ')}\n`];
  }));
  files.set('/proc/self/mountinfo', '1 0 0:1 / /proc rw - proc proc rw\n');
  return { selfPid: 1, listEntries: () => Object.keys(records), readText: path => {
    if (!files.has(path)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return files.get(path);
  }, ...options };
}
test('Linux census distinguishes active owned members from stable zombie-only groups', () => {
  const records = { 1: { state: 'S', group: 99 }, 2: { state: 'Z', group: 42 } };
  assert.equal(linuxGroupState(42, procFixture(records)), 'zombie-only');
  assert.equal(linuxGroupState(42, procFixture({ ...records, 3: { state: 'S', group: 42 } })), 'live');
  assert.equal(linuxGroupState(42, procFixture({ ...records, 3: { state: 'S', group: 88 } })), 'zombie-only');
  assert.equal(linuxGroupState(43, procFixture(records)), 'unknown');
});
test('Linux census fails closed on denied, hidden, malformed or changing visibility', () => {
  const records = { 1: { state: 'S', group: 99 }, 2: { state: 'Z', group: 42 } };
  const good = procFixture(records);
  for (const options of [
    { listEntries: () => { throw new Error('denied'); } },
    { listEntries: () => ['2'] },
    { readText: path => path.endsWith('mountinfo') ? '1 0 0:1 / /proc rw - proc proc rw,hidepid=2\n' : good.readText(path) },
    { readText: path => path === '/proc/2/stat' ? 'invalid stat' : good.readText(path) },
    { readText: path => { if (path === '/proc/1/stat') throw Object.assign(new Error('hidden self'), { code: 'ENOENT' }); return good.readText(path); } },
    { readText: path => { if (path === '/proc/2/stat') throw Object.assign(new Error('denied'), { code: 'EACCES' }); return good.readText(path); } },
  ]) assert.equal(linuxGroupState(42, procFixture(records, options)), 'unknown');
  let censusCalls = 0;
  assert.equal(linuxGroupState(42, procFixture(records, { listEntries: () => ++censusCalls === 1 ? ['1', '2'] : ['1', '2', '3'] })), 'unknown');
  let statCalls = 0;
  assert.equal(linuxGroupState(42, procFixture(records, { readText: path => path === '/proc/2/stat' && ++statCalls === 2
    ? good.readText(path).replace(/100\n$/, '101\n') : good.readText(path) })), 'unknown');
});
test('Linux census refuses unread listed PIDs even when names reappear unchanged', () => {
  const records = { 1: { state: 'S', group: 99 }, 2: { state: 'Z', group: 42 }, 3: { state: 'S', group: 88 } };
  const good = procFixture(records);
  for (const code of ['ENOENT', 'ESRCH']) {
    let reads = 0;
    const view = procFixture(records, { readText: path => {
      if (path === '/proc/3/stat' && ++reads === 1) throw Object.assign(new Error('temporarily gone'), { code });
      return good.readText(path);
    } });
    assert.equal(linuxGroupState(42, view), 'unknown');
  }
});
test('Linux census revalidates unrelated PID identity and group before declaring zombie-only', () => {
  const records = { 1: { state: 'S', group: 99 }, 2: { state: 'Z', group: 42 }, 3: { state: 'S', group: 88 } };
  const good = procFixture(records);
  for (const changed of [
    { state: 'S', group: 42 },
    { state: 'S', group: 88, start: '101' },
  ]) {
    const after = procFixture({ ...records, 3: changed });
    let reads = 0;
    assert.equal(linuxGroupState(42, procFixture(records, { readText: path =>
      path === '/proc/3/stat' && ++reads === 2 ? after.readText(path) : good.readText(path),
    })), 'unknown');
  }
});
test('Darwin census: zombie-only and empty groups are stopped; live, changing or failed views are not', () => {
  const ps = rows => () => rows;
  assert.equal(darwinGroupState(42, { runPs: ps('  42    42 Z\n  43    42 Z+\n  50     1 Ss\n') }), 'zombie-only');
  assert.equal(darwinGroupState(42, { runPs: ps('  50     1 Ss\n') }), 'empty');
  assert.equal(darwinGroupState(42, { runPs: ps('  42    42 Z\n  43    42 S\n') }), 'live');
  let calls = 0;
  const changing = () => (++calls === 1 ? '  42    42 Z\n' : '  42    42 Z\n  44    42 Z\n');
  assert.equal(darwinGroupState(42, { runPs: changing }), 'unknown');
  assert.equal(darwinGroupState(42, { runPs: () => { throw new Error('ps failed'); } }), 'unknown');
});

test('a real zombie-only group on Darwin is reported stopped, a live one is not', { skip: process.platform !== 'darwin' }, async () => {
  // The parent forks a child that leads its own group and exits; the parent
  // never reaps it, so the group holds only a zombie and kill(-pgid, 0)
  // answers EPERM on Darwin.
  const parent = spawn('/usr/bin/python3', ['-c',
    'import os,sys,time\npid=os.fork()\nif pid==0:\n    os.setpgid(0,0); os._exit(0)\nprint(pid,flush=True); time.sleep(5)'],
  { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const [line] = await once(parent.stdout, 'data');
    const pgid = Number(String(line).trim());
    await delay(200);
    assert.throws(() => process.kill(-pgid, 0), { code: 'EPERM' });
    assert.equal(groupExists(pgid, { platform: 'darwin' }), false);
    const live = spawn('sleep', ['5'], { detached: true, stdio: 'ignore' });
    try { assert.equal(groupExists(live.pid, { platform: 'darwin' }), true); }
    finally { process.kill(-live.pid, 'SIGKILL'); }
  } finally { parent.kill('SIGKILL'); }
});

test('unknown or live Linux visibility never marks an existing group stopped', { skip: process.platform !== 'linux' }, () => {
  const fields = readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ');
  const ownGroup = Number(fields[2]);
  const liveView = procFixture({ 1: { state: 'S', group: ownGroup } });
  const unknownView = { readText: () => { throw new Error('visibility denied'); } };
  for (const procOptions of [unknownView, liveView]) assert.equal(groupExists(ownGroup, { procOptions }), true);
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'wasp-watch-owned-'));
  await writeFile(join(dir, 'leaf.cjs'), `const net=require('node:net');const mode=process.argv[2];
const server=net.createServer();server.on('error',e=>{console.log('BIND_ERROR',e.code);process.exit(9)});
server.listen(Number(process.argv[3]),'127.0.0.1',()=>console.log('READY',process.pid));
// nodemon signals the descendant tree as well. Keep this leaf alive so the
// supervisor, rather than nodemon's signal, must finish the delayed shutdown.
process.on('SIGUSR2',()=>{});
process.on('SIGTERM',()=>{if(mode==='delayed')setTimeout(()=>process.exit(0),250);});`);
  await writeFile(join(dir, 'parent.cjs'), `console.log('OWNED_ROOT',process.pid);
require('node:child_process').spawn(process.execPath,['leaf.cjs',...process.argv.slice(2)],{stdio:'inherit'});
process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);
  return dir;
}
async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening'); const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
function start(dir, mode, port, graceMs = 500) {
  const code = `import {supervise} from ${JSON.stringify(helper)};supervise({command:process.execPath,args:['parent.cjs',${JSON.stringify(mode)},'${port}'],cwd:${JSON.stringify(dir)},graceMs:${graceMs},killWaitMs:2000}).then(code=>process.exitCode=code).catch(e=>{console.error(e.message);process.exitCode=1});`;
  const driver = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = '', root;
  driver.stdout.on('data', data => { output += data; root ??= output.match(/OWNED_ROOT (\d+)/)?.[1]; });
  const exited = once(driver, 'exit');
  const ready = new Promise((resolve, reject) => {
    driver.stdout.on('data', () => { if (output.includes('READY')) resolve(); if (output.includes('BIND_ERROR')) reject(new Error(output)); });
    driver.once('exit', () => reject(new Error('Exited before ready: ' + output)));
  });
  const cleanup = () => {
    for (const pid of [root && Number(root), driver.pid]) {
      if (!pid) continue;
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  return { driver, ready, exited, cleanup, output: () => output };
}
test('normal exit preserves status; unsupported platform fails before starting', posix, async () => {
  assert.equal(await supervise({ command: process.execPath, args: ['-e', 'process.exit(7)'] }), 7);
  await assert.rejects(supervise({ platform: 'win32' }), /POSIX/);
});
test('rapid restart waits for delayed owned descendants to release the listener', posix, async () => {
  const dir = await fixture(); const port = await freePort();
  try {
    for (let index = 0; index < 4; index++) {
      const running = start(dir, 'delayed', port);
      try {
        await running.ready; const began = Date.now(); running.driver.kill('SIGUSR2');
        assert.equal((await running.exited)[0], 0);
        assert.ok(Date.now() - began >= 200, 'supervisor exited before delayed descendant');
        assert.doesNotMatch(running.output(), /BIND_ERROR/);
      } finally { running.cleanup(); }
    }
  } finally { await rm(dir, { recursive: true }); }
});
test('stubborn descendants are stopped within the bounded grace period', posix, async () => {
  const dir = await fixture(); const port = await freePort(); const running = start(dir, 'stubborn', port, 100);
  try {
    await running.ready; running.driver.kill('SIGTERM'); assert.equal((await running.exited)[0], 143);
    const probe = net.createServer().listen(port, '127.0.0.1'); await once(probe, 'listening');
    await new Promise(resolve => probe.close(resolve));
  } finally { running.cleanup(); await rm(dir, { recursive: true }); }
});
test('an unrelated listener survives shutdown of the owned server group', posix, async () => {
  const unrelated = net.createServer().listen(0, '127.0.0.1'); await once(unrelated, 'listening');
  const dir = await fixture(); const running = start(dir, 'stubborn', await freePort(), 100);
  try {
    await running.ready; running.driver.kill('SIGINT'); assert.equal((await running.exited)[0], 130);
    const connection = net.connect(unrelated.address().port, '127.0.0.1'); await once(connection, 'connect'); connection.destroy();
  } finally { running.cleanup(); await rm(dir, { recursive: true }); await new Promise(resolve => unrelated.close(resolve)); }
});

test('actual nodemon rapid restarts wait for the owned listener without bind collisions', {
  ...posix, skip: posix.skip || !process.env.WASP_TEST_NODEMON, timeout: 20_000,
}, async () => {
  const dir = await fixture(); const port = await freePort();
  await writeFile(join(dir, 'trigger.txt'), '0');
  await writeFile(join(dir, 'driver.mjs'), `import {supervise} from ${JSON.stringify(helper)};
supervise({command:process.execPath,args:['parent.cjs','delayed','${port}'],cwd:${JSON.stringify(dir)},graceMs:800,killWaitMs:2000})
.then(code=>process.exitCode=code).catch(error=>{console.error(error.message);process.exitCode=1});`);
  const nodemon = spawn(process.execPath, [process.env.WASP_TEST_NODEMON, '--watch', 'trigger.txt', '--ext', 'txt',
    // Match the generated "nodemon --exec node watch-server.mjs" recipe.
    // An absolute executable string selects nodemon's shell-spawn path, whose
    // shell can exit ahead of the supervisor; the literal node recipe forks it.
    '--delay', '0.02', '--signal', 'SIGUSR2', '--exec', 'node', 'driver.mjs'],
    { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; const roots = new Set();
  const collect = data => { output += data; for (const match of output.matchAll(/OWNED_ROOT (\d+)/g)) roots.add(Number(match[1])); };
  nodemon.stdout.on('data', collect); nodemon.stderr.on('data', collect);
  const waitReady = async count => {
    const deadline = Date.now() + 4000;
    while ((output.match(/READY \d+/g) ?? []).length < count) {
      assert.doesNotMatch(output, /BIND_ERROR|Owned server process group did not stop/);
      assert.equal(nodemon.exitCode, null, output);
      assert.ok(Date.now() < deadline, output);
      await delay(20);
    }
  };
  try {
    await waitReady(1);
    for (let index = 0; index < 3; index++) {
      const began = Date.now();
      await writeFile(join(dir, 'trigger.txt'), String(index + 1));
      await waitReady(index + 2);
      assert.ok(Date.now() - began >= 200, 'nodemon restarted before delayed owned descendant stopped');
    }
    assert.doesNotMatch(output, /BIND_ERROR|Owned server process group did not stop/);
  } finally {
    const exited = nodemon.exitCode === null ? once(nodemon, 'exit') : null;
    // Only this fixture's detached nodemon group and recorded owned roots.
    for (const pid of [nodemon.pid, ...roots]) {
      try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await delay(400);
    for (const pid of [nodemon.pid, ...roots]) {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (exited) await exited;
    await rm(dir, { recursive: true });
  }
});
