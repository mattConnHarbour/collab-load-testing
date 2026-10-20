import fs from 'node:fs/promises';
import path from 'node:path';
import { cpuRecorder, epochNow, jsonLog, nodeRecorder, wireInfo } from './profile-common.mjs';

export async function browserProfiler(context, page, id, directory) {
  const log = jsonLog(path.join(directory, `${id}-browser-events.jsonl`));
  const root = await context.newCDPSession(page);
  const channels = [];
  const workers = new Map();
  const setups = [];
  let active = false, offset = 0, counter = 0, timer;
  const record = event => { if (active) log.record({ user: id, ...event }); };
  const notice = (name, method, params) => {
    if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
      const bytes = Buffer.from(params.response.payloadData, params.response.opcode === 2 ? 'base64' : 'utf8');
      record({ type: method.endsWith('Sent') ? 'ws-send' : 'ws-receive', target: name,
        atEpochMs: params.timestamp * 1000 + offset, requestId: params.requestId, ...wireInfo(bytes) });
    }
  };
  for (const method of ['Network.webSocketFrameSent', 'Network.webSocketFrameReceived']) root.on(method, params => notice('page', method, params));
  root.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
    const worker = workers.get(sessionId); if (!worker) return;
    const packet = JSON.parse(message);
    if (packet.id) {
      const pending = worker.pending.get(packet.id);
      if (pending) { worker.pending.delete(packet.id); clearTimeout(pending.timer); packet.error ? pending.reject(new Error(packet.error.message)) : pending.resolve(packet.result); }
      else if (packet.result?.profile) {
        const file = `${id}-${worker.name}-late-${packet.id}.cpuprofile`;
        void fs.writeFile(path.join(directory, file), JSON.stringify(packet.result.profile)).then(() => log.record({ type: 'cpu-profile-late', name: worker.name, file })).catch(error => log.record({ type: 'profiling-error', message: error.message }));
      }
    } else if (packet.method) notice(worker.name, packet.method, packet.params);
  });
  root.on('Target.detachedFromTarget', ({ sessionId }) => {
    const worker = workers.get(sessionId); if (!worker) return;
    worker.detached = true;
    worker.cpu?.abandon();
    record({ type: 'worker-terminated', name: worker.name });
  });
  root.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    if (targetInfo.type !== 'worker') return;
    const name = `worker-${++counter}`;
    const pending = new Map(); let sequence = 0;
    const channel = { name, pending, send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const packetId = ++sequence;
        const timeout = setTimeout(() => { pending.delete(packetId); reject(new Error(`${name} ${method} timed out`)); }, method === 'Profiler.stop' ? 120000 : 30000);
        pending.set(packetId, { resolve, reject, timer: timeout });
        root.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: packetId, method, params }) }).catch(reject);
      });
    } };
    workers.set(sessionId, channel);
    const setup = channel.send('Network.enable').then(async () => {
      channels.push(channel);
      if (active && !channel.detached) channel.cpu = await cpuRecorder(channel, directory, `${id}-${name}`, log.record);
    }).catch(error => log.record({ type: 'profiling-error', name, message: error.message }));
    setups.push(setup);
  });
  await root.send('Network.enable');
  await root.send('Performance.enable');
  await root.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
  await page.exposeBinding('__recordOperation', (_source, event) => record({ target: 'page', ...event }));
  await page.addInitScript(() => {
    const publish = data => window.__recordOperation(data).catch(() => {});
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) publish({ type: 'long-task', atEpochMs: performance.timeOrigin + entry.startTime, durationMs: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) if (entry.name === 'keydown' || entry.name === 'beforeinput' || entry.name === 'input') publish({ type: 'input-event', event: entry.name, atEpochMs: performance.timeOrigin + entry.startTime,
          durationMs: entry.duration, inputDelayMs: entry.processingStart - entry.startTime, processingMs: entry.processingEnd - entry.processingStart });
      }).observe({ type: 'event', durationThreshold: 16, buffered: true });
    } catch {}
  });
  channels.push({ name: 'page', send: (method, params) => root.send(method, params) });
  let stopped = false;
  return {
    async start() {
      await Promise.all(setups);
      const before = epochNow();
      const { metrics } = await root.send('Performance.getMetrics');
      const after = epochNow();
      offset = (before + after) / 2 - metrics.find(metric => metric.name === 'Timestamp').value * 1000;
      active = true;
      record({ type: 'cdp-clock', offset, uncertaintyMs: (after - before) / 2, targets: channels.map(channel => channel.name) });
      await Promise.all(channels.filter(channel => !channel.detached).map(async channel => { channel.cpu = await cpuRecorder(channel, directory, `${id}-${channel.name}`, log.record); }));
      let sampling = false;
      timer = setInterval(async () => {
        if (sampling || !active) return; sampling = true;
        try { const { metrics } = await root.send('Performance.getMetrics'); record({ type: 'browser-metrics', metrics: Object.fromEntries(metrics.map(metric => [metric.name, metric.value])) }); }
        catch (error) { record({ type: 'profiling-error', message: error.message }); }
        finally { sampling = false; }
      }, 2000);
      timer.unref();
    },
    async stop() {
      if (stopped) return; stopped = true; clearInterval(timer);
      await Promise.allSettled(channels.filter(channel => !channel.detached).map(channel => channel.cpu?.stop()));
      active = false;
      for (const worker of workers.values()) for (const pending of worker.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Profiling stopped')); }
      await log.close();
      await root.detach().catch(() => {});
    },
  };
}

export async function startGeneratorProfiling(directory) {
  await fs.mkdir(directory, { recursive: true });
  return nodeRecorder(directory, 'generator');
}
