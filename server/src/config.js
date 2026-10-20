import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maximumUploadMegabytes = 25;
const port = Number(process.env.PORT ?? 8100);
const publicOrigin = process.env.PUBLIC_ORIGIN?.replace(/\/$/, '') || null;
const defaultClientOrigins = [
  publicOrigin ?? `http://localhost:${port}`,
  'http://localhost:15174',
  'http://127.0.0.1:15174',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

export const config = Object.freeze({
  port,
  host: process.env.HOST ?? '0.0.0.0',
  publicOrigin,
  serveClient: process.env.SERVE_CLIENT !== 'false',
  clientDist: path.resolve(process.env.CLIENT_DIST_DIR ?? path.join(serverRoot, '..', 'client', 'dist')),
  documentRoot: path.resolve(process.env.DOCUMENT_ROOT ?? path.join(serverRoot, '..', 'data')),
  blankDocumentPath: path.join(serverRoot, 'assets', 'blank.docx'),
  roomTtlMs: Number(process.env.ROOM_TTL_SECONDS ?? 3600) * 1000,
  completedJobTtlMs: Number(process.env.COMPLETED_JOB_TTL_SECONDS ?? 600) * 1000,
  openaiModel: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
  clientOrigins: (process.env.CLIENT_ORIGINS ?? defaultClientOrigins.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  maximumUploadMegabytes,
  maximumUploadBytes: maximumUploadMegabytes * 1024 * 1024,
});
