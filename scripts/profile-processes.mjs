import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { jsonLog } from './profile-common.mjs';

const { values } = parseArgs({ options: Object.fromEntries(['directory','server-pid','generator-pid','observer-pid'].map(name => [name,{type:'string'}])) });
const log = jsonLog(path.join(values.directory, 'process-resources.jsonl'));
const run = promisify(execFile);
const server = Number(values['server-pid']), generator = Number(values['generator-pid']), observer = Number(values['observer-pid']);
let busy = false, closed = false;
async function sample() {
  if (busy || closed) return; busy = true;
  try {
    const { stdout } = await run('ps',['-axo','pid,ppid,pcpu,rss,time,comm']);
    const rows = stdout.split('\n').flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) return [];
      const [,pid,ppid,cpu,rss,time,command] = match;
      return [{pid:Number(pid),ppid:Number(ppid),cpuPercent:Number(cpu),rssKiB:Number(rss),cpuTime:time,command}];
    });
    const parents = new Map(rows.map(row => [row.pid,row.ppid]));
    const ancestor = (pid, root) => {
      const seen = new Set();
      while (pid && !seen.has(pid)) { if (pid === root) return true; seen.add(pid); pid = parents.get(pid); }
      return false;
    };
    for (const row of rows) {
      let role;
      if (row.pid === process.pid || ancestor(row.pid,process.pid)) continue;
      if (ancestor(row.pid,server)) role = row.pid === server ? 'server' : 'server-child';
      else if (ancestor(row.pid,observer)) role = 'observer';
      else if (ancestor(row.pid,generator)) role = row.pid === generator ? 'generator' : 'writer-browser';
      if (role) log.record({type:'process-resource',role,...row});
    }
  } catch (error) { log.record({type:'sampling-error',message:error.message}); }
  finally { busy = false; }
}
await sample();
const timer = setInterval(sample,5000);
async function stop() { if (closed) return; closed = true; clearInterval(timer); await log.close(); }
process.once('SIGTERM',()=>void stop());
process.once('SIGINT',()=>void stop());
