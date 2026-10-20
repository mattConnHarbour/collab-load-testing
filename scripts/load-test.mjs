import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createBrowserRoles, calibrateClock, bounded } from './load-runtime.mjs';
import { installProbe, locateTargets, applyCaret, annotatePage, findTypingPages } from './load-browser.mjs';
import { summarize, measureKeys, makeTimeline } from './load-metrics.mjs';
import { writeReport } from './load-report.mjs';
import { createTelemetry, emptyTrace, applyTelemetry } from './load-telemetry.mjs';
import { browserProfiler, startGeneratorProfiling } from './load-profiling.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runFile = promisify(execFile);
const palette = ['#1355ff', '#9333ea', '#00853d', '#cb0e47', '#b45309', '#0891b2', '#4f46e5', '#be185d', '#4d7c0f', '#a16207'];
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
const optionNames = ['document', 'users', 'text', 'layout', 'chars-per-second', 'repeat', 'duration', 'stagger-ms', 'start-delay-ms', 'sample-ms', 'settle-ms', 'timeout-ms', 'base-url', 'api-url', 'room', 'output', 'max-p95-ms', 'input-mode', 'observer-ws', 'server-url'];
const help = `Usage: npm run load-test -- --document /absolute/path/document.docx [flags]

--users N                 Typing users (default 10); one passive observer is added
--text TEXT               Text per user (default "the quick fox jumped over the lazy dog")
--layout LAYOUT           separate-pages | different-paragraphs | clustered | first-page | first-two-pages
--chars-per-second N      Keystrokes per second per writer (default 5)
--input-mode MODE         queued | paced (default queued); paced waits for each input acknowledgement
--repeat N                Repeat the phrase N times (default 1)
--duration SECONDS        Type repeated text for this scheduled duration; replaces --repeat
--stagger-ms N            Delay between writers starting (default 0)
--start-delay-ms N        Wait after clients connect before typing (default 0)
--sample-ms N             Connection/typing sampling interval (default 100)
--settle-ms N             Minimum wait before checking convergence (default 2000)
--timeout-ms N            Setup/action timeout and convergence allowance (default 60000)
--server-url URL          Combined app/API server (default http://localhost:8100)
--base-url URL            Override the frontend URL
--api-url URL             Override the API URL
--room ID                 Fresh room ID (default generated; existing documents refused)
--output DIRECTORY        Local report directory (default artifacts/load-test/TIMESTAMP)
--max-p95-ms N            Optional remote p95 failure threshold per user
--observer-ws URL         Connect to an independently running observer worker
--require-external-observer  Fail unless --observer-ws or OBSERVER_WS_URL is provided
--profile                 Capture writer U01, observer/worker CPU, transport, long tasks, and backend profiles
--headed                  Show local Chromium windows (default headless)
--help                    Print this help

Start the demo with make dev. Install runner dependencies with npm install and
npx playwright install chromium. Artifacts contain document content and remain local.
Latency measures DOM arrival, not physical screen paint. No AI requests are made.
`;

function configuration() {
  const { values } = parseArgs({ options: { ...Object.fromEntries(optionNames.map((name) => [name, { type: 'string' }])), profile: { type: 'boolean' }, headed: { type: 'boolean' }, 'require-external-observer': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { console.log(help); return null; }
  if (!values.document) throw new Error('--document is required. Use --help for all flags.');
  const number = (name, fallback, minimum, integer = false) => {
    const value = Number(values[name] ?? fallback);
    if (!Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} >= ${minimum}.`);
    return value;
  };
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const serverUrl = values['server-url'] ?? process.env.SERVER_URL ?? 'http://localhost:8100';
  const config = {
    document: path.resolve(values.document), users: number('users', 10, 1, true),
    text: values.text ?? 'the quick fox jumped over the lazy dog',
    layout: values.layout ?? 'separate-pages', charsPerSecond: number('chars-per-second', 5, 0.01),
    repeat: number('repeat', 1, 1, true), duration: values.duration === undefined ? null : number('duration', 0, 0.01),
    staggerMs: number('stagger-ms', 0, 0), sampleMs: number('sample-ms', 100, 10, true),
    startDelayMs: number('start-delay-ms', 0, 0),
    settleMs: number('settle-ms', 2000, 0), timeoutMs: number('timeout-ms', 60000, 100, true),
    baseUrl: values['base-url'] ?? serverUrl, apiUrl: values['api-url'] ?? serverUrl,
    room: values.room ?? `load-${timestamp.toLowerCase()}`, output: path.resolve(values.output ?? path.join(root, 'artifacts', 'load-test', timestamp)),
    headed: values.headed ?? false, maxP95Ms: values['max-p95-ms'] === undefined ? null : number('max-p95-ms', 0, 0),
    inputMode: values['input-mode'] ?? 'queued',
    observerWs: values['observer-ws'] || process.env.OBSERVER_WS_URL || null,
    requireExternalObserver: values['require-external-observer'] ?? false,
    profile: values.profile ?? false,
  };
  if (!['separate-pages', 'different-paragraphs', 'clustered', 'first-page', 'first-two-pages'].includes(config.layout)) throw new Error('Invalid --layout.');
  if (config.layout === 'first-two-pages' && config.users < 2) throw new Error('--layout first-two-pages requires at least two users.');
  if (!['queued', 'paced'].includes(config.inputMode)) throw new Error('Invalid --input-mode.');
  if (!config.text || /[\x00-\x1f\[\]]/.test(config.text) || [...config.text].some((character) => character.length !== 1)) throw new Error('--text must be nonempty single-line text without control characters, brackets, or surrogate-pair characters.');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(config.room)) throw new Error('--room must contain 1–100 letters, numbers, underscores, or hyphens.');
  if (values.duration !== undefined && values.repeat !== undefined) throw new Error('Choose --duration or --repeat, not both.');
  if (config.requireExternalObserver && !config.observerWs) throw new Error('An external observer endpoint is required. Set --observer-ws or OBSERVER_WS_URL.');
  if (config.observerWs && !['ws:', 'wss:'].includes(new URL(config.observerWs).protocol)) throw new Error('--observer-ws must use ws:// or wss://');
  if (!config.document.toLowerCase().endsWith('.docx')) throw new Error('--document must be a DOCX file.');
  return config;
}

async function request(config, route, options) {
  const response = await fetch(new URL(route, config.apiUrl), { ...options, signal: AbortSignal.timeout(config.timeoutMs) });
  if (!response.ok) throw new Error(`${options?.method ?? 'GET'} ${route}: HTTP ${response.status} ${await response.text()}`);
  return response;
}

async function main(config) {
  await fs.access(config.document);
  await fs.mkdir(config.output, { recursive: true });
  if ((await fs.readdir(config.output)).length) throw new Error(`Output directory is not empty: ${config.output}`);
  const { stdout } = await runFile('python3', [path.join(root, 'scripts/load-fixture.py'), config.document, path.join(config.output, 'fixture.docx'), '--users', String(config.users), '--layout', config.layout]);
  const fixture = JSON.parse(stdout);
  const expectedText = config.duration == null
    ? Array(config.repeat).fill(config.text).join(' ')
    : (config.text + ' ').repeat(Math.ceil(Math.ceil(config.duration * config.charsPerSecond) / (config.text.length + 1))).slice(0, Math.ceil(config.duration * config.charsPerSecond));
  const userIds = Array.from({ length: config.users }, (_, index) => `U${String(index + 1).padStart(2, '0')}`);
  const roomUrl = new URL(config.baseUrl);
  roomUrl.searchParams.set('room', config.room);
  let roles;
  let topology;
  const reportConfig = { ...config, observerWs: config.observerWs ? `${new URL(config.observerWs).origin}/[redacted]` : null };
  const safeError = (error) => String(error.stack ?? error).replaceAll(config.observerWs ?? '\0', reportConfig.observerWs ?? '\0');
  const clients = [];
  const failures = [];
  const images = [];
  let start;
  let end;
  let targets = [];
  let startedAt;
  let stage = 'setup';
  const profileDirectory = path.join(config.output, 'profiling');
  if (config.profile) await fs.mkdir(profileDirectory, { recursive: true });
  const profiling = { enabled: config.profile, browsers: [], generator: null, serverStarted: false, serverDirectory: null, errors: [] };
  let profilingStopped = false;
  let processSampler;
  const stopProfiling = async () => {
    if (profilingStopped) return; profilingStopped = true;
    const tasks = [...profiling.browsers.map(browser => browser.stop()), profiling.generator?.stop()];
    if (profiling.serverStarted) tasks.push(fetch(new URL('/api/profiling/stop', config.apiUrl), { method: 'POST', signal: AbortSignal.timeout(15000) }).then(response => { if (!response.ok) throw new Error(`Backend profiler stop: HTTP ${response.status}`); }));
    try { for (const result of await bounded(Promise.allSettled(tasks), 30000, 'Profiler shutdown')) if (result.status === 'rejected') profiling.errors.push(result.reason.message); }
    catch (error) { profiling.errors.push(error.message); }
    if (config.profile) await fs.writeFile(path.join(profileDirectory, 'metadata.json'), JSON.stringify({ enabled: true, targets: ['U01', 'observer'], serverDirectory: profiling.serverDirectory, errors: profiling.errors }, null, 2));
    processSampler?.kill('SIGTERM');
  };
  const telemetry = createTelemetry(config.output, () => {
    const users = summarizeUsers(false).map(({ keystrokes, scheduled, ...user }) => ({ ...user, capturedKeys: keystrokes.length }));
    return { stage, updatedAt: new Date().toISOString(), config: reportConfig, topology, fixture, expectedText, users, failures };
  });
  telemetry.append({ type: 'metadata', data: { config: reportConfig, fixture, expectedText } });
  console.log(`Room: ${roomUrl}\nReport: ${config.output}\nStarting ${config.users} writers + one observer; ${config.layout}; ${expectedText.length} characters each.`);

  function summarizeUsers(validate) {
    const observer = clients.find((client) => client.id === 'observer');
    if (!observer?.clock) return [];
    return targets.flatMap((target, index) => {
      const client = clients.find((candidate) => candidate.id === target.id);
      if (!client?.clock) return [];
      const localTrace = client.trace ?? client.live;
      const remoteTrace = observer.trace ?? observer.live;
      const keystrokes = measureKeys(localTrace.keys, localTrace.renders, remoteTrace.renders.filter((render) => render.user === target.id), client.clock, observer.clock, client.clockEnd, observer.clockEnd);
      for (const key of keystrokes) key.inputDeliveryMs = client.scheduled?.[key.index] ? key.controllerAt - client.scheduled[key.index].dispatchedAt : null;
      const local = summarize(keystrokes.map((key) => key.localMs));
      const remote = summarize(keystrokes.map((key) => key.remoteMs));
      const matches = localTrace.final[target.id] === expectedText && remoteTrace.final[target.id] === expectedText;
      const missingLocal = keystrokes.filter((key) => key.localMs == null).length;
      const missingRemote = keystrokes.filter((key) => key.remoteMs == null).length;
      if (validate) {
      if (keystrokes.length !== expectedText.length) failures.push(`${target.id}: ${keystrokes.length}/${expectedText.length} expected key events captured.`);
      if (missingLocal || missingRemote) failures.push(`${target.id}: ${missingLocal} local and ${missingRemote} remote keystrokes unobserved.`);
      if (keystrokes.some((key) => key.remoteUpperMs !== null && key.remoteUpperMs < 0)) failures.push(`${target.id}: remote clock estimates are inconsistent with causal text delivery.`);
      if (!matches) failures.push(`${target.id}: final expected text mismatch.`);
      if (config.maxP95Ms != null && remote.p95 > config.maxP95Ms) failures.push(`${target.id}: remote p95 ${remote.p95.toFixed(1)} ms exceeds ${config.maxP95Ms} ms.`);
      }
      const typingDurationMs = keystrokes.length > 1 ? keystrokes.at(-1).at - keystrokes[0].at : 0;
      return [{ ...target, color: index < palette.length ? palette[index] : `hsl(${index * 137.5 % 360} 65% 40%)`, keystrokes, local, remote, missingLocal, missingRemote, matches, finalLocal: localTrace.final[target.id], finalRemote: remoteTrace.final[target.id], achievedCharsPerSecond: typingDurationMs > 0 ? (keystrokes.length - 1) * 1000 / typingDurationMs : null, inputDelivery: summarize(keystrokes.map((key) => key.inputDeliveryMs)), dispatch: summarize((client.scheduled ?? []).map((entry) => entry.latenessMs)), scheduled: client.scheduled ?? [] }];
    });
  }

  async function openClient(id, height) {
    const browser = id === 'observer' ? roles.observer : roles.writers;
    const context = await browser.newContext({ viewport: { width: 1440, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(config.timeoutMs);
    const client = { id, context, page, errors: [], live: emptyTrace(expectedText) };
    clients.push(client);
    if (config.profile && (id === 'observer' || id === 'U01')) profiling.browsers.push(await browserProfiler(context, page, id, profileDirectory));
    await page.exposeBinding('__recordLoadTest', (_source, event) => {
      applyTelemetry(client.live, event);
      telemetry.append({ user: id, ...event });
    });
    page.on('pageerror', (error) => client.errors.push(error.message));
    const url = new URL(roomUrl);
    url.searchParams.set('loadTest', '1');
    url.searchParams.set('testUser', id);
    if (config.profile) url.searchParams.set('profile', '1');
    await page.goto(url.toString());
    await page.addStyleTag({ content: '.chat-panel { display:none !important; }' });
    await page.waitForFunction(() => window.__collabLoadTest?.ready && window.__collabLoadTest.connection === 'synced', null, { timeout: config.timeoutMs });
    return client;
  }

  try {
  const serverHealth = await (await request(config, '/api/health')).json();
  const existing = await (await request(config, `/api/rooms/${config.room}`)).json();
  if (existing.document) throw new Error(`Room ${config.room} already has a document. Choose a fresh --room.`);
  const upload = new FormData();
  upload.append('file', new Blob([await fs.readFile(fixture.fixture)]), path.basename(config.document));
  await request(config, `/api/rooms/${config.room}/document`, { method: 'PUT', body: upload });
    roles = await createBrowserRoles(config);
    topology = { ...roles.topology, server: { apiOrigin: new URL(config.apiUrl).origin, frontendOrigin: new URL(config.baseUrl).origin, hostname: serverHealth.hostname ?? 'unknown', pid: serverHealth.pid ?? null } };
    if (config.profile) processSampler = spawn(process.execPath, [path.join(root,'scripts/profile-processes.mjs'),'--directory',profileDirectory,'--server-pid',String(serverHealth.pid),'--generator-pid',String(process.pid),'--observer-pid',String(roles.topology.observer.workerPid??0)], {stdio:'ignore'});
    telemetry.append({ type: 'topology', data: topology });
    const observer = await openClient('observer', 16000);
    const pageCount = await observer.page.locator('.superdoc-page').count();
    await observer.page.setViewportSize({ width: 1440, height: Math.max(16000, (pageCount + 2) * 1100) });
    await observer.page.waitForFunction((ids) => ids.every((id) => [...document.querySelectorAll('.superdoc-fragment')].some((element) => element.textContent.includes(`[[${id}]]`))), userIds, { timeout: config.timeoutMs });
    targets = await observer.page.evaluate(locateTargets, userIds);
    telemetry.append({ type: 'targets', data: targets });
    if (config.layout === 'separate-pages' && new Set(targets.map((target) => target.page)).size !== config.users) throw new Error('Separate-page targets did not render on distinct pages.');
    if (config.layout === 'first-page' && targets.some((target) => target.page !== 1)) throw new Error('Some typing targets did not fit on page 1. Reduce --users.');
    if (config.layout === 'first-two-pages' && targets.some((target, index) => target.page !== (index < Math.ceil(config.users / 2) ? 1 : 2))) throw new Error('Typing targets did not fit the expected split between pages 1 and 2. Reduce --users.');
    console.log(`Typing pages: ${targets.map((target) => `${target.id}→${target.page}`).join(', ')}`);
    await observer.page.evaluate(installProbe, { targets, writerId: null, text: expectedText, sampleMs: config.sampleMs });

    for (const target of targets) {
      const client = await openClient(target.id, 1000);
      await client.page.locator(`.superdoc-page[data-page-number="${target.page}"]`).scrollIntoViewIfNeeded();
      const fragment = client.page.locator('.superdoc-fragment').filter({ hasText: target.start });
      await fragment.waitFor({ state: 'visible' });
      await fragment.click();
      const [localTarget] = await client.page.evaluate(locateTargets, [target.id]);
      const receipt = await client.page.evaluate(applyCaret, localTarget);
      if (!receipt.ok) throw new Error(`${target.id}: cannot place cursor: ${receipt.reason}`);
      await client.page.waitForFunction((target) => {
        const point = window.__collabLoadTest.ui.selection.current()?.selectionTarget?.start;
        return document.activeElement.matches('[data-v2-ime-host]') && point?.blockId === target.selectionBlockId && point.offset === target.offset;
      }, localTarget, { timeout: config.timeoutMs });
      await client.page.evaluate(installProbe, { targets: [localTarget], writerId: target.id, text: expectedText, sampleMs: config.sampleMs });
      client.clock = await calibrateClock(client.page, config.timeoutMs);
      telemetry.append({ user: client.id, type: 'clock', data: client.clock });
      if (config.inputMode === 'queued') client.input = await client.context.newCDPSession(client.page);
      console.log(`${target.id} connected and ready on page ${target.page}`);
    }
    await observer.page.waitForFunction((count) => window.__collabLoadTest.connectedUsers >= count, config.users + 1, { timeout: config.timeoutMs });
    if (config.startDelayMs) {
      console.log(`All clients synchronized. Waiting ${config.startDelayMs} ms before typing; open ${roomUrl} to watch.`);
      await wait(config.startDelayMs);
    }
    observer.clock = await calibrateClock(observer.page, config.timeoutMs);
    telemetry.append({ user: observer.id, type: 'clock', data: observer.clock });
    if (config.profile) {
      const serverProfile = await (await request(config, '/api/profiling/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: config.room }) })).json();
      profiling.serverStarted = true; profiling.serverDirectory = serverProfile.directory;
      await Promise.all(profiling.browsers.map(browser => browser.start()));
      profiling.generator = await startGeneratorProfiling(profileDirectory);
      console.log('Profiling writer U01, observer, their workers, generator and backend.');
    }
    console.log('All clients synchronized. Typing concurrently…');
    start = performance.now();
    startedAt = new Date().toISOString();
    stage = 'typing';
    telemetry.append({ type: 'started', data: { start, startedAt } });
    const typing = Promise.all(clients.filter((client) => client.id !== 'observer').map(async (client, userIndex) => {
      client.scheduled = [];
      const pending = [];
      let inputError;
      for (let index = 0; index < expectedText.length; index++) {
        const due = start + userIndex * config.staggerMs + index * 1000 / config.charsPerSecond;
        await wait(due - performance.now());
        const dispatchedAt = performance.now();
        const record = { index, due, dispatchedAt, completedAt: null, latenessMs: dispatchedAt - due };
        client.scheduled.push(record);
        const character = expectedText[index];
        if (config.inputMode === 'queued') {
          const code = /[a-z]/i.test(character) ? `Key${character.toUpperCase()}` : character === ' ' ? 'Space' : '';
          const keyCode = character.toUpperCase().charCodeAt(0);
          const down = client.input.send('Input.dispatchKeyEvent', { type: 'keyDown', key: character, code, windowsVirtualKeyCode: keyCode, text: character, unmodifiedText: character });
          const up = client.input.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character, code, windowsVirtualKeyCode: keyCode });
          pending.push(Promise.all([down, up]).then(() => { record.completedAt = performance.now(); }).catch((error) => { inputError ??= error; }));
        } else {
          await client.page.keyboard.type(character);
          record.completedAt = performance.now();
        }
      }
      await Promise.all(pending);
      if (inputError) throw inputError;
    }));
    await bounded(typing, expectedText.length * 1000 / config.charsPerSecond + (config.users - 1) * config.staggerMs + config.timeoutMs, 'Typing workload');
    stage = 'converging';
    console.log('Input acknowledged. Waiting for observer convergence…');
    await wait(config.settleMs);
    try {
      await observer.page.waitForFunction(({ targets, expectedText }) => targets.every((target) => window.__typingProbe.read(target) === expectedText), { targets, expectedText }, { timeout: config.timeoutMs });
    } catch {
      failures.push(`Observer did not converge to all expected text within the ${config.timeoutMs} ms convergence allowance.`);
    }
    end = performance.now();
    stage = 'collecting';
    await stopProfiling();
    for (const client of clients) {
      client.trace = await bounded(client.page.evaluate(() => window.__typingProbe.stop()), config.timeoutMs, `${client.id} trace collection`);
      client.clockEnd = await calibrateClock(client.page, config.timeoutMs);
      telemetry.append({ user: client.id, type: 'clockEnd', data: client.clockEnd });
      client.errors.push(...client.trace.errors);
      for (const error of client.errors) failures.push(`${client.id}: ${error}`);
    }
    const users = summarizeUsers(true);
    stage = 'capturing';
    console.log('Capturing annotated document pages…');
    const typingPages = await observer.page.evaluate(findTypingPages, users);
    for (const pageNumber of typingPages) {
      const highlights = await observer.page.evaluate(annotatePage, { pageNumber, users });
      const file = `page-${String(pageNumber).padStart(2, '0')}.png`;
      await observer.page.locator('.load-test-capture').screenshot({ path: path.join(config.output, file) });
      await observer.page.evaluate(() => document.querySelectorAll('.load-test-capture').forEach((element) => element.remove()));
      images.push({ page: pageNumber, file, highlights });
      if (!highlights.length) failures.push(`Page ${pageNumber}: no typing regions could be highlighted.`);
    }
    for (const user of users) {
      if (!images.some((entry) => entry.highlights.some((highlight) => highlight.user === user.id))) failures.push(`${user.id}: no rendered typing region could be highlighted.`);
    }
    await fs.writeFile(path.join(config.output, 'final.docx'), Buffer.from(await (await request(config, `/api/rooms/${config.room}/document`)).arrayBuffer()));
    const report = {
      status: failures.length ? 'failed' : 'passed', startedAt, config: reportConfig, topology, fixture, roomUrl: roomUrl.toString(), expectedText,
      durationMs: end - start, clockUncertaintyMs: Math.max(0, ...users.flatMap((user) => user.keystrokes.map((key) => key.remoteUncertaintyMs))),
      users, timeline: makeTimeline(clients, start, end, config.sampleMs), images, failures, partial: false,
      profiling: { enabled: config.profile, directory: 'profiling', serverDirectory: profiling.serverDirectory, errors: profiling.errors },
      clients: clients.map(({ id, clock, clockEnd, trace, errors }) => ({ id, clock, clockEnd, trace, errors })),
    };
    await writeReport(config.output, report);
    console.log(`${report.status.toUpperCase()}: ${users.length} writers, ${users.reduce((total, user) => total + user.keystrokes.length, 0)} keystrokes.\n${path.join(config.output, 'report.html')}`);
    for (const user of users) console.log(`${user.id}: local p95 ${user.local.p95?.toFixed(1) ?? 'missing'} ms; remote p95 ${user.remote.p95?.toFixed(1) ?? 'missing'} ms`);
    if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
  } catch (error) {
    failures.push(safeError(error));
    stage = 'failed';
    await stopProfiling();
    await Promise.all(clients.map(async (client) => {
      try {
        const trace = await bounded(client.page.evaluate(() => window.__typingProbe?.stop()), 2000, `${client.id} failure trace`);
        if (trace) client.trace = trace;
        await client.page.screenshot({ path: path.join(config.output, `${client.id}-failure.png`), timeout: 5000 });
      } catch {}
      client.trace ??= structuredClone(client.live);
    }));
    const users = summarizeUsers(false);
    const retainedClients = clients.map(({ id, clock, clockEnd, trace, errors }) => ({ id, clock, clockEnd, trace, errors }));
    await fs.writeFile(path.join(config.output, 'failure.json'), JSON.stringify({ config: reportConfig, topology, fixture, failures, clients: retainedClients }, null, 2));
    await writeReport(config.output, { status: 'failed', partial: true, startedAt: startedAt ?? new Date().toISOString(), config: reportConfig, topology, fixture, roomUrl: roomUrl.toString(), expectedText, durationMs: start ? performance.now() - start : 0,
      clockUncertaintyMs: Math.max(0, ...users.flatMap(user => user.keystrokes.map(key => key.remoteUncertaintyMs))), users,
      timeline: start ? makeTimeline(clients.filter(client => client.clock), start, performance.now(), config.sampleMs) : [], images, failures, clients: retainedClients,
      profiling: { enabled: config.profile, directory: 'profiling', serverDirectory: profiling.serverDirectory, errors: profiling.errors } });
    throw error;
  } finally {
    await stopProfiling();
    stage = 'finished';
    await telemetry.close();
    await roles?.close();
  }
}

try {
  const config = configuration();
  if (config) await main(config);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
