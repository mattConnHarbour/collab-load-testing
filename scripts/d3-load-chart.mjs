import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help || !values.output || !positionals.length) {
  console.log('Usage: node scripts/d3-load-chart.mjs TRIAL_DIRECTORY [...] --output DIRECTORY');
  process.exit(values.help ? 0 : 1);
}
const mean = (numbers) => {
  const observed = numbers.filter(Number.isFinite);
  return observed.length ? observed.reduce((total, value) => total + value, 0) / observed.length : null;
};
const trials = [];
for (const directory of positionals) {
  const report = JSON.parse(await fs.readFile(path.join(directory, 'results.json'), 'utf8'));
  trials.push({
    writers: report.config.users, status: report.status, partial: report.partial ?? false,
    failures: report.failures, expectedText: report.expectedText, requestedRate: report.config.charsPerSecond,
    clockUncertaintyMs: report.clockUncertaintyMs,
    reportUrl: path.relative(path.resolve(values.output), path.resolve(directory, 'report.html')).split(path.sep).map(encodeURIComponent).join('/'),
    users: report.users.map((user) => ({
      id: user.id, color: user.color, page: user.page, matches: user.matches,
      localMs: mean(user.keystrokes.map((key) => key.localMs)),
      remoteMs: mean(user.keystrokes.map((key) => key.remoteMs)),
      deliveryMs: mean(user.keystrokes.map((key) => key.inputDeliveryMs)),
      localCount: user.local.count, remoteCount: user.remote.count,
      capturedKeys: user.keystrokes.length, expectedKeys: report.expectedText.length,
      achievedRate: user.achievedCharsPerSecond,
    })),
  });
}
trials.sort((a, b) => a.writers - b.writers);
const template = await fs.readFile(new URL('./d3-load-chart.html', import.meta.url), 'utf8');
const d3 = await fs.readFile(new URL('../node_modules/d3/dist/d3.min.js', import.meta.url), 'utf8');
const data = JSON.stringify(trials).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const html = template.replace('/* D3_BUNDLE */', () => d3).replace('/* TRIAL_DATA */', () => data);
await fs.mkdir(values.output, { recursive: true });
const output = path.join(values.output, 'd3-chart.html');
await fs.writeFile(output, html);
console.log(path.resolve(output));
