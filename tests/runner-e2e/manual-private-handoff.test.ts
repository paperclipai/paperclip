import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readManualPrivateHandoff, sealStandardOriginalEvidence, preserveOriginalFrameworkResult, type ManualPrivateHandoff } from "./manual-private-handoff.js";
import { MANUAL_PRIVATE_EXECUTIONS, MANUAL_PRIVATE_PROTOCOL } from "./manual-private-retention.js";
import { inspectCellReportProducer } from "./manual-private-report-assets.js";
const roots: string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture() {
 const root=await mkdtemp(path.join(os.tmpdir(),"manual-private-handoff-test-"));roots.push(root);
 const source=path.join(root,"source"),out=path.join(root,"private");await mkdir(source,{mode:0o700});await mkdir(out,{mode:0o700});
 const context={root:out,protocol:MANUAL_PRIVATE_PROTOCOL,private:true,workflowSha:"a".repeat(40),targetSha:"b".repeat(40),runId:"123",attempt:"1",executionIds:[MANUAL_PRIVATE_EXECUTIONS[0]!]}as ManualPrivateHandoff;
 await mkdir(path.join(source,"snapshots"));await writeFile(path.join(source,"snapshots","state.json"),' { "legitimatePrivateContent": "Keep this exact original formatting" }\n');
 await writeFile(path.join(source,"failure.png"),Buffer.from([137,80,78,71,13,10,26,10]));
 return{root,source,out,context,input:{context,executionId:context.executionIds[0]!,source,evidence:{files:[],leaks:[],missing:[]},secrets:[]as string[],expectPassScreenshot:false}};
}
it("retains exact approved original bytes and hashes without expanding evidence scope",async()=>{
 const f=await fixture();await writeFile(path.join(f.source,"unapproved-home.json"),'not an evidence root');
 const receipt=await sealStandardOriginalEvidence(f.input);expect(receipt.complete).toBe(true);expect(receipt.files.map(r=>r.path)).toEqual(["failure.png","snapshots/state.json"]);
 const directory=path.join(f.out,"originals");const {readdir}=await import("node:fs/promises");const [cell]=await readdir(directory);
 expect(await readFile(path.join(directory,cell!,"snapshots/state.json"),"utf8")).toBe(await readFile(path.join(f.source,"snapshots/state.json"),"utf8"));
});
it("preserves the original framework result before later launcher rewrites",async()=>{
 const f=await fixture();await writeFile(path.join(f.source,"result.json"),' {"original":true}\n');await preserveOriginalFrameworkResult(f.source);await writeFile(path.join(f.source,"result.json"),'{"later":true}');
 expect(await readFile(path.join(f.source,"snapshots/manual-original-framework-result.json"),"utf8")).toBe(' {"original":true}\n');
});
it("a genuine credential match remains fatal and no contaminated original is sealed",async()=>{
 const f=await fixture();f.input.secrets=["synthetic-provider-credential-1234567890"];await writeFile(path.join(f.source,"snapshots/secret.json"),JSON.stringify({value:f.input.secrets[0]}));
 await expect(sealStandardOriginalEvidence(f.input)).rejects.toThrow(/privacy/);expect(JSON.parse(await readFile(path.join(f.out,"contamination.json"),"utf8"))).toMatchObject({complete:false,status:"withheld_credential_contamination"});
});
it("retains all safe available originals while required pass evidence remains explicitly incomplete",async()=>{
 const f=await fixture();f.input.expectPassScreenshot=true;const receipt=await sealStandardOriginalEvidence(f.input);
 expect(receipt.complete).toBe(true);expect(receipt.requiredEvidenceComplete).toBe(false);
 expect(receipt.missingRequiredEvidence).toContain("final-state.png");expect(receipt.missingRequiredEvidence).toContain("blob-report/*.zip");
 expect(receipt.files.map(row=>row.path)).toContain("failure.png");
});
it("does not copy an escaped or symlinked original",async()=>{
 const f=await fixture();await symlink(path.join(f.source,"snapshots/state.json"),path.join(f.source,"snapshots/link.json"));await expect(sealStandardOriginalEvidence(f.input)).rejects.toThrow(/unsupported/);
});
it("requires the complete preflight's exact attempt, owner-only file and target before selecting a private root",async()=>{
 const f=await fixture();const file=path.join(f.out,"preflight.json");await writeFile(file,JSON.stringify({...f.context,status:"verified",cellReportProducer:await inspectCellReportProducer()}),{mode:0o600});
 const env={GITHUB_SHA:f.context.workflowSha,RUNNER_TEMP:f.root,GITHUB_RUN_ID:"123",GITHUB_RUN_ATTEMPT:"1",PAPERCLIP_RUNNER_E2E_SOURCE_SHA:f.context.targetSha,PAPERCLIP_RUNNER_E2E_PRIVATE_PREFLIGHT:file};
 expect((await readManualPrivateHandoff(env,f.context.executionIds))?.root).toBe(await realpath(f.out));
 await expect(readManualPrivateHandoff({...env,GITHUB_RUN_ID:"124"},f.context.executionIds)).rejects.toThrow(/exact attempt/);
 await expect(readManualPrivateHandoff(env,[MANUAL_PRIVATE_EXECUTIONS[1]!])).rejects.toThrow(/exact attempt/);
});
it.each(["unknown.bin", "private.db"])("rejects unscanned %s under a standard directory without retaining it",async name=>{
 const f=await fixture();f.input.secrets=["synthetic-provider-credential-1234567890"];
 await writeFile(path.join(f.source,"snapshots",name),f.input.secrets[0]!);
 await expect(sealStandardOriginalEvidence(f.input)).rejects.toThrow(/Unsupported/);
});
it("an active SVG omitted by the existing package cannot be called a complete retained original",async()=>{
 const f=await fixture();await writeFile(path.join(f.source,"snapshots/active.svg"),'<svg xmlns="http://www.w3.org/2000/svg"><script>window.x=1</script></svg>');
 await expect(sealStandardOriginalEvidence(f.input)).rejects.toThrow(/Unsupported/);
});

it.each(["raw", "url", "base64", "shape"])("rejects %s credential-bearing original names rather than sanitizing a complete inventory", async kind => {
 const f=await fixture();const secret="synthetic-credential/+1234567890";f.input.secrets=[secret];
 const name=kind==="raw"?"synthetic-credential-1234567890":kind==="url"?encodeURIComponent(secret):kind==="base64"?Buffer.from(secret).toString("base64url"):"sk-proj-synthetic123456789012345";
 if(kind==="raw")f.input.secrets=[name];
 await writeFile(path.join(f.source,"snapshots",`${name}.json`),'{}');
 await expect(sealStandardOriginalEvidence(f.input)).rejects.toThrow(/Secret leak/);
});
it("retains original framework PASS and actual missing-evidence infrastructure FAIL as separate bytes",async()=>{
 const f=await fixture();await writeFile(path.join(f.source,"result.json"),'{"status":"passed"}');
 await preserveOriginalFrameworkResult(f.source);
 await writeFile(path.join(f.source,"result.json"),'{"status":"failed","failureClass":"permanent_infrastructure","error":"Required evidence missing: final-state.png"}');
 const receipt=await sealStandardOriginalEvidence({...f.input,expectPassScreenshot:true});
 expect(receipt.requiredEvidenceComplete).toBe(false);
 const {manualCellKind}=await import("./manual-private-retention.js"),dir=path.join(f.out,"originals",manualCellKind(f.input.executionId));
 expect(JSON.parse(await readFile(path.join(dir,"snapshots/manual-original-framework-result.json"),"utf8")).status).toBe("passed");
 expect(JSON.parse(await readFile(path.join(dir,"result.json"),"utf8"))).toMatchObject({status:"failed",failureClass:"permanent_infrastructure"});
});
