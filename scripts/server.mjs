import { projectEnvironment } from './environment.mjs';

Object.assign(process.env, projectEnvironment());
process.env.SERVE_CLIENT ??= 'true';
await import('../server/src/server.js');
