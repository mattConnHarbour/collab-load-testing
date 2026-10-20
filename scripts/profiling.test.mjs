import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { wireInfo } from './profile-common.mjs';
import { createTelemetry, emptyTrace, applyTelemetry } from './load-telemetry.mjs';

test('transport correlation uses the update bytes rather than connection framing', () => {
  const first = wireInfo(Buffer.from([1, 114, 0, 2, 3, 7, 8, 9]));
  const second = wireInfo(Buffer.from([2, 114, 115, 0, 2, 3, 7, 8, 9]));
  assert.equal(first.kind, 'update');
  assert.equal(first.updateHash, second.updateHash);
  assert.notEqual(first.hash, second.hash);
  assert.equal(wireInfo(Buffer.from([255])).kind, 'unparsed');
});

test('partial key events survive shutdown while an earlier checkpoint is being written', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'load-telemetry-'));
  try {
    const trace = emptyTrace('fox');
    const recorder = createTelemetry(directory, () => ({ keys: trace.keys.length, final: trace.final }), 60000);
    const key = { type: 'key', data: { at: 10, index: 0, key: 'f', expected: 'f' } };
    applyTelemetry(trace, key); recorder.append({ user: 'U01', ...key });
    const pending = recorder.flush();
    const render = { type: 'render', data: { at: 15, user: 'U01', text: 'f' } };
    applyTelemetry(trace, render); recorder.append({ user: 'U01', ...render });
    await recorder.close(); await pending;
    assert.equal(recorder.errors.length, 0);
    const events = (await fs.readFile(path.join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(event => event.type), ['key', 'render']);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'checkpoint.json'), 'utf8')), { keys: 1, final: { U01: 'f' } });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
