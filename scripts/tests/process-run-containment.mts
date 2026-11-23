import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { transformSync } from "esbuild";
const root=path.resolve(process.argv[2]);
const company="0000000a-0000-4000-8000-00000000000a";
const runs=["0000000b-0000-4000-8000-00000000000b","0000000c-0000-4000-8000-00000000000c"];
const source=(p:string)=>fs.readFileSync(path.join(root,p),"utf8");
function load(file:string, dependencies:Record<string,unknown>){
 const module={exports:{} as any};
 const code=transformSync(source(file),{loader:"ts",format:"cjs",target:"es2022"}).code;
 vm.runInNewContext(code,{module,exports:module.exports,require:(n:string)=>{if(!(n in dependencies))throw Error("Unmocked dependency: "+n);return dependencies[n]},Map,Set,Promise,Date,Object,Array,Number,Boolean,JSON,process:{env:{}}},{filename:file});return module.exports;
}
const jwt=load("server/src/agent-auth-jwt.ts",{"node:crypto":{},"@paperclipai/shared":{},"./home-paths.js":{}});
const mockTables=Object.fromEntries(["issues","heartbeatRuns"].map(table=>[table,new Proxy({}, {get:(_target,key)=>table+"."+String(key)})]));
const privacy=load("server/src/services/heartbeat-run-privacy.ts",{"../agent-auth-jwt.js":jwt,"@paperclipai/db":mockTables,"drizzle-orm":{and:()=>0,eq:()=>0,inArray:()=>0},"./authorization.js":{},"../database-retry.js":{retryIdempotentDatabaseOperation:(f:Function)=>f()}});
let checks=0,failures=0;
async function check(name:string,f:()=>unknown){try{await f();checks++;}catch{failures++;console.log("FAIL",name)}}
const db={select:()=>({from:()=>({where:()=>Promise.resolve([{id:"issue"}])})})};
const actor={type:"board",isInstanceAdmin:true};
const access={decide:async()=>({allowed:true})};
for(const run of runs){
 await check(run+" company scope denied",async()=>assert.equal(await privacy.canActorReadHeartbeatRun(db,access,actor,{companyId:company,id:run,scopeKind:"company"}),false));
 await check(run+" issue scope denied",async()=>assert.equal(await privacy.canActorReadHeartbeatRun(db,access,actor,{companyId:company,id:run,scopeKind:"issue",issueId:"issue"}),false));
 for(const batch of [access,{...access,decideReads:async(_a:unknown,r:unknown[])=>r.map(()=>({allowed:true}))}]){
  await check(run+" mixed batch isolation",async()=>{const got=await privacy.getHeartbeatRunReadDecisions(db,batch,actor,[{companyId:company,id:"other",scopeKind:"company"},{companyId:company,id:run,scopeKind:"company"}]);assert.equal(JSON.stringify(got),"[true,false]")});
 }
}
await check("Process native tuple denied",()=>assert.equal(jwt.isRevokedIncidentRunAuthority(company,"0000000d-0000-4000-8000-00000000000d",runs[0]),true));
await check("Runtime native tuple denied",()=>assert.equal(jwt.isRevokedIncidentRunAuthority(company,"0000000e-0000-4000-8000-00000000000e",runs[1]),true));
await check("foreign company unaffected",()=>assert.equal(jwt.isRestrictedIncidentRunOutput("other",runs[0]),false));
await check("wrong agent unaffected",()=>assert.equal(jwt.isRevokedIncidentRunAuthority(company,"other",runs[0]),false));
await check("ordinary company read preserved",async()=>assert.equal(await privacy.canActorReadHeartbeatRun(db,access,actor,{companyId:company,id:"other",scopeKind:"company"}),true));
await check("native verifier invokes denial",()=>assert.match(source("server/src/agent-auth-jwt.ts"),/if \(isRevokedIncidentRunAuthority\(companyId, sub, runId\)\) return null/));
await check("creation source retains run identity",()=>assert.match(source("server/src/routes/issues.ts"),/const runVisible[\s\S]{0,180}id: run.id/));
await check("live event retains run identity",()=>assert.match(source("server/src/realtime/live-events-ws.ts"),/const \[run\] = await db.select\(\{\s+id: heartbeatRuns.id/));
for(const operation of ["inspect","revealFrame","download"]){await check("provider trace "+operation+" gated",()=>{const s=source("server/src/routes/agents.ts");const offset=s.indexOf("await providerTraces."+operation+"(");assert.match(s.slice(offset-130,offset),/assertRunReadAllowed\(req, res, run\)/)})}

// Model Drizzle's selected projection: omitted columns must not appear in rows.
// A DB mock returning the entire fixture would hide a lost run ID.
const ordinaryRun="11111111-1111-4111-8111-111111111111";
function workspaceDb(runId:string, scopeKind:string, exists=true){
 return {select:(selection:Record<string,string>)=>({from:(table:unknown)=>({where:()=>{
  const projected=Object.fromEntries(Object.entries(selection).map(([key,column])=>[key,({id:runId,companyId:company,scopeKind,issueId:"22222222-2222-4222-8222-222222222222"} as Record<string,string>)[column.split(".").at(-1)!]]));
  const rows=Promise.resolve(exists?[projected]:[]);
  return Object.assign(rows,{limit:async()=>exists?[projected]:[]});
 }})})};
}
for(const scopeKind of ["company","issue"]){
 for(const historical of [false,true]){
  const operation=(runId:string)=>({companyId:company,...(historical?{metadata:{_runPrivacySources:{[runId]:true}}}:{heartbeatRunId:runId})});
  for(const run of runs){
   await check(run+" workspace "+scopeKind+" "+(historical?"historical":"current")+" denied",async()=>assert.equal(await privacy.canActorReadWorkspaceOperation(workspaceDb(run,scopeKind),access,actor,operation(run)),false));
  }
  await check("ordinary workspace "+scopeKind+" "+(historical?"historical":"current")+" allowed",async()=>assert.equal(await privacy.canActorReadWorkspaceOperation(workspaceDb(ordinaryRun,scopeKind),access,actor,operation(ordinaryRun)),true));
 }
}
await check("missing workspace source denied",async()=>assert.equal(await privacy.canActorReadWorkspaceOperation(workspaceDb(ordinaryRun,"company",false),access,actor,{companyId:company,heartbeatRunId:ordinaryRun}),false));
await check("invalid historical source denied",async()=>assert.equal(await privacy.canActorReadWorkspaceOperation(workspaceDb(ordinaryRun,"company"),access,actor,{companyId:company,metadata:{_runPrivacySources:{invalid:true}}}),false));

console.log(JSON.stringify({checks,failures,sourceOnly:true,liveIncidentClassification:false}));if(failures)process.exitCode=1;
