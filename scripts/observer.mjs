import { parseArgs } from 'node:util';
import os from 'node:os';
import { chromium } from 'playwright';
import { browserArgs } from './load-runtime.mjs';

const { values } = parseArgs({ options: {
  host: { type: 'string', default: process.env.OBSERVER_HOST ?? '127.0.0.1' },
  port: { type: 'string', default: process.env.OBSERVER_PORT ?? '3100' },
  'public-host': { type: 'string' },
  headed: { type: 'boolean' }, quiet: { type: 'boolean' }, help: { type: 'boolean' },
} });

if (values.help) {
  console.log('Usage: npm run observer -- [--host 127.0.0.1] [--port 3100] [--public-host observer-host] [--headed]\nThe endpoint controls this browser. Use it over a private network or an SSH tunnel.');
} else {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer between 0 and 65535');
  const server = await chromium.launchServer({ headless: !values.headed, host: values.host, port, args: browserArgs, handleSIGINT: false, handleSIGTERM: false });
  const endpoint = new URL(server.wsEndpoint());
  if (values['public-host']) endpoint.hostname = values['public-host'];
  const metadata = { type: 'ready', endpoint: endpoint.toString(), hostname: os.hostname(), workerPid: process.pid, browserPid: server.process().pid };
  if (!values.quiet) console.log(`Observer ready\n${metadata.endpoint}`);
  process.send?.(metadata);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.close();
    if (process.connected) process.disconnect();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('disconnect', stop);
  server.once('close', () => { if (process.connected) process.disconnect(); });
}
