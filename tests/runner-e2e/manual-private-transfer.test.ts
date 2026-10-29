import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { validateSealedInventory } from "./manual-private-transfer.js";
import { sealManualResultEvidence, type ManualPrivateHandoff } from "./manual-private-handoff.js";
import { MANUAL_PRIVATE_PROTOCOL } from "./manual-private-retention.js";
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

it.each([false, true])("actual prepare checks new report dependency before credentials (tampered=%s)", async tampered => {
 const root=await mkdtemp(path.join(os.tmpdir(),"synthetic-prepare-dependency-"));roots.push(root);
 const target=path.join(root,"target"),modules=path.join(target,"tests/runner-e2e");await mkdir(modules,{recursive:true});
 const trusted=path.resolve(import.meta.dirname,"../.."),launch=Buffer.from("synthetic approved launcher; never executed");await writeFile(path.join(modules,"launch.ts"),launch);
 for(const name of ["manual-private-handoff.ts","manual-private-retention.ts","manual-private-report-assets.ts"])await copyFile(path.join(import.meta.dirname,name),path.join(modules,name));
 if(tampered)await writeFile(path.join(modules,"manual-private-report-assets.ts"),"synthetic incompatible dependency; never executed");
 const workflowSha="a".repeat(40),targetSha="b".repeat(40),id="chat-features.runner-opencode.local.activity.agent-feedback",output=path.join(root,"outputs.txt");
 const require=createRequire(import.meta.url),tsx=require.resolve("tsx",{paths:[path.join(trusted,"server")]});
 const result=spawnSync(process.execPath,["--import",tsx,path.join(import.meta.dirname,"manual-private-transfer.ts"),"prepare"],{encoding:"utf8",timeout:10000,env:{PATH:process.env.PATH,NODE_OPTIONS:"",NODE_PATH:"",SELECTED_EXECUTION_ID:id,MANUAL_PRIVATE_IDS:JSON.stringify([id]),MANUAL_PRIVATE_APPROVALS_JSON:JSON.stringify({version:1,approvals:[{workflowSha,targetSha,runId:"123",attempt:"1",executionIds:[id],protocol:MANUAL_PRIVATE_PROTOCOL,launchSha256:createHash("sha256").update(launch).digest("hex")}]}),GITHUB_SHA:workflowSha,TARGET_SHA:targetSha,GITHUB_RUN_ID:"123",GITHUB_RUN_ATTEMPT:"1",RUNNER_E2E_PRIVATE_HISTORY_S3_BUCKET:"private-bucket",TARGET_ROOT:target,RUNNER_TEMP:root,GITHUB_OUTPUT:output}});
 expect(result.error).toBeUndefined();expect(result.status).toBe(tampered?1:0);
 if(tampered){expect(result.stderr).toContain("Restricted manual evidence operation failed");await expect(readFile(output)).rejects.toMatchObject({code:"ENOENT"});}
 else expect(await readFile(output,"utf8")).toContain("session_policy=");
});
