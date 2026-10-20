import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { chromium } from 'playwright';

export const browserArgs = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

export async function bounded(operation, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds); })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function calibrateClock(page, timeoutMs = 30000) {
  const attempts = [];
  for (let index = 0; index < 7; index++) {
    const before = performance.now();
    const browserAt = await bounded(page.evaluate(() => performance.now()), timeoutMs, 'Browser clock calibration');
    const after = performance.now();
    attempts.push({ browserAt, controllerAt: (before + after) / 2, offset: (before + after) / 2 - browserAt, uncertaintyMs: (after - before) / 2, roundTripMs: after - before });
  }
  return attempts.sort((a, b) => a.uncertaintyMs - b.uncertaintyMs)[0];
}

async function localObserver(config) {
  const args = ['--port', '0', '--quiet'];
  if (config.headed) args.push('--headed');
  const child = fork(fileURLToPath(new URL('./observer.mjs', import.meta.url)), args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    try { await bounded(exited, 5000, 'Observer worker shutdown'); } catch { child.kill('SIGKILL'); await exited; }
  };
  try {
    const ready = await bounded(new Promise((resolve, reject) => {
      child.once('message', (message) => message.type === 'ready' ? resolve(message) : reject(new Error('Invalid observer worker startup message')));
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`Observer worker exited during startup (${signal ?? code})`)));
    }), config.timeoutMs, 'Observer worker startup');
    return { ...ready, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function createBrowserRoles(config) {
  let writers;
  let observer;
  let worker;
  const close = async () => {
    const results = await Promise.allSettled([writers?.close(), observer?.close()]);
    if (worker) await worker.close();
    for (const result of results) if (result.status === 'rejected') console.error(`Browser shutdown: ${result.reason.message}`);
  };
  try {
    writers = await chromium.launch({ headless: !config.headed, args: browserArgs, timeout: config.timeoutMs });
    worker = config.observerWs ? undefined : await localObserver(config);
    const endpoint = config.observerWs ?? worker.endpoint;
    observer = await chromium.connect(endpoint, { timeout: config.timeoutMs });
    return {
      writers, observer, close,
      topology: {
        loadGenerator: { hostname: os.hostname(), pid: process.pid, cpuCount: os.availableParallelism() },
        observer: {
          mode: worker ? 'local-worker' : 'remote-worker', endpointOrigin: new URL(endpoint).origin,
          hostname: worker?.hostname ?? new URL(endpoint).hostname, workerPid: worker?.workerPid ?? null,
          browserPid: worker?.browserPid ?? null,
        },
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
