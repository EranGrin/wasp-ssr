import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { supervise } from '../../data/Generator/templates/server/watch-server.mjs';
const helper = new URL('../../data/Generator/templates/server/watch-server.mjs', import.meta.url).href;
const posix = { skip: process.platform === 'win32', timeout: 10_000 };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'wasp-watch-owned-'));
  await writeFile(join(dir, 'leaf.cjs'), `const net=require('node:net');const mode=process.argv[2];
const server=net.createServer();server.on('error',e=>{console.log('BIND_ERROR',e.code);process.exit(9)});
server.listen(Number(process.argv[3]),'127.0.0.1',()=>console.log('READY',process.pid));
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
