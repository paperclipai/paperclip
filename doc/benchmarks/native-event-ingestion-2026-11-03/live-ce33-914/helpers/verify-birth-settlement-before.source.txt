import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const directory=process.argv[2];
if (!directory) throw new Error('Pass the owned evidence directory');
const browser=JSON.parse(await readFile(path.join(directory,'live-provider-result.json'),'utf8'));
const stop=browser.journeys.find(journey=>journey.kind==='stop-live-provider');
const gate=stop.preStopProcessProof;
assert.equal(stop.status,'passed');assert.ok(gate.verifiedBeforeClickAtMs<=stop.requestedAt);
assert.equal(gate.runId,stop.activeRunId);assert.equal(gate.command,'sleep 60');
assert.ok(gate.observedProcessAgeMs+gate.verifiedBeforeClickAtMs-gate.observedAtMs<20000);
assert.equal(gate.chain[0].pid,gate.sleepPid);assert.equal(gate.chain.at(-1).pid,gate.runnerPid);
assert.ok(gate.chain.some(proc=>/verified-executable|opencode/.test(proc.executable)));
const checks=gate.chain.map(proc=>{
 let text='';try{text=execFileSync('ps',['-p',String(proc.pid),'-o','pid=,ppid=,stat=,lstart=,comm='],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
 assert.equal(text,'','Exact owned birth PID remains present after settlement');
 return {pid:proc.pid,observedBirthTime:proc.birthTime,observedExecutable:proc.executable,absent:true};
});
const output={verified:true,checkedAt:new Date().toISOString(),runId:gate.runId,causalOrder:'Owned live sleep60 birth identity gate completed before ordinary UI Stop click',source:'Independent postsettlement ps by exact preStop birth-identity chain',checks};
await writeFile(path.join(directory,'independent-birth-settlement-proof.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
