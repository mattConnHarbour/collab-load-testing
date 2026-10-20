import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadTimelineTrials } from './timeline-data.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' }, analysis: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help || !values.output || !positionals.length) {
  console.log('Usage: node scripts/latency-timeline.mjs TRIAL_DIRECTORY [...] --output DIRECTORY [--analysis profiling-analysis.json]');
  process.exit(values.help ? 0 : 1);
}
const trials = await loadTimelineTrials(positionals, { output: values.output, analysisFile: values.analysis });
const template = await fs.readFile(new URL('./latency-timeline.html', import.meta.url), 'utf8');
const d3 = await fs.readFile(new URL('../node_modules/d3/dist/d3.min.js', import.meta.url), 'utf8');
const data = JSON.stringify(trials.sort((a, b) => a.writers - b.writers)).replaceAll('<', '\\u003c');
await fs.mkdir(values.output, { recursive: true });
const output = path.join(values.output, 'latency-timeline.html');
await fs.writeFile(output, template.replace('/* D3_BUNDLE */', () => d3).replace('/* TRIAL_DATA */', () => data));
console.log(path.resolve(output));
