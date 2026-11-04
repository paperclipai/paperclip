import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const directory=process.argv[2],harness=process.argv[3]??'/home/ubuntu/native-ingestion/harness-h5d';
assert.ok(path.isAbsolute(directory)&&path.isAbsolute(harness));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const helper=path.join(harness,'tests/e2e/fixtures/native-ingestion-h5.mjs');
assert.equal(hash(await readFile(helper)),'7d0629849fe776faa51a2ca1d987429be1a529df38efa8d92466bff6a8dabff2');
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:harness,encoding:'utf8'}).trim(),'2df9897e1ce2ca90be29fa097d776c3766e217ad');
const {assertParticipantSetup,assertParticipantTopology,assertSettlementObservation,assertRecordedFailures,assessH5Arm,H5_REGISTRATION,H5_WORKLOADS,H5_LIMITS}=await import(pathToFileURL(helper).href);
const evidenceBytes=await readFile(path.join(directory,'native-ingestion-evidence.json')),evidence=JSON.parse(evidenceBytes);
const pwBytes=await readFile(path.join(directory,'playwright.json')),pw=JSON.parse(pwBytes),tests=[];
assert.deepEqual(pw.errors??[],[]);
function visit(value){if(Array.isArray(value))for(const child of value)visit(child);else if(value&&typeof value==='object'){
 if(Array.isArray(value.results)&&Object.hasOwn(value,'expectedStatus'))tests.push(value);
 for(const [key,child]of Object.entries(value))if(key!=='results')visit(child);
}}
visit(pw);assert.equal(tests.length,1);const test=tests[0];assert.equal(test.expectedStatus,'passed');assert.equal(test.results.length,1);
const result=test.results[0];assert.equal(result.status,'passed');assert.equal(result.retry,0);assert.deepEqual(result.errors,[]);assert.ok(!result.error);
const attachments=result.attachments.filter(value=>value.name==='native-ingestion-evidence');assert.equal(attachments.length,1);
const attached=attachments[0].body?Buffer.from(attachments[0].body,'base64'):await readFile(path.resolve(directory,attachments[0].path));
assert.equal(hash(attached),hash(evidenceBytes),'Owning Playwright attempt must attach these exact evidence bytes');
const owner={reportFile:path.join(directory,'playwright.json'),reportSha256:hash(pwBytes),status:result.status,retry:result.retry,errors:result.errors,startedAt:result.startTime,durationMs:result.duration,timeoutMs:test.timeout};
assert.equal(evidence.complete,true);assert.equal(evidence.observationComplete,true);assert.equal(evidence.protocolVersion,'v5c-independent-agents-complete-settlement-original-sla');
assert.equal(evidence.measurementSha256,'e1d8930c47b4d3a287aa0f3baf09fbd3aa04ac30b9313b707616dea7a3fec5d4');
assert.equal(evidence.harnessProvenance.sourceRevision,'2df9897e1ce2ca90be29fa097d776c3766e217ad');assert.equal(evidence.harnessProvenance.sourceStatus,'');
assert.equal(evidence.diagnosticOnly,false);assert.equal(evidence.browserRecording.trace,'off');assert.equal(evidence.browserRecording.video,'off');assert.equal(evidence.browserRecording.screencast,false);
const outer=JSON.parse(await readFile(path.join(directory,'owner-receipt.json'),'utf8'));
assert.equal(typeof outer.fullFixture,'boolean');assert.equal(typeof evidence.qualificationOnly,'boolean');
assert.equal(outer.fullFixture,!evidence.qualificationOnly,'Owning command FULL/SMOKE mode must match its evidence');
assert.equal(outer.sourceRevision,evidence.sourceRevision);assert.equal(outer.sourceRevision,evidence.compiledBuildRevision);assert.equal(evidence.serverArtifact,'compiled');
assert.equal(outer.harnessRevision,evidence.harnessProvenance.sourceRevision);
const pathPreflight=JSON.parse(await readFile(path.join(directory,'path-node-preflight.json'),'utf8'));
assert.deepEqual(pathPreflight,outer.nodePathPreflight);
assert.equal(pathPreflight.executable,'/opt/native-ingestion/node-v26.4.0-linux-x64/bin/node');
assert.equal(pathPreflight.cwd,outer.environmentOverrides.PAPERCLIP_INGESTION_APP_ROOT);
assert.equal(pathPreflight.pathNode.version,'v26.4.0');
for(const key of ['executable','cwd','canonicalCwd','approvedCanonicalCwd','canonicalExecutable','approvedCanonicalExecutable'])
 assert.ok(typeof pathPreflight.pathNode[key]==='string'&&path.isAbsolute(pathPreflight.pathNode[key]),'Missing absolute PATH Node proof field');
assert.ok(typeof pathPreflight.pathNode.PATH==='string'&&pathPreflight.pathNode.PATH.length>0,'Missing recorded launch PATH');
assert.equal(pathPreflight.pathNode.requestedCwd,pathPreflight.cwd);
assert.equal(pathPreflight.pathNode.canonicalCwd,pathPreflight.pathNode.approvedCanonicalCwd);
assert.equal(pathPreflight.pathNode.canonicalExecutable,pathPreflight.pathNode.approvedCanonicalExecutable);
assert.equal(pathPreflight.pathNode.PATH,outer.environmentOverrides.PATH);
assert.equal(owner.timeoutMs,H5_LIMITS.fullInvocationMs);
const expectedCases=outer.fullFixture?H5_WORKLOADS:[
 {name:'qualification',runs:3,events:16,intervalMs:25,prelude:0,stop:false},
 {name:'operator-stop',runs:1,events:512,intervalMs:100,prelude:0,stop:true},
];
const matrix=item=>Object.fromEntries(['name','runs','events','intervalMs','prelude','stop'].map(key=>[key,item[key]]));
assert.deepEqual(evidence.cases.map(matrix),expectedCases.map(matrix),'Qualification requires the complete exact case matrix');
assertParticipantSetup(evidence);const cases=[];
for(const item of evidence.cases){
 assertParticipantTopology(evidence,item);
 const observed=assertSettlementObservation(item.h5.terminalObservation,item);
 const recorded=assertRecordedFailures(item.recordedFailures,item,evidence.companyId);
 cases.push({name:item.name,runs:item.runs,observedSettlement:observed,recordedFailures:recorded,
  observedTransitions:item.h5.terminalObservation.transitions,recordedFailureProof:item.recordedFailures,
  recordedRetryRate:recorded.uniqueEverFailedRuns/item.runs});
}
let assessment;
if(!evidence.qualificationOnly){assessment=assessH5Arm(evidence,owner);assert.ok(assessment.misses.every(value=>H5_REGISTRATION.knownBaselineMisses.includes(value)));}
assert.equal((await readFile(path.join(directory,'owner.exit'),'utf8')).trim(),'0');
assert.equal(outer.passed,true);assert.equal(outer.cleanupComplete,true);
const quiet=JSON.parse(await readFile(path.join(directory,'physical-quiet-after.json'),'utf8'));assert.equal(quiet.passed,true);assert.equal(quiet.platform,'linux');
const port=JSON.parse(await readFile(path.join(directory,'port-after.json'),'utf8'));assert.equal(port.nodeBindAndListenPassed,true);
const startup=await readFile(path.join(directory,'playwright.log'),'utf8');assert.match(startup,/Heartbeat\s+enabled\s*\(/,'Actual global scheduler must be enabled');
const summary={complete:true,qualificationOnly:true,performanceAcceptanceEligible:false,
 scope:'Read-only post-run qualification validation with exact frozen H5c helpers; a full observation may retain original-SLA misses and is not an accepted A/A sample',
 evidenceSha256:hash(evidenceBytes),owningPlaywright:owner,helperSha256:hash(await readFile(helper)),
 actualGlobalSchedulerConfiguredEnabled:true,assessment,cases};
await writeFile(path.join(directory,'independent-settlement-validation.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({complete:true,qualificationOnly:true,performanceAcceptanceEligible:false,assessment,
 cases:cases.map(value=>({name:value.name,runs:value.runs,recordedRetryRate:value.recordedRetryRate,recordedErrorClasses:value.recordedFailures.recordedErrorClasses}))}));
