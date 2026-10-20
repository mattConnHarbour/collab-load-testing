import fs from 'node:fs/promises';
import path from 'node:path';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const ms = (value) => value == null ? '—' : `${value.toFixed(1)} ms`;
const csv = (rows) => rows.map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n') + '\n';

function timelineChart(timeline) {
  if (!timeline.length) return '';
  const width = 900;
  const height = 180;
  const maximum = Math.max(1, ...timeline.map((frame) => frame.connectedBrowsers));
  const duration = Math.max(1, timeline.at(-1).elapsedMs);
  const points = (field) => timeline.map((frame) => `${40 + frame.elapsedMs / duration * (width - 60)},${height - 30 - frame[field] / maximum * (height - 60)}`).join(' ');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Connected browsers and typing writers over time"><path d="M40 15V150H880" fill="none" stroke="#aaa"/><polyline points="${points('connectedBrowsers')}" fill="none" stroke="#1355ff" stroke-width="2"/><polyline points="${points('typing')}" fill="none" stroke="#00853d" stroke-width="2"/><text x="5" y="25">${maximum}</text><text x="20" y="150">0</text><text x="40" y="172">0 s</text><text x="810" y="172">${(duration / 1000).toFixed(1)} s</text></svg>`;
}

export async function writeReport(directory, report) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(report, null, 2));
  const keyRows = report.users.flatMap((user) => user.keystrokes.map((key) => [user.id, key.index + 1, key.key, key.expected, key.currentAtKeydown, key.localText, key.remoteText, key.localMs, key.remoteMs, key.remoteUncertaintyMs, key.remoteLowerMs, key.remoteUpperMs, key.inputDeliveryMs, key.localBatched, key.remoteBatched]));
  await fs.writeFile(path.join(directory, 'keystrokes.csv'), csv([['user', 'keystroke', 'key', 'expected', 'current_at_keydown', 'local_observed_text', 'remote_observed_text', 'local_ms', 'remote_ms', 'remote_uncertainty_ms', 'remote_lower_ms', 'remote_upper_ms', 'input_delivery_ms', 'local_batched', 'remote_batched'], ...keyRows]));
  await fs.writeFile(path.join(directory, 'timeline.csv'), csv([['elapsed_ms', 'connected_writers', 'observer_connected', 'connected_browsers', 'typing_writers', 'observer_presence'], ...report.timeline.map((frame) => [frame.elapsedMs, frame.connectedWriters, frame.observerConnected, frame.connectedBrowsers, frame.typing, frame.reportedPresence])]));
  const userRows = report.users.map((user) => `<tr><td><span class="swatch" style="background:${user.color}"></span>${escape(user.id)}</td><td>${user.page}</td><td>${user.keystrokes.length}/${report.expectedText.length}</td><td>${user.achievedCharsPerSecond?.toFixed(2) ?? '—'}</td><td>${ms(user.inputDelivery?.p95)}</td><td>${ms(user.dispatch?.p95)}</td><td>${ms(user.local.p50)}</td><td>${ms(user.local.p95)}</td><td>${ms(user.remote.p50)}</td><td>${ms(user.remote.p95)}</td><td>${ms(user.remote.max)}</td><td>${user.missingLocal}/${user.missingRemote}</td><td>${user.matches ? 'Yes' : 'No'}</td></tr>`).join('');
  const images = report.images.map((entry) => `<figure><a href="${escape(entry.file)}"><img src="${escape(entry.file)}" alt="Document page ${entry.page} with color coded typing regions" loading="lazy"/></a><figcaption>Document page ${entry.page}</figcaption></figure>`).join('');
  const details = report.users.map((user) => `<details><summary><span class="swatch" style="background:${user.color}"></span>${user.id}: per-keystroke expected and rendered text</summary><div class="scroll"><table><thead><tr><th>#</th><th>Key</th><th>Expected after key</th><th>Current at keydown</th><th>Local latency</th><th>Remote latency</th></tr></thead><tbody>${user.keystrokes.map((key) => `<tr><td>${key.index + 1}</td><td><code>${escape(JSON.stringify(key.key))}</code></td><td><code>${escape(key.expected)}</code></td><td><code>${escape(key.currentAtKeydown)}</code></td><td>${ms(key.localMs)}</td><td>${ms(key.remoteMs)}</td></tr>`).join('')}</tbody></table></div></details>`).join('');
  const files = new Set(await fs.readdir(directory));
  const artifacts = [['results.json', 'Full JSON and raw traces'], ['keystrokes.csv', 'Keystrokes CSV'], ['timeline.csv', 'Timeline CSV'], ['events.jsonl', 'Streamed events'], ['checkpoint.json', 'Last checkpoint'], ['profiling/metadata.json', 'Profiling metadata'], ['final.docx', 'Final document'], ['fixture.docx', 'Test fixture'], ['failure.json', 'Failure diagnostics']]
    .filter(([file]) => files.has(file)).map(([file, label]) => `<a href="${file}">${label}</a>`).join(' · ');
  const rates = report.users.map((user) => user.achievedCharsPerSecond).filter(Number.isFinite);
  const rateWarning = rates.length && Math.min(...rates) < report.config.charsPerSecond * 0.8
    ? `Requested rate was not sustained: writers achieved ${Math.min(...rates).toFixed(2)}–${Math.max(...rates).toFixed(2)} characters/second. This run does not establish capacity at the requested rate.` : '';
  const topology = report.topology;
  const topologyHtml = topology ? `<table><thead><tr><th>Role</th><th>Host/address</th><th>Process</th></tr></thead><tbody><tr><td>Server</td><td>${escape(topology.server.hostname)} · ${escape(topology.server.apiOrigin)}</td><td>${escape(topology.server.pid)}</td></tr><tr><td>Load generator</td><td>${escape(topology.loadGenerator.hostname)}</td><td>${escape(topology.loadGenerator.pid)}</td></tr><tr><td>Observer (${escape(topology.observer.mode)})</td><td>${escape(topology.observer.hostname)} · ${escape(topology.observer.endpointOrigin)}</td><td>${escape(topology.observer.workerPid ?? 'external worker')} · browser ${escape(topology.observer.browserPid ?? 'external')}</td></tr></tbody></table>` : '<p>Role metadata unavailable for this older report.</p>';
  const values = {
    STATUS_CLASS: report.status,
    PARTIAL_NOTE: report.partial ? 'Partial results: the run stopped early. Observed samples are retained; missing arrivals have no latency. Clock mapping uses the available calibration samples. No complete convergence or requested-load verdict is implied.' : '',
    STATUS: escape(report.status.toUpperCase()), STARTED_AT: escape(report.startedAt), WRITERS: report.config.users,
    SCENARIO: escape(report.config.layout), REQUESTED_RATE: report.config.charsPerSecond, KEY_COUNT: report.expectedText.length,
    SOURCE: escape(report.fixture.source), TARGETS: report.fixture.targetParagraphs ?? report.fixture.appendedParagraphs,
    PLACEMENT: escape(report.fixture.targetPlacement ?? 'appended'),
    ROOM_URL: escape(report.roomUrl), ROOM_ID: escape(report.config.room), CLOCK: report.clockUncertaintyMs.toFixed(2),
    ARTIFACTS: artifacts, RATE_WARNING: rateWarning, TOPOLOGY: topologyHtml,
    PEAK_CONNECTED: Math.max(0, ...report.timeline.map((frame) => frame.connectedBrowsers)),
    PEAK_TYPING: Math.max(0, ...report.timeline.map((frame) => frame.typing)),
    DURATION: (report.durationMs / 1000).toFixed(1),
    TIMELINE: timelineChart(report.timeline), USER_ROWS: userRows, PAGE_IMAGES: images, DETAILS: details,
    FAILURES: report.failures.length ? report.failures.map(escape).join('<br>') : 'All expected keystrokes observed locally and remotely. Final target text matched in every writer and the observer.',
  };
  const template = await fs.readFile(new URL('./load-report.html', import.meta.url), 'utf8');
  const html = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, name) => {
    if (!(name in values)) throw new Error(`Unknown report placeholder: ${name}`);
    return String(values[name]);
  });
  await fs.writeFile(path.join(directory, 'report.html'), html);
}
