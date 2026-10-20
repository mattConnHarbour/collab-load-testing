import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, fork } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { chromium } from 'playwright';
import { bounded } from '../scripts/load-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function start(file, env = {}) {
  const child = spawn(process.execPath, [file], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  try { await bounded(exited, 5000, 'Smoke service shutdown'); } catch { child.kill('SIGKILL'); await exited; }
}

async function waitForServer(service, origin) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (service.child.exitCode !== null) throw new Error(service.output());
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return response.json();
    } catch {}
    await pause(100);
  }
  throw new Error(`Server did not become ready: ${service.output()}`);
}

async function runGenerator(origin, directory, observerWs) {
  const args = ['scripts/load-test.mjs', '--server-url', origin, '--document', 'server/assets/blank.docx', '--users', '2', '--text', 'fox', '--layout', 'first-two-pages', '--output', directory];
  if (observerWs) args.push('--observer-ws', observerWs);
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const [code] = await bounded(once(child, 'exit'), 90000, 'Distributed smoke test');
    assert.equal(code, 0, output);
    return JSON.parse(await fs.readFile(path.join(directory, 'results.json'), 'utf8'));
  } finally {
    await stop(child);
  }
}

test('server, generator, and independent observer work through local and external worker connections', { timeout: 150000 }, async () => {
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  const artifactRoot = await fs.mkdtemp(path.join(root, 'artifacts', 'distributed-smoke-'));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const service = start('scripts/server.mjs', { PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: '', SERVE_CLIENT: 'true', OPENAI_API_KEY: '', DOCUMENT_ROOT: path.join(artifactRoot, 'data') });
  let external;
  try {
    const health = await waitForServer(service, origin);
    assert.equal(health.role, 'server');
    assert.equal(health.agentEnabled, false);
    const frontend = await fetch(origin);
    assert.equal(frontend.status, 200);
    assert.match(await frontend.text(), /Collab Load Test Harness/);
    assert.equal((await fetch(`${origin}/api/unknown-route`)).status, 404);
    const disabledJob = await fetch(`${origin}/api/rooms/unused/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'test' }) });
    assert.equal(disabledJob.status, 503);

    const local = await runGenerator(origin, path.join(artifactRoot, 'local'));
    assert.equal(local.status, 'passed');
    assert.equal(local.topology.observer.mode, 'local-worker');
    assert.notEqual(local.topology.server.pid, local.topology.loadGenerator.pid);
    assert.notEqual(local.topology.observer.workerPid, local.topology.loadGenerator.pid);
    assert.equal(local.users.reduce((total, user) => total + user.keystrokes.length, 0), 6);
    assert.equal(local.images.length, 2);

    external = fork(path.join(root, 'scripts/observer.mjs'), ['--port', '0', '--quiet'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const [ready] = await bounded(once(external, 'message'), 30000, 'External observer startup');
    const remote = await runGenerator(origin, path.join(artifactRoot, 'external'), ready.endpoint);
    assert.equal(remote.topology.observer.mode, 'remote-worker');
    assert.equal(remote.users.every((user) => user.matches && user.remote.count === 3), true);
    const serialized = JSON.stringify(remote);
    assert.equal(serialized.includes(new URL(ready.endpoint).pathname), false, 'Report must not retain the observer access path');
    assert.equal((await fs.readFile(path.join(artifactRoot, 'external', 'report.html'), 'utf8')).includes('remote-worker'), true);
    const connection = await chromium.connect(ready.endpoint);
    assert.equal((await connection.contexts()).length, 0, 'Finished run must release its contexts');
    await connection.close();
    console.log(`Distributed smoke reports: ${artifactRoot}`);
  } finally {
    if (external) await stop(external);
    await stop(service.child);
  }
});
