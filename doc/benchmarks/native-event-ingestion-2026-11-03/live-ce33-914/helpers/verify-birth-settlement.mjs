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
// A successful full process-list read is required. Command failures never
// become absence evidence, including status1, signals and spawn errors.
const processList = execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,lstart=,comm='],
 {encoding:'utf8',stdio:['ignore','pipe','pipe']});
const lines = processList.split('\n').filter(line => line.trim());
assert.ok(lines.length > 0, 'Process-list snapshot is empty');
const present = new Set(lines.map(line => {
 const match = line.match(/^\s*(\d+)\s+/);
 assert.ok(match, 'Process-list snapshot contains an invalid row');
 return Number(match[1]);
}));
assert.ok(present.has(process.pid), 'Process-list snapshot does not include the verifier');
const checks=gate.chain.map(proc=>{
 assert.equal(present.has(proc.pid),false,'Exact owned birth PID remains present after settlement');
 return {pid:proc.pid,observedBirthTime:proc.birthTime,observedExecutable:proc.executable,absent:true};
});
const output={verified:true,checkedAt:new Date().toISOString(),runId:gate.runId,causalOrder:'Owned live sleep60 birth identity gate completed before ordinary UI Stop click',source:'Successful complete ps snapshot checked against exact preStop birth-identity chain',checks};
await writeFile(path.join(directory,'independent-birth-settlement-proof.json'),JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
