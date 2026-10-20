import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, measureKeys, makeTimeline } from './load-metrics.mjs';

test('latency records batched text arrivals against each actual keydown', () => {
  const keys = [{ at: 10, expected: 'f' }, { at: 20, expected: 'fo' }, { at: 30, expected: 'fox' }];
  const local = [{ at: 25, text: 'fo' }, { at: 35, text: 'fox' }];
  const remote = [{ at: 50, text: 'fox' }];
  const rows = measureKeys(keys, local, remote, 100, 90);
  assert.deepEqual(rows.map((row) => row.localMs), [15, 5, 5]);
  assert.deepEqual(rows.map((row) => row.remoteMs), [30, 20, 10]);
  assert.deepEqual(rows.map((row) => row.localBatched), [true, false, false]);
});

test('corrupted or missing text remains unobserved rather than receiving a latency', () => {
  const rows = measureKeys([{ at: 10, expected: 'fox' }], [{ at: 20, text: 'xof' }], [], 0, 0);
  assert.equal(rows[0].localMs, null);
  assert.equal(rows[0].remoteMs, null);
  assert.deepEqual(summarize([null, NaN]), { count: 0, p50: null, p95: null, max: null });
});

test('percentiles use nearest rank over observed measurements', () => {
  const result = summarize(Array.from({ length: 100 }, (_, index) => index + 1));
  assert.deepEqual(result, { count: 100, p50: 50, p95: 95, max: 100 });
});

test('timeline separates observer connections and counts typing in a one-second window', () => {
  const clients = [
    { id: 'U01', clock: { offset: 0 }, trace: { keys: [{ at: 100 }], samples: [{ at: 0, connection: 'synced' }, { at: 500, connection: 'degraded' }] } },
    { id: 'observer', clock: { offset: 0 }, trace: { keys: [], samples: [{ at: 0, connection: 'synced', connectedUsers: 2 }] } },
  ];
  const timeline = makeTimeline(clients, 0, 1200, 100);
  assert.equal(timeline[0].connectedBrowsers, 2);
  assert.equal(timeline[1].typing, 1);
  assert.equal(timeline[5].connectedWriters, 0);
  assert.equal(timeline[5].observerConnected, true);
  assert.equal(timeline[11].typing, 0);
});
