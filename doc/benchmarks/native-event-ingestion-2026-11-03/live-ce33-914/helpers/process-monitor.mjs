import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const directory=process.argv[2];
if (!directory) throw new Error('Pass the owned evidence directory');
const launch=JSON.parse(await readFile(path.join(directory,'live-launch.json'),'utf8'));
const observed=new Map(),runSnapshots=[],sleepHistory=[];
const start=Date.now();let terminalAt,cachedRuns=[],lastApi=0,lastRunSignature='';
const elapsedSeconds=text=>{const parts=text.split('-');const days=parts.length===2?Number(parts.shift()):0;return days*86400+parts[0].split(':').map(Number).reduce((total,value)=>total*60+value,0);};
while(Date.now()-start<300000){
 const at=Date.now();
 if(at-lastApi>=250){
  const response=await fetch(new URL(`/api/companies/${launch.company.id}/heartbeat-runs?agentId=${launch.agent.id}&limit=100`,launch.origin));
  if(!response.ok)throw new Error('Owned run snapshot read failed');cachedRuns=await response.json();lastApi=at;
 }
 const output=execFileSync('ps',['-axo','pid=,ppid=,pgid=,stat=,lstart=,comm='],{encoding:'utf8'});
 const processes=output.split('\n').flatMap(line=>{const m=line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/);return m?[{pid:Number(m[1]),parentPid:Number(m[2]),processGroupId:Number(m[3]),state:m[4],birthTime:m[5],executable:path.basename(m[6])}]:[];});
 const byPid=new Map(processes.map(proc=>[proc.pid,proc]));
 const roots=new Set([launch.pid,...cachedRuns.map(row=>row.processPid).filter(pid=>Number.isInteger(pid)&&pid>1)]);
 for(let pass=0;pass<10;pass++)for(const proc of processes)if(roots.has(proc.parentPid))roots.add(proc.pid);
 for(const proc of processes)if(roots.has(proc.pid)){const previous=observed.get(proc.pid);observed.set(proc.pid,{...proc,firstSeen:previous?.firstSeen??at,lastSeen:at});}
 const signature=JSON.stringify(cachedRuns.map(run=>({id:run.id,status:run.status,processPid:run.processPid??null,processGroupId:run.processGroupId??null})));
 if(signature!==lastRunSignature){runSnapshots.push({atMs:at,runs:JSON.parse(signature)});lastRunSignature=signature;}
 const sleepCandidates=[];
 for(const run of cachedRuns.filter(run=>run.status==='running'&&Number.isInteger(run.processPid))){
  const runner=byPid.get(run.processPid);if(runner?.executable!=='paperclip-runnerd')continue;
  for(const proc of processes.filter(proc=>proc.executable==='sleep'&&!proc.state.startsWith('Z'))){
   const chain=[];let cursor=proc;
   for(let depth=0;cursor&&depth<10;depth++){chain.push(cursor);if(cursor.pid===runner.pid)break;cursor=byPid.get(cursor.parentPid);}
   if(chain.at(-1)?.pid!==runner.pid||!chain.some(row=>/verified-executable|opencode/.test(row.executable)))continue;
   let detail='';try{detail=execFileSync('ps',['-p',String(proc.pid),'-o','etime=,args='],{encoding:'utf8'}).trim();}catch{continue;}
   const m=detail.match(/^(\S+)\s+((?:\/[\w./-]+\/)?sleep\s+60)$/);if(!m)continue;
   const ageMs=elapsedSeconds(m[1])*1000;if(ageMs>=20000)continue;
   const proof={observedAtMs:Date.now(),companyId:launch.company.id,runId:run.id,runnerPid:runner.pid,sleepPid:proc.pid,sleepBirthTime:proc.birthTime,observedProcessAgeMs:ageMs,command:m[2],chain};
   sleepCandidates.push(proof);
   if(!sleepHistory.some(value=>value.runId===proof.runId&&value.sleepPid===proof.sleepPid&&value.sleepBirthTime===proof.sleepBirthTime))sleepHistory.push(proof);
  }
 }
 await writeFile(path.join(directory,'process-gate.json'),JSON.stringify({appPid:launch.pid,lastSampleAtMs:Date.now(),sleepCandidates},null,2));
 await writeFile(path.join(directory,'owned-process-observations.json'),JSON.stringify({appPid:launch.pid,observed:[...observed.values()],runSnapshots,sleepHistory,startedAtMs:start,lastSampleAtMs:at,complete:false},null,2));
 try{const result=JSON.parse(await readFile(path.join(directory,'live-provider-result.json'),'utf8'));if(['passed','failed'].includes(result.status))terminalAt??=Date.now();}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
 if(terminalAt&&Date.now()-terminalAt>3000)break;
 await new Promise(resolve=>setTimeout(resolve,75));
}
const finalOutput=execFileSync('ps',['-axo','pid=,comm='],{encoding:'utf8'});
const alive=new Set(finalOutput.split('\n').flatMap(line=>{const m=line.match(/^\s*(\d+)\s+(.+)$/);return m?[Number(m[1])]:[];}));
const result={appPid:launch.pid,observed:[...observed.values()].map(proc=>({...proc,aliveAtFinalSnapshot:alive.has(proc.pid)})),runSnapshots,sleepHistory,startedAtMs:start,finishedAtMs:Date.now(),complete:Boolean(terminalAt)};
await writeFile(path.join(directory,'owned-process-observations.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({complete:result.complete,observedProcesses:result.observed.length,sleepBirthIdentities:result.sleepHistory.length}));
