export function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = (fraction) => sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null };
}

export function toControllerTime(at, clock, end) {
  if (typeof clock === 'number') return at + clock;
  if (!end || !Number.isFinite(clock.browserAt) || end.browserAt <= clock.browserAt) return at + clock.offset;
  const fraction = Math.max(0, Math.min(1, (at - clock.browserAt) / (end.browserAt - clock.browserAt)));
  return at + clock.offset + fraction * (end.offset - clock.offset);
}

function uncertainty(clock, end) {
  return typeof clock === 'number' ? 0 : Math.max(clock.uncertaintyMs ?? 0, end?.uncertaintyMs ?? 0);
}

export function measureKeys(keys, localRenders, remoteRenders, localClock, remoteClock, localEnd, remoteEnd) {
  return keys.map((key) => {
    const local = localRenders.find((render) => render.at >= key.at && render.text?.startsWith(key.expected));
    const remote = remoteRenders.find((render) => render.text?.startsWith(key.expected));
    const controllerAt = toControllerTime(key.at, localClock, localEnd);
    const remoteMs = remote ? toControllerTime(remote.at, remoteClock, remoteEnd) - controllerAt : null;
    const remoteUncertaintyMs = uncertainty(localClock, localEnd) + uncertainty(remoteClock, remoteEnd);
    return {
      ...key,
      controllerAt,
      localMs: local ? local.at - key.at : null,
      remoteMs, remoteUncertaintyMs,
      remoteLowerMs: remoteMs === null ? null : remoteMs - remoteUncertaintyMs,
      remoteUpperMs: remoteMs === null ? null : remoteMs + remoteUncertaintyMs,
      localText: local?.text ?? null,
      remoteText: remote?.text ?? null,
      localBatched: local ? local.text.length > key.expected.length : false,
      remoteBatched: remote ? remote.text.length > key.expected.length : false,
    };
  });
}

export function makeTimeline(clients, start, end, sampleMs) {
  const frames = [];
  for (let at = start; at <= end; at += sampleMs) {
    let connectedWriters = 0;
    let typing = 0;
    let observerConnected = false;
    let reportedPresence = null;
    for (const client of clients) {
      const sample = client.trace.samples.findLast((entry) => toControllerTime(entry.at, client.clock, client.clockEnd) <= at);
      const connected = sample?.connection === 'synced';
      if (client.id === 'observer') {
        observerConnected = connected;
        reportedPresence = sample?.connectedUsers ?? null;
      } else {
        if (connected) connectedWriters++;
        if (client.trace.keys.some((key) => toControllerTime(key.at, client.clock, client.clockEnd) <= at && toControllerTime(key.at, client.clock, client.clockEnd) > at - 1000)) typing++;
      }
    }
    frames.push({ elapsedMs: at - start, connectedWriters, observerConnected, connectedBrowsers: connectedWriters + Number(observerConnected), typing, reportedPresence });
  }
  return frames;
}
