import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const require = createRequire(new URL('../client/package.json', import.meta.url));
const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping');
const { positionals, values } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' } } });
if (!positionals.length || !values.output) throw new Error('Usage: node scripts/profile-report.mjs TRIAL_DIRECTORY [...] --output DIRECTORY');
const root = path.resolve(new URL('../', import.meta.url).pathname);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const stats = values => {
  const a = values.filter(Number.isFinite).sort((a,b)=>a-b);
  return { count:a.length, mean:a.length?a.reduce((s,n)=>s+n,0)/a.length:null, p50:a[Math.ceil(a.length*.5)-1]??null, p95:a[Math.ceil(a.length*.95)-1]??null, max:a.at(-1)??null, negative:a.filter(n=>n<0).length };
};
const jsonl = async file => {
  try { return (await fs.readFile(file,'utf8')).split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}); }
  catch(error) { if(error.code==='ENOENT')return [];throw error; }
};
const maps = new Map(), symbols = new Map();
async function symbol(frame) {
  const key = JSON.stringify(frame);
  if(symbols.has(key))return symbols.get(key);
  let source=frame.url||'(native)',name=frame.functionName||'(anonymous)',line=frame.lineNumber+1,column=frame.columnNumber+1;
  const base=path.basename(source.split('?')[0]);
  if(base.endsWith('.js')) {
    if(!maps.has(base)){try{maps.set(base,new TraceMap(JSON.parse(await fs.readFile(path.join(root,'client/dist/assets',base+'.map'),'utf8'))));}catch{maps.set(base,null);}}
    const map=maps.get(base);
    if(map&&frame.lineNumber>=0){const original=originalPositionFor(map,{line:frame.lineNumber+1,column:frame.columnNumber});if(original.source){source=original.source;line=original.line;column=original.column+1;name=original.name||name;}}
  }
  const result={name,source,line,column};symbols.set(key,result);return result;
}
async function profiles(directory) {
  const targets=new Map();
  for(const file of (await fs.readdir(directory)).filter(file=>file.endsWith('.cpuprofile')).sort()){
    const profile=JSON.parse(await fs.readFile(path.join(directory,file),'utf8'));
    const target=file.replace(/-\d+\.cpuprofile$/,'');
    if(!targets.has(target))targets.set(target,{target,files:[],totalSampledMs:0,idleMs:0,gcMs:0,maxSampleGapMs:0,functions:new Map()});
    const result=targets.get(target);result.files.push(file);
    const nodes=new Map(profile.nodes.map(node=>[node.id,node]));
    const parents=new Map(profile.nodes.flatMap(node=>(node.children??[]).map(child=>[child,node.id])));
    const resolved=new Map();
    for(const node of profile.nodes)resolved.set(node.id,await symbol(node.callFrame));
    for(let i=0;i<(profile.samples??[]).length;i++){
      const node=nodes.get(profile.samples[i]);if(!node)continue;
      const ms=(profile.timeDeltas?.[i]??2000)/1000;
      result.totalSampledMs+=ms;result.maxSampleGapMs=Math.max(result.maxSampleGapMs,ms);
      if(node.callFrame.functionName==='(idle)'){result.idleMs+=ms;continue;}
      if(node.callFrame.functionName==='(garbage collector)')result.gcMs+=ms;
      const seen=new Set();let id=node.id;
      while(id!==undefined){
        const resolvedNode=resolved.get(id);if(!resolvedNode)break;
        const key=JSON.stringify(resolvedNode);
        if(!seen.has(key)){
          seen.add(key);if(!result.functions.has(key))result.functions.set(key,{...resolvedNode,selfMs:0,inclusiveMs:0,samples:0});
          const fn=result.functions.get(key);fn.inclusiveMs+=ms;if(id===node.id){fn.selfMs+=ms;fn.samples++;}
        }
        id=parents.get(id);
      }
    }
  }
  return [...targets.values()].map(target=>({...target,functions:[...target.functions.values()].filter(fn=>!['(root)','(program)'].includes(fn.name)).sort((a,b)=>b.selfMs-a.selfMs)}));
}
const results=[];
for(const directory of positionals){
  const report=JSON.parse(await fs.readFile(path.join(directory,'results.json'),'utf8'));
  const profileDir=path.join(directory,'profiling');
  const backendDir=report.profiling.serverDirectory;
  const backend=await jsonl(path.join(backendDir,'server-events.jsonl'));
  const writer=await jsonl(path.join(profileDir,'U01-browser-events.jsonl'));
  const observer=await jsonl(path.join(profileDir,'observer-browser-events.jsonl'));
  const generator=await jsonl(path.join(profileDir,'generator-events.jsonl'));
  const processes=await jsonl(path.join(profileDir,'process-resources.jsonl'));
  const traffic = { incoming: {}, outgoing: {}, awarenessReturned: 0, awarenessIncoming: 0, uniqueAwarenessPayloads: 0 };
  const awarenessSent = new Map(), awarenessHashes = new Set();
  for(const event of backend){
    if(!['ws-send','ws-receive'].includes(event.type))continue;
    const direction=event.type==='ws-send'?'outgoing':'incoming',kind=event.kind??'other';
    traffic[direction][kind]??={count:0,bytes:0};traffic[direction][kind].count++;traffic[direction][kind].bytes+=event.bytes;
    if(kind!=='awareness')continue;
    const key=event.connection+':'+event.hash;
    if(event.type==='ws-send')awarenessSent.set(key,event.atEpochMs);
    else {traffic.awarenessIncoming++;awarenessHashes.add(event.hash);const sentAt=awarenessSent.get(key);if(sentAt!==undefined&&event.atEpochMs>=sentAt)traffic.awarenessReturned++;}
  }
  traffic.uniqueAwarenessPayloads=awarenessHashes.size;
  const hostSnapshots=[];
  for(const suffix of ['', '-second']){
    try { hostSnapshots.push({ ...JSON.parse(await fs.readFile(path.join(profileDir,`host-memory${suffix}.json`),'utf8')), swap:await fs.readFile(path.join(profileDir,`host-swap${suffix}.txt`),'utf8'), vm:await fs.readFile(path.join(profileDir,`host-vm-stat${suffix}.txt`),'utf8') }); } catch {}
  }
  const keys=report.users.flatMap(user=>user.keystrokes);
  const wireRows=[];
  const byHash=rows=>{const map=new Map();for(const row of rows){if(!row.updateHash)continue;if(!map.has(row.updateHash))map.set(row.updateHash,[]);map.get(row.updateHash).push(row);}return map;};
  const received=byHash(backend.filter(row=>row.type==='ws-receive'&&row.user==='U01'));
  const sent=byHash(backend.filter(row=>row.type==='ws-send'&&row.user==='observer'));
  const observed=byHash(observer.filter(row=>row.type==='ws-receive'));
  const used=new Set();
  for(const frame of writer.filter(row=>row.type==='ws-send'&&row.kind==='update')){
    if(used.has(frame.updateHash))continue;used.add(frame.updateHash);
    const receive=received.get(frame.updateHash)?.[0],send=sent.get(frame.updateHash)?.[0],observe=observed.get(frame.updateHash)?.[0];
    wireRows.push({updateHash:frame.updateHash,bytes:frame.bytes,writerAt:frame.atEpochMs,serverReceiveAt:receive?.atEpochMs,serverSendAt:send?.atEpochMs,observerReceiveAt:observe?.atEpochMs,
      writerToServerMs:receive?receive.atEpochMs-frame.atEpochMs:null,backendRelayMs:receive&&send?send.atEpochMs-receive.atEpochMs:null,serverToObserverMs:send&&observe?observe.atEpochMs-send.atEpochMs:null});
  }
  const browserMetrics=events=>{
    const samples=events.filter(event=>event.type==='browser-metrics');const first=samples[0]?.metrics,last=samples.at(-1)?.metrics;
    return {samples:samples.length,delta:first&&last?Object.fromEntries(['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'].map(name=>[name,(last[name]??0)-(first[name]??0)])):null,
      longTasks:stats(events.filter(event=>event.type==='long-task').map(event=>event.durationMs)),inputEventProcessing:stats(events.filter(event=>event.type==='input-event').map(event=>event.processingMs)),
      clock:events.find(event=>event.type==='cdp-clock'),errors:events.filter(event=>event.type==='profiling-error')};
  };
  const perProcess=new Map();
  for(const row of processes.filter(row=>row.type==='process-resource')){
    if(!perProcess.has(row.pid))perProcess.set(row.pid,{pid:row.pid,role:row.role,command:row.command,cpu:[],rss:[]});
    const p=perProcess.get(row.pid);p.cpu.push(row.cpuPercent);p.rss.push(row.rssKiB);
  }
  results.push({writers:report.config.users,status:report.status,partial:report.partial,reportPath:path.resolve(directory),durationSeconds:report.durationMs/1000,
    capturedKeys:keys.length,expectedKeys:report.config.users*report.expectedText.length,allTextMatched:report.users.length===report.config.users&&report.users.every(user=>user.matches),
    latency:{dispatch:stats(report.users.flatMap(user=>user.scheduled.map(event=>event.latenessMs))),delivery:stats(keys.map(key=>key.inputDeliveryMs)),local:stats(keys.map(key=>key.localMs)),remote:stats(keys.map(key=>key.remoteMs))},
    achievedRates:report.users.map(user=>user.achievedCharsPerSecond),clockUncertaintyMs:report.clockUncertaintyMs,failures:report.failures,
    backend:{directory:backendDir,traffic,transactions:stats(backend.filter(row=>row.type==='yjs-transaction').map(row=>row.durationMs)),broadcast:stats(backend.filter(row=>row.type==='yjs-update-broadcast').map(row=>row.durationMs)),
      enqueue:stats(backend.filter(row=>row.type==='socket-send-enqueue').map(row=>row.durationMs)),framesReceived:backend.filter(row=>row.type==='ws-receive').length,framesSent:backend.filter(row=>row.type==='ws-send').length,
      resource:backend.filter(row=>row.type==='resource'),cpuProfiles:await profiles(backendDir)},
    transport:{matchedUpdates:wireRows,writerToServer:stats(wireRows.map(row=>row.writerToServerMs)),backendRelay:stats(wireRows.map(row=>row.backendRelayMs)),serverToObserver:stats(wireRows.map(row=>row.serverToObserverMs))},
    writer:browserMetrics(writer),observer:browserMetrics(observer),generator:generator.filter(row=>row.type==='resource'),cpuProfiles:await profiles(profileDir),
    processes:[...perProcess.values()].map(p=>({...p,cpu:stats(p.cpu),rssKiB:stats(p.rss)})),hostSnapshots,profiling:report.profiling});
}
await fs.mkdir(values.output,{recursive:true});
await fs.writeFile(path.join(values.output,'profiling-analysis.json'),JSON.stringify(results,null,2));
let findings='';
try { findings=await fs.readFile(path.join(values.output,'findings.html'),'utf8'); } catch(error) { if(error.code!=='ENOENT')throw error; }
const ms=value=>value==null?'—':`${value.toFixed(1)} ms`;
const table=(headers,rows)=>`<div class="scroll"><table><thead><tr>${headers.map(h=>`<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
let content='';
for(const run of results){
  const link=path.relative(path.resolve(values.output),path.join(run.reportPath,'report.html'));
  content+=`<h2>${run.writers} users · ${escape(run.status.toUpperCase())}${run.partial?' · PARTIAL':''}</h2><p>${run.capturedKeys}/${run.expectedKeys} keydowns captured. Final text matched: ${run.allTextMatched}. Duration: ${run.durationSeconds.toFixed(1)} s. <a href="${escape(link)}">Full latency report</a></p>`;
  content+=table(['Timing boundary','Samples','Mean','p50','p95','Max'],Object.entries(run.latency).map(([name,stat])=>[escape(name),stat.count,ms(stat.mean),ms(stat.p50),ms(stat.p95),ms(stat.max)]));
  content+='<h3>Transport and backend operations</h3>';
  const traffic=run.backend.traffic;
  content+=table(['Message category','Incoming frames','Outgoing frames','Incoming MiB','Outgoing MiB'],['awareness','update','sync','other'].map(kind=>[kind,traffic.incoming[kind]?.count??0,traffic.outgoing[kind]?.count??0,((traffic.incoming[kind]?.bytes??0)/2**20).toFixed(2),((traffic.outgoing[kind]?.bytes??0)/2**20).toFixed(2)]));
  content+=`<p><strong>Presence-message amplification:</strong> ${traffic.awarenessReturned.toLocaleString()} of ${traffic.awarenessIncoming.toLocaleString()} incoming awareness frames (${(100*traffic.awarenessReturned/traffic.awarenessIncoming).toFixed(1)}%) repeat an identical payload previously sent by the server to that same connection. There are ${traffic.uniqueAwarenessPayloads.toLocaleString()} unique incoming awareness payloads. This supports a fan-out/echo hypothesis; it does not establish an infinite loop or attribute all latency to presence.</p>`;
  content+=table(['Operation','Samples','Mean','p95','Max','Negative estimates'],[
    ['U01 socket send → server receive',run.transport.writerToServer],['Server receive → observer send enqueue',run.transport.backendRelay],['Server enqueue → observer socket receipt',run.transport.serverToObserver],
    ['Backend Yjs transaction',run.backend.transactions],['Backend synchronous update listeners / broadcast enqueue',run.backend.broadcast],['Backend socket send call (enqueue)',run.backend.enqueue],
  ].map(([name,s])=>[name,s.count,ms(s.mean),ms(s.p95),ms(s.max),s.negative]));
  content+=`<p>Backend frames: ${run.backend.framesReceived} received, ${run.backend.framesSent} sent. Cross-process clock bounds: writer ±${run.writer.clock?.uncertaintyMs?.toFixed(1)??'?'} ms; observer ±${run.observer.clock?.uncertaintyMs?.toFixed(1)??'?'} ms. Negative cross-process estimates are retained and must be interpreted within calibration uncertainty. A socket send call enqueues data; it does not establish delivery. Update matching is limited to exact Yjs-update hashes captured for U01, not a per-keystroke attribution.</p>`;
  for(const [name,metrics] of [['Writer U01',run.writer],['Observer',run.observer]]){
    content+=`<h3>${name}: browser work</h3><p>Long tasks: ${metrics.longTasks.count}, p95 ${ms(metrics.longTasks.p95)}, max ${ms(metrics.longTasks.max)}. Performance counter deltas between first and last available samples:</p><pre>${escape(JSON.stringify(metrics.delta,null,2))}</pre>`;
  }
  content+='<h3>Sampled function stacks</h3><p>Self time attributes samples to the executing frame; inclusive time also includes its descendants. Values are sampled wall-time estimates, affected by OS scheduling and profiling overhead, not precise operation durations. Native/program/idle coverage and large gaps limit attribution. Open raw .cpuprofile files in DevTools for full calling stacks. Source maps are used where available.</p>';
  for(const target of [...run.cpuProfiles.map(target=>({...target,directory:path.join(run.reportPath,'profiling')})),...run.backend.cpuProfiles.map(target=>({...target,directory:run.backend.directory}))]){
    content+=`<details><summary>${escape(target.target)} · ${(target.totalSampledMs/1000).toFixed(1)} s sampled · ${(target.idleMs/1000).toFixed(1)} s idle · GC ${(target.gcMs/1000).toFixed(1)} s · largest sample gap ${ms(target.maxSampleGapMs)}</summary>`;
    content+=`<p>${target.files.map(file=>`<a href="${escape(path.relative(path.resolve(values.output),path.join(target.directory,file)))}">${escape(file)}</a>`).join(' · ')}</p>`;
    content+=table(['Function','Self sampled','Inclusive sampled','Source'],target.functions.slice(0,20).map(fn=>[escape(fn.name),ms(fn.selfMs),ms(fn.inclusiveMs),`<code>${escape(fn.source)}:${fn.line}:${fn.column}</code>`]));content+='</details>';
  }
  content+='<h3>Node event-loop and process resources</h3>';
  if(run.hostSnapshots.length){
    content+='<h3>Host memory and paging evidence</h3>';
    content+=table(['Captured at','RAM GiB','Free MiB','Load average (1 / 5 / 15 min)','Swap'],run.hostSnapshots.map(s=>[escape(s.at),(s.total/2**30).toFixed(1),(s.free/2**20).toFixed(1),s.load.map(n=>n.toFixed(1)).join(' / '),escape(s.swap)]));
    if(run.hostSnapshots.length===2){
      const parse=s=>Object.fromEntries([...s.matchAll(/^([^:\n]+):\s+(\d+)/gm)].map(m=>[m[1],Number(m[2])]));
      const first=parse(run.hostSnapshots[0].vm),last=parse(run.hostSnapshots[1].vm);
      const pageSize=Number(run.hostSnapshots[0].vm.match(/page size of (\d+) bytes/)?.[1]??16384);
      content+=`<p>Between snapshots (approximately ${((Date.parse(run.hostSnapshots[1].at)-Date.parse(run.hostSnapshots[0].at))/1000).toFixed(1)} s), swap-in increased by ${((last.Swapins-first.Swapins)*pageSize/2**30).toFixed(2)} GiB and swap-out by ${((last.Swapouts-first.Swapouts)*pageSize/2**30).toFixed(2)} GiB. These host-wide counters demonstrate active paging, but do not identify which process owns the swapped pages.</p>`;
    }
  }
  content+=table(['Node role','Resource samples','CPU % mean / max','Event-loop max delay','Longest sampling interval'],[['Backend',run.backend.resource],['Generator',run.generator]].map(([name,rows])=>[name,rows.length,`${stats(rows.map(r=>r.cpuPercent)).mean?.toFixed(1)} / ${stats(rows.map(r=>r.cpuPercent)).max?.toFixed(1)}`,ms(stats(rows.map(r=>r.eventLoopMaxMs)).max),ms(stats(rows.map(r=>r.elapsedMs)).max)]));
  content+=table(['Role','PID / executable','ps CPU % mean / max','Peak RSS MiB'],run.processes.sort((a,b)=>(b.cpu.max??0)-(a.cpu.max??0)).map(p=>[p.role,`${p.pid} · ${escape(path.basename(p.command))}`,`${p.cpu.mean?.toFixed(1)} / ${p.cpu.max?.toFixed(1)}`,(p.rssKiB.max/1024).toFixed(1)]));
  content+='<p>ps CPU percentages reflect the OS estimator, rather than exact per-interval CPU deltas. The 10-user process-tree sampler began during convergence; backend/generator in-process sampling covers the measured workload. The native SDK subprocess is resource-sampled, not function-profiled. Event-loop histograms can have no observations during a long stall; zero in those buckets does not imply responsiveness.</p>';
  content+=`<details><summary>Errors and profiling limitations</summary><pre>${escape(JSON.stringify({validation:run.failures,profiling:run.profiling.errors,writer:run.writer.errors,observer:run.observer.errors},null,2))}</pre></details>`;
}
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Profiled collaboration trials</title><style>body{font:14px system-ui;margin:0;background:#f5f6f9;color:#182033}main{max-width:1200px;background:white;margin:24px auto;padding:30px}p{line-height:1.6}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{padding:10px;text-align:left;border-bottom:1px solid #e1e5ec;vertical-align:top}th{font-size:12px;color:#566075}.scroll{overflow:auto}code,pre{font:12px ui-monospace,monospace}pre{white-space:pre-wrap;background:#f5f6f9;padding:14px}details{border:1px solid #e1e5ec;padding:12px;margin:10px 0}summary{cursor:pointer;font-weight:600}a{color:#1355ff}h2{margin-top:40px}</style><main><h1>Profiled first-page collaboration trials</h1><p>10 and 20 users each type “the quick fox jumped over the lazy dog” once, scheduled together at 5 characters/second. Server, browsers and generator share this Mac. CPU sampling was requested for U01, the observer and their workers, plus the generator and backend Node process. Only successfully exported profiles are listed below; worker export timeouts are retained in the errors section. Profiling, transport logging, source maps and streamed checkpoints add overhead: these runs diagnose operations, rather than establish a clean speed comparison with the earlier unprofiled trials. No 30-user trial was run.</p><p><a href="d3-chart.html">Interactive latency chart</a> · <a href="profiling-analysis.json">Machine-readable profiling analysis</a></p>${findings}${content}</main></html>`;
await fs.writeFile(path.join(values.output,'profiling-report.html'),html);
console.log(path.resolve(values.output,'profiling-report.html'));
