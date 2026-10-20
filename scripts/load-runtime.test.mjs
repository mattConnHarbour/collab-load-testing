import test from 'node:test';
import assert from 'node:assert/strict';
import { measureKeys, toControllerTime } from './load-metrics.mjs';
import { bounded } from './load-runtime.mjs';

test('cross-machine browser epochs are aligned and their uncertainties are combined', () => {
  const local = { offset: 1000, uncertaintyMs: 2 };
  const observer = { offset: -500, uncertaintyMs: 8 };
  const [key] = measureKeys([{ at: 100, expected: 'x' }], [{ at: 120, text: 'x' }], [{ at: 1630, text: 'x' }], local, observer);
  assert.equal(key.localMs, 20);
  assert.equal(key.remoteMs, 30);
  assert.equal(key.remoteUncertaintyMs, 10);
  assert.equal(key.remoteLowerMs, 20);
  assert.equal(key.remoteUpperMs, 40);
});

test('before and after clock samples correct drift while local latency stays in one clock', () => {
  const local = { browserAt: 0, offset: 100, uncertaintyMs: 2 };
  const localEnd = { browserAt: 1000, offset: 110, uncertaintyMs: 4 };
  const observer = { browserAt: 0, offset: 90, uncertaintyMs: 6 };
  const observerEnd = { browserAt: 1000, offset: 100, uncertaintyMs: 8 };
  const [key] = measureKeys([{ at: 500, expected: 'x' }], [{ at: 520, text: 'x' }], [{ at: 550, text: 'x' }], local, observer, localEnd, observerEnd);
  assert.equal(key.localMs, 20);
  assert.equal(key.remoteMs, 40.5);
  assert.equal(key.remoteUncertaintyMs, 12);
  assert.equal(toControllerTime(-100, local, localEnd), 0);
  assert.equal(toControllerTime(1100, local, localEnd), 1210);
});

test('ambiguous remote timing retains its uncertainty rather than hiding a negative estimate', () => {
  const [key] = measureKeys([{ at: 100, expected: 'x' }], [{ at: 120, text: 'x' }], [{ at: 95, text: 'x' }], { offset: 0, uncertaintyMs: 5 }, { offset: 0, uncertaintyMs: 5 });
  assert.equal(key.remoteMs, -5);
  assert.equal(key.remoteLowerMs, -15);
  assert.equal(key.remoteUpperMs, 5);
});

test('hung role operations fail within their configured deadline', async () => {
  await assert.rejects(bounded(new Promise(() => {}), 10, 'Observer connection'), /Observer connection exceeded 10 ms/);
});
