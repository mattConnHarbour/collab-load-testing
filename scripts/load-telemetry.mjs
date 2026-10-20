import fs from 'node:fs/promises';
import path from 'node:path';

export function emptyTrace(text) {
  return { keys: [], renders: [], samples: [], final: {}, errors: [], intendedText: text };
}

export function applyTelemetry(trace, event) {
  if (event.type === 'key') trace.keys.push(event.data);
  if (event.type === 'render') {
    trace.renders.push(event.data);
    trace.final[event.data.user] = event.data.text;
  }
  if (event.type === 'sample') trace.samples.push(event.data);
  if (event.type === 'errors') trace.errors = event.data;
}

export function createTelemetry(directory, snapshot, intervalMs = 1000) {
  const errors = [];
  let buffer = [];
  let pending = Promise.resolve(), closed = false;
  const append = (event) => { if (!closed) buffer.push(JSON.stringify({ receivedAt: performance.now(), ...event }) + '\n'); };
  const flush = () => {
    const batch = buffer.join('');
    buffer = [];
    const checkpoint = JSON.stringify(snapshot(), null, 2);
    pending = pending.then(async () => {
      if (batch) await fs.appendFile(path.join(directory, 'events.jsonl'), batch);
      const temporary = path.join(directory, 'checkpoint.tmp');
      await fs.writeFile(temporary, checkpoint);
      await fs.rename(temporary, path.join(directory, 'checkpoint.json'));
    }).catch((error) => { errors.push(error.message); });
    return pending;
  };
  const timer = setInterval(flush, intervalMs);
  timer.unref();
  return { append, flush, errors, async close() { if (closed) return; closed = true; clearInterval(timer); await flush(); } };
}
