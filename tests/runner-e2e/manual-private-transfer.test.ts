import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { validateSealedInventory } from "./manual-private-transfer.js";
import { sealManualResultEvidence, type ManualPrivateHandoff } from "./manual-private-handoff.js";
import { MANUAL_PRIVATE_PROTOCOL, MANUAL_PRIVATE_EXECUTIONS } from "./manual-private-retention.js";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),"manual-transfer-test-"));roots.push(root);await mkdir(path.join(root,"results"));const context={root,protocol:MANUAL_PRIVATE_PROTOCOL,private:true,workflowSha:"a".repeat(40),targetSha:"b".repeat(40),runId:"123",attempt:"1",executionIds:["chat-features.runner-opencode.local.activity.agent-feedback"]} as ManualPrivateHandoff;return{root,context};}
it("seals genuine final result bytes and rejects an unscanned staged addition before transfer",async()=>{
 const f=await fixture();await writeFile(path.join(f.root,"results","campaign.json"),'{"cleanup":"passed"}');
 await sealManualResultEvidence(f.context,[]);const dir=path.join(f.root,"sealed-results","html-report");
 expect((await validateSealedInventory(dir,"../result-evidence-inventory.json")).complete).toBe(true);
 await writeFile(path.join(dir,"staged.db"),"unscanned");await expect(validateSealedInventory(dir,"../result-evidence-inventory.json")).rejects.toThrow(/Unscanned/);
});
it("rejects modification of final cleanup/result bytes after the scan",async()=>{
 const f=await fixture();await writeFile(path.join(f.root,"results","campaign.json"),'{}');await sealManualResultEvidence(f.context,[]);
 const dir=path.join(f.root,"sealed-results","html-report");await writeFile(path.join(dir,"campaign.json"),'{"later":true}');await expect(validateSealedInventory(dir,"../result-evidence-inventory.json")).rejects.toThrow(/changed/);
});
it("an abnormal fallback cannot retain credential-bearing final data or unsupported staged bytes",async()=>{
 const f=await fixture();await writeFile(path.join(f.root,"results","result.json"),'{"originalResult":"synthetic-final-credential-123456"}');
 await expect(sealManualResultEvidence(f.context,["synthetic-final-credential-123456"])).rejects.toThrow(/contamination/);
 await writeFile(path.join(f.root,"results","result.json"),'{}');await writeFile(path.join(f.root,"results","unknown.bin"),"opaque");
 await expect(sealManualResultEvidence(f.context,[])).rejects.toThrow(/Unsupported/);
});
it("rejects a forged inventory that lists an unscannable original carrier",async()=>{
 const f=await fixture(),dir=path.join(f.root,"results");await mkdir(path.join(dir,"snapshots"));await writeFile(path.join(dir,"snapshots","unknown.bin"),"secret");
 const files=[{path:"snapshots/unknown.bin",bytes:6,sha256:createHash("sha256").update("secret").digest("hex")}];
 await writeFile(path.join(dir,"inventory.json"),JSON.stringify({protocol:MANUAL_PRIVATE_PROTOCOL,complete:true,executionId:"id",sourceBytes:6,files,inventorySha256:createHash("sha256").update(JSON.stringify(files)).digest("hex")}));
 await expect(validateSealedInventory(dir,"inventory.json","id")).rejects.toThrow(/row/);
});

it.each([
 ["activity.agent-feedback", "none"],
 ["activity.agent-feedback", "assets"],
 ["access.invite-teammate", "none"],
 ["activity.routine-audit", "none"],
 ["access.invite-teammate", "old-retention"],
 ["activity.routine-audit", "old-retention"],
])("actual prepare checks exact protocol for %s before credentials (tampered=%s)", async (caseId, tampered) => {
 const root=await mkdtemp(path.join(os.tmpdir(),"synthetic-prepare-dependency-"));roots.push(root);
 const target=path.join(root,"target"),modules=path.join(target,"tests/runner-e2e");await mkdir(modules,{recursive:true});
 const trusted=path.resolve(import.meta.dirname,"../.."),launch=Buffer.from("synthetic approved launcher; never executed");await writeFile(path.join(modules,"launch.ts"),launch);
 for(const name of ["manual-private-handoff.ts","manual-private-retention.ts","manual-private-report-assets.ts"])await copyFile(path.join(import.meta.dirname,name),path.join(modules,name));
 if(tampered === "assets")await writeFile(path.join(modules,"manual-private-report-assets.ts"),"synthetic incompatible dependency; never executed");
 // Exact 436 retention postimage (e133bfac...), compressed only to keep this synthetic fixture small.
 if(tampered === "old-retention"){
  const oldRetention=gunzipSync(Buffer.from("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", "base64"));
  expect(createHash("sha256").update(oldRetention).digest("hex")).toBe("e133bfacac985d95bbf7812d369569f30709aeebf324a0d37416c65c94ffa98a");
  await writeFile(path.join(modules,"manual-private-retention.ts"),oldRetention);
 }
 const workflowSha="a".repeat(40),targetSha="b".repeat(40),id=`chat-features.runner-opencode.local.${caseId}`,output=path.join(root,"outputs.txt");
 const require=createRequire(import.meta.url),tsx=require.resolve("tsx",{paths:[path.join(trusted,"server")]});
 const result=spawnSync(process.execPath,["--import",tsx,path.join(import.meta.dirname,"manual-private-transfer.ts"),"prepare"],{encoding:"utf8",timeout:10000,env:{PATH:process.env.PATH,NODE_OPTIONS:"",NODE_PATH:"",SELECTED_EXECUTION_ID:id,MANUAL_PRIVATE_IDS:JSON.stringify([id]),MANUAL_PRIVATE_APPROVALS_JSON:JSON.stringify({version:1,approvals:[{workflowSha,targetSha,runId:"123",attempt:"1",executionIds:[id],protocol:MANUAL_PRIVATE_PROTOCOL,launchSha256:createHash("sha256").update(launch).digest("hex")}]}),GITHUB_SHA:workflowSha,TARGET_SHA:targetSha,GITHUB_RUN_ID:"123",GITHUB_RUN_ATTEMPT:"1",RUNNER_E2E_PRIVATE_HISTORY_S3_BUCKET:"private-bucket",TARGET_ROOT:target,RUNNER_TEMP:root,GITHUB_OUTPUT:output}});
 expect(result.error).toBeUndefined();expect(result.status).toBe(tampered !== "none"?1:0);
 if(tampered !== "none"){expect(result.stderr).toContain("Restricted manual evidence operation failed");await expect(readFile(output)).rejects.toMatchObject({code:"ENOENT"});}
 else expect(await readFile(output,"utf8")).toContain("session_policy=");
});

it.each([8, 9, 10])("enrollment actual report session emits only eight fixed slots and rejects count %s before outputs", async count => {
 const root=await mkdtemp(path.join(os.tmpdir(),"synthetic-report-cardinality-"));roots.push(root);
 const ids=count === 8 ? MANUAL_PRIVATE_EXECUTIONS.slice(0,8) : MANUAL_PRIVATE_EXECUTIONS.slice(0,count);
 expect(ids).toHaveLength(count);
 const workflowSha="a".repeat(40),targetSha="b".repeat(40),output=path.join(root,"outputs.txt");
 const trusted=path.resolve(import.meta.dirname,"../.."),require=createRequire(import.meta.url),tsx=require.resolve("tsx",{paths:[path.join(trusted,"server")]});
 const result=spawnSync(process.execPath,["--import",tsx,path.join(import.meta.dirname,"manual-private-transfer.ts"),"report-session"],{
  encoding:"utf8",timeout:10000,env:{PATH:process.env.PATH,NODE_OPTIONS:"",NODE_PATH:"",MANUAL_PRIVATE_IDS:JSON.stringify(ids),
   MANUAL_PRIVATE_APPROVALS_JSON:JSON.stringify({version:1,approvals:[{workflowSha,targetSha,runId:"123",attempt:"1",executionIds:ids,protocol:MANUAL_PRIVATE_PROTOCOL,launchSha256:"c".repeat(64)}]}),
   GITHUB_SHA:workflowSha,TARGET_SHA:targetSha,GITHUB_RUN_ID:"123",GITHUB_RUN_ATTEMPT:"1",RUNNER_E2E_PRIVATE_HISTORY_S3_BUCKET:"private-bucket",GITHUB_OUTPUT:output}});
 expect(result.error).toBeUndefined();expect(result.status).toBe(count===8?0:1);
 if(count===8){
  const lines=(await readFile(output,"utf8")).trim().split("\n"),keys=lines.map(line=>line.split("=",1)[0]);
  expect(keys).toEqual(["session_policy","cell_count",...Array.from({length:8},(_,i)=>`read_policy_${i}`)]);
  expect(lines).toContain("cell_count=8");
  for(const line of lines.filter(line=>line.startsWith("read_policy_")))expect(JSON.stringify(JSON.parse(line.slice(line.indexOf("=")+1))).length).toBeLessThanOrEqual(2048);
 }else{
  expect(result.stderr).toContain("Restricted manual evidence operation failed");
  expect(result.stdout).toBe("");await expect(readFile(output)).rejects.toMatchObject({code:"ENOENT"});
  expect(await readdir(root)).toEqual([]);
 }
});
