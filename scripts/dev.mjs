import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectEnvironment } from './environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validLogServices = new Set(['all', 'api', 'rooms', 'worker', 'agent', 'documentservice', 'collab', 'client', 'dev']);

function parseLogServices(arguments_) {
  const logIndex = arguments_.indexOf('--log');
  if (logIndex === -1) return new Set(['all']);
  const value = arguments_[logIndex + 1];
  if (!value || value.startsWith('--')) throw new Error('--log requires a comma-separated service list.');
  const services = new Set(value.split(',').map((service) => service.trim().replaceAll('-', '')).filter(Boolean));
  const invalid = [...services].filter((service) => !validLogServices.has(service));
  if (invalid.length) {
    throw new Error(`Unknown log service: ${invalid.join(', ')}. Choose from: ${[...validLogServices].join(', ')}.`);
  }
  return services;
}

const logServices = parseLogServices(process.argv.slice(2));
const logs = (service) => logServices.has('all') || logServices.has(service);

function loadEnvironment() {
  const environment = projectEnvironment();
  const port = environment.PORT || '8100';
  return {
    ...environment,
    PORT: port,
    PUBLIC_ORIGIN: environment.PUBLIC_ORIGIN || '',
    DOCUMENT_ROOT: environment.DOCUMENT_ROOT || path.join(root, 'data'),
    API_INTERNAL_ORIGIN: environment.API_INTERNAL_ORIGIN || `http://localhost:${port}`,
    SERVE_CLIENT: 'false',
    LOG_SERVICES: [...logServices].join(','),
  };
}

const environment = loadEnvironment();
const services = [
  {
    name: 'server',
    command: process.execPath,
    args: ['src/server.js'],
    cwd: path.join(root, 'server'),
    showOutput: [...logServices].some((service) => service !== 'client' && service !== 'dev') || logServices.has('all'),
  },
  { name: 'client', command: 'npm', args: ['run', 'dev'], cwd: path.join(root, 'client'), showOutput: logs('client') },
];
const processes = [];
let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of processes) if (child.exitCode === null) child.kill('SIGKILL');
  }, 5_000).unref();
  if (exitCode) process.exitCode = exitCode;
}

for (const service of services) {
  const child = spawn(service.command, service.args, {
    cwd: service.cwd,
    env: environment,
    stdio: ['inherit', service.showOutput ? 'inherit' : 'ignore', 'inherit'],
  });
  processes.push(child);
  if (logs('dev')) console.log(`[dev] started ${service.name} (pid ${child.pid})`);
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[dev] ${service.name} exited (${signal ?? code})`);
      stop(code || 1);
    }
  });
}

if (logs('dev')) console.log('[dev] open http://localhost:15174');
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
