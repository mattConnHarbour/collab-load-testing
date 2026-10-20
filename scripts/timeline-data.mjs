import fs from 'node:fs/promises';
import path from 'node:path';

async function readEvents(file) {
  try {
    return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; } // A timeout may leave an incomplete last record.
    });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function loadTimelineTrials(directories, { output, analysisFile } = {}) {
  const trials = [];
  let analysis = [];
  try {
    analysis = JSON.parse(await fs.readFile(analysisFile ?? path.join(output, 'profiling-analysis.json'), 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT' || analysisFile) throw error; }
  for (const directory of directories) {
    const report = JSON.parse(await fs.readFile(path.join(directory, 'results.json'), 'utf8'));
    const zero = Math.min(...report.users.flatMap(user => user.scheduled.map(key => key.due)));
    if (!Number.isFinite(zero)) throw new Error(`No scheduled keys in ${directory}`);
    const users = report.users.map(user => {
      const captured = new Map(user.keystrokes.map(key => [key.index, key]));
      return { id: user.id, color: user.color, keys: user.scheduled.map(scheduled => {
        const key = captured.get(scheduled.index);
        const keydown = Number.isFinite(key?.controllerAt) ? key.controllerAt - zero : null;
        return { index: scheduled.index, char: report.expectedText[scheduled.index],
          due: scheduled.due - zero,
          dispatch: Number.isFinite(scheduled.dispatchedAt) ? scheduled.dispatchedAt - zero : null,
          keydown,
          local: keydown !== null && Number.isFinite(key.localMs) ? keydown + key.localMs : null,
          remote: keydown !== null && Number.isFinite(key.remoteMs) ? keydown + key.remoteMs : null,
          uncertainty: key?.remoteUncertaintyMs ?? null };
      }) };
    });
    const epochZero = Date.parse(report.startedAt);
    const profileDir = path.join(directory, 'profiling');
    const [backend, writer, observer, generator] = await Promise.all([
      report.profiling?.serverDirectory ? readEvents(path.join(report.profiling.serverDirectory, 'server-events.jsonl')) : [],
      readEvents(path.join(profileDir, 'U01-browser-events.jsonl')),
      readEvents(path.join(profileDir, 'observer-browser-events.jsonl')),
      readEvents(path.join(profileDir, 'generator-events.jsonl')),
    ]);
    const operations = [];
    for (const event of backend) {
      if (!['yjs-transaction', 'yjs-update-broadcast'].includes(event.type) || !Number.isFinite(event.durationMs)) continue;
      const at = event.atEpochMs - epochZero;
      const start = event.type === 'yjs-update-broadcast' ? at : at - event.durationMs;
      operations.push({ lane: event.type, start, end: start + event.durationMs });
    }
    for (const [role, events] of [['U01', writer], ['observer', observer]]) {
      for (const event of events.filter(event => event.type === 'long-task')) {
        operations.push({ lane: `${role} long tasks`, start: event.atEpochMs - epochZero, end: event.atEpochMs - epochZero + event.durationMs });
      }
    }
    const lag = [...backend.map(event => ({ ...event, role: 'server' })), ...generator.map(event => ({ ...event, role: 'generator' }))]
      .filter(event => event.type === 'resource' && Number.isFinite(event.eventLoopMaxMs))
      .map(event => ({ role: event.role, at: event.atEpochMs - epochZero, max: event.eventLoopMaxMs, interval: event.elapsedMs }));
    const traffic = new Map(), sentAwareness = new Map();
    for (const event of backend) {
      const payload = `${event.connection}:${event.hash}`;
      if (event.type === 'ws-send' && event.kind === 'awareness') sentAwareness.set(payload, event.atEpochMs);
      if (event.type !== 'ws-receive' || !['awareness', 'update'].includes(event.kind)) continue;
      const bin = Math.floor((event.atEpochMs - epochZero) / 1000);
      const bucket = traffic.get(bin) ?? { at: bin * 1000, count: 0, updates: 0, returned: 0 };
      if (event.kind === 'update') bucket.updates++;
      else {
        bucket.count++;
        const sentAt = sentAwareness.get(payload);
        if (sentAt !== undefined && event.atEpochMs >= sentAt) bucket.returned++;
      }
      traffic.set(bin, bucket);
    }
    const saved = analysis.find(run => path.resolve(run.reportPath) === path.resolve(directory));
    const evidence = saved ? {
      traffic: saved.backend.traffic,
      transport: Object.fromEntries(['writerToServer', 'backendRelay', 'serverToObserver'].map(key => [key, saved.transport[key]])),
      profiles: [...saved.cpuProfiles, ...(saved.backend.cpuProfiles ?? [])].map(profile => ({
        target: profile.target, maxSampleGapMs: profile.maxSampleGapMs,
        functions: profile.functions.slice(0, 6),
      })),
      host: saved.hostSnapshots.map(snapshot => ({
        at: Date.parse(snapshot.at) - epochZero, total: snapshot.total, free: snapshot.free, load: snapshot.load[0],
        swapMiB: Number(snapshot.swap.match(/used\s*=\s*([\d.]+)M/)?.[1]) || null,
        pageBytes: Number(snapshot.vm.match(/page size of (\d+) bytes/)?.[1]) || null,
        swapInPages: Number(snapshot.vm.match(/Swapins:\s+(\d+)/)?.[1]) || null,
        swapOutPages: Number(snapshot.vm.match(/Swapouts:\s+(\d+)/)?.[1]) || null,
      })),
      browser: { writer: saved.writer.delta, observer: saved.observer.delta },
    } : null;
    trials.push({ expectedText: report.expectedText, writers: report.config.users, partial: !!report.partial, users, operations, lag,
      traffic: [...traffic.values()], evidence, hasBackend: backend.length > 0,
      browserCoverage: [writer.length ? 'U01' : null, observer.length ? 'observer' : null].filter(Boolean),
      duration: report.durationMs,
      reportUrl: path.relative(path.resolve(output), path.resolve(directory, 'report.html')).split(path.sep).map(encodeURIComponent).join('/') });
  }
  return trials.sort((a, b) => a.writers - b.writers);
}
