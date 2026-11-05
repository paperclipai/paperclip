import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { it } from "vitest";

it("stages company authority only across the actual completed supervisor restart boundary", async () => {
  const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  const extract=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);const part=source.slice(a,b);assert.ok(part.trimEnd().endsWith('}'));return part;};
  const functions=extract('async function startServer()', '\nfunction delay(')+'\n'+extract('async function restartServer(', '\nfor (const signal of');
  const controls=[];
  const grantA={schema:'paperclip.acpx-candidate-admission.v1',companyId:'11111111-1111-4111-8111-111111111111',agent:'kimi',model:'kimi-for-coding',platform:'darwin',architecture:'arm64',expiresAt:Date.now()+60000};
  const grantB={...grantA,companyId:'22222222-2222-4222-8222-222222222222'};
  function factory(code){
   const events=[],spawns=[];let pid=100,stopFails=false,shuttingDown=false;
   const stop=async c=>{events.push('stop');if(stopFails)throw new Error('controlled stop failure');c.exitCode=0;events.push('stopped');};
   stop.watch=async()=>{};stop.forRestart=stop;stop.crashForRestart=stop;
   const ctx=vm.createContext({Map,Set,JSON,Date,Error,Promise,
    process:{execPath:'/controlled/pinned-node',env:{PAPERCLIP_ACPX_CANDIDATE_ADMISSION:'ambient-forgery'},stdout:{write(){}},stderr:{write(){}}},
    upgradeArtifacts:undefined,artifactIndex:0,selectedExecutions:['controlled-kimi'],
    verifyInstalledCli:async()=>null,installedReleaseLaunch:()=>{throw Error('unexpected installed path');},
    definedServerEnvironment:{PATH:'/controlled/bin'},repositoryRoot:'/controlled/repo',paperclipCli:'/controlled/cli',runnerE2EServerDetached:true,
    runnerE2ETypeScriptProcessArgs:()=>['controlled-cli','onboard','--yes','--run'],
    shutdownRequested:()=>shuttingDown,shutdownSignal:null,expectedStops:new Set(),childErrors:new Map(),servingArtifacts:new Map(),
    kimiCandidateAdmission:undefined,activeRestartRequestId:null,child:null,log:{write(){}},appendLog(){},
    stopServer:stop,waitForHealthToStop:async()=>events.push('health-stopped'),waitForHealth:async()=>events.push('healthy'),writeRestartAck:async()=>events.push('ack'),
    spawn:(executable,args,options)=>{events.push('spawn');const c=new EventEmitter();c.pid=++pid;c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.exitCode=null;c.signalCode=null;spawns.push({executable,args,options});return c;},
   });
   vm.runInContext(transformSync(code,{loader:'ts',target:'es2022',format:'cjs'}).code+'\nglobalThis.control = {startServer,restartServer};',ctx);
   return {ctx,events,spawns,setStopFails:v=>stopFails=v,setShutdown:v=>shuttingDown=v,...ctx.control};
  }
  const old=factory(functions.replace('if (stagedKimiAdmission) kimiCandidateAdmission = stagedKimiAdmission;',''));
  await old.startServer();await old.restartServer({requestId:'counterfactual-missing-assignment',kimiCandidateAdmission:grantA});
  assert.equal(old.spawns.at(-1).options.env.PAPERCLIP_ACPX_CANDIDATE_ADMISSION,undefined);
  controls.push({name:'removed-assignment counterfactual reaches real spawn without staged authority',result:'RED_REPRODUCED',counterfactualOnly:true});
  const current=factory(functions);
  await current.startServer();assert.equal(current.spawns[0].options.env.PAPERCLIP_ACPX_CANDIDATE_ADMISSION,undefined);
  controls.push({name:'initial start ignores ambient authority and has no supervisor-held record',result:'PASS'});
  current.events.length=0;
  await current.restartServer({requestId:'stage-authority',kimiCandidateAdmission:grantA});
  assert.deepEqual(JSON.parse(current.spawns.at(-1).options.env.PAPERCLIP_ACPX_CANDIDATE_ADMISSION),grantA);
  assert.ok(current.events.indexOf('stopped')<current.events.indexOf('spawn'));
  assert.ok(current.events.indexOf('health-stopped')<current.events.indexOf('spawn'));
  assert.ok(current.events.indexOf('healthy')<current.events.indexOf('ack'));
  controls.push({name:'validated staged authority reaches actual spawn after old process/health stop and before ready acknowledgement',result:'PASS'});
  await current.restartServer({requestId:'ordinary-restart'});
  assert.deepEqual(JSON.parse(current.spawns.at(-1).options.env.PAPERCLIP_ACPX_CANDIDATE_ADMISSION),grantA);
  controls.push({name:'ordinary later restart preserves exact held authority',result:'PASS'});
  const before=current.spawns.length;current.setStopFails(true);
  await assert.rejects(current.restartServer({requestId:'stop-failure',kimiCandidateAdmission:grantB}),/controlled stop failure/);
  assert.equal(current.spawns.length,before);assert.deepEqual(current.ctx.kimiCandidateAdmission,grantA);
  controls.push({name:'failed old stop neither changes held authority nor spawns replacement',result:'PASS'});
  current.setStopFails(false);current.setShutdown(true);
  await assert.rejects(current.restartServer({requestId:'shutdown',kimiCandidateAdmission:grantB}),/Wrapper shutdown/);
  assert.equal(current.spawns.length,before);assert.deepEqual(current.ctx.kimiCandidateAdmission,grantA);
  controls.push({name:'shutdown before replacement neither changes held authority nor spawns replacement',result:'PASS'});
  current.setShutdown(false);await current.startServer();await current.restartServer({requestId:'next-company',kimiCandidateAdmission:grantB});
  assert.deepEqual(JSON.parse(current.spawns.at(-1).options.env.PAPERCLIP_ACPX_CANDIDATE_ADMISSION),grantB);
  controls.push({name:'next validated disposable company replaces record only on explicit staging restart',result:'PASS'});
});
