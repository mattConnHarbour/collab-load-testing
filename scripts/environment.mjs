import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function projectEnvironment() {
  const file = fileURLToPath(new URL('../.env', import.meta.url));
  const values = {};
  if (fs.existsSync(file)) {
    for (const source of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = source.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const separator = line.indexOf('=');
      values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return { ...values, ...process.env };
}
