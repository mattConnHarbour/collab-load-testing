import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Session } from 'node:inspector/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export const epochNow = () => performance.timeOrigin + performance.now();

export function wireInfo(input) {
  const buffer = Buffer.from(input);
  const result = { bytes: buffer.length, hash: createHash('sha256').update(buffer).digest('hex') };
  let offset = 0;
  const uint = () => {
    let value = 0, shift = 0;
    for (let count = 0; count < 8; count++) {
      if (offset >= buffer.length) throw new Error('Truncated frame');
      const byte = buffer[offset++];
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
      shift += 7;
    }
    throw new Error('Oversized integer');
  };
  try {
    const nameBytes = uint();
    offset += nameBytes;
    result.messageType = uint();
    result.kind = result.messageType === 1 ? 'awareness' : 'other';
    if (result.messageType === 0 || result.messageType === 4) {
      result.syncType = uint();
      result.kind = result.syncType === 2 ? 'update' : 'sync';
      if (result.syncType === 2) {
        const length = uint();
        if (offset + length > buffer.length) throw new Error('Truncated update');
        result.updateHash = createHash('sha256').update(buffer.subarray(offset, offset + length)).digest('hex');
      }
    }
  } catch { result.kind = 'unparsed'; }
  return result;
}

export function jsonLog(file) {
  const stream = createWriteStream(file);
  const errors = [];
  stream.on('error', error => errors.push(error.message));
  let closed = false;
  return {
    errors,
    record(event) { if (!closed) stream.write(JSON.stringify({ atEpochMs: epochNow(), ...event }) + '\n'); },
    close() { closed = true; return new Promise(resolve => { if (stream.destroyed) resolve(); else stream.end(resolve); }); },
  };
}

export async function cpuRecorder(channel, directory, name, record) {
  await fs.mkdir(directory, { recursive: true });
  await channel.send('Profiler.enable');
  await channel.send('Profiler.setSamplingInterval', { interval: 2000 });
  await channel.send('Profiler.start');
  let sequence = 0, closed = false, profiling = true, pending = Promise.resolve();
  const rotate = () => {
    pending = pending.then(async () => {
      if (!profiling) return;
      const { profile } = await channel.send('Profiler.stop');
      profiling = false;
      const file = `${name}-${String(++sequence).padStart(3, '0')}.cpuprofile`;
      await fs.writeFile(path.join(directory, file), JSON.stringify(profile));
      record({ type: 'cpu-profile', name, file, startTime: profile.startTime, endTime: profile.endTime });
      if (!closed) { await channel.send('Profiler.start'); profiling = true; }
    }).catch(error => record({ type: 'profiling-error', name, message: error.message }));
    return pending;
  };
  const timer = setInterval(rotate, 30000);
  timer.unref();
  return { abandon() { closed = true; clearInterval(timer); }, async stop() { if (closed) return; closed = true; clearInterval(timer); await rotate(); } };
}

export async function nodeRecorder(directory, name) {
  await fs.mkdir(directory, { recursive: true });
  const log = jsonLog(path.join(directory, `${name}-events.jsonl`));
  const session = new Session(); session.connect();
  const cpu = await cpuRecorder({ send: (method, params) => session.post(method, params) }, directory, name, log.record);
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  let previousCpu = process.cpuUsage(), previousAt = performance.now(), previousUtilization = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const currentCpu = process.cpuUsage(), currentAt = performance.now(), currentUtilization = performance.eventLoopUtilization();
    const elapsedMs = currentAt - previousAt;
    log.record({ type: 'resource', name, pid: process.pid, elapsedMs,
      cpuPercent: (currentCpu.user + currentCpu.system - previousCpu.user - previousCpu.system) / (elapsedMs * 10),
      ...process.memoryUsage(), eventLoopUtilization: performance.eventLoopUtilization(currentUtilization, previousUtilization).utilization,
      eventLoopMeanMs: Number.isFinite(delay.mean) ? delay.mean / 1e6 : null, eventLoopP95Ms: delay.percentile(95) / 1e6, eventLoopMaxMs: delay.max / 1e6 });
    delay.reset(); previousCpu = currentCpu; previousAt = currentAt; previousUtilization = currentUtilization;
  }, 1000);
  timer.unref();
  return { record: log.record, async stop() { clearInterval(timer); delay.disable(); await cpu.stop(); session.disconnect(); await log.close(); } };
}
