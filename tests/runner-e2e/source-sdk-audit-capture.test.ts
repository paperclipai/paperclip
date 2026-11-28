import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { copyPreparedSourceSdkAudit, retainPreparedSourceSdk } from "./source-sdk-evidence.js";
import { copySharedEvidence } from "./shared-evidence.js";
import { inspectCellReportProducer } from "./manual-private-report-assets.js";
import { stagePrivateDiagnostics } from "./private-diagnostics.js";
const roots:string[]=[],id="chat-features.runner-opencode.local.plugins.configure-plugin",scenario="plugins.configure-plugin";
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const hash=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex");
async function fixture(){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"sdk-audit-capture-")));roots.push(root);
 const temp=path.join(root,"attempt"),repo=path.join(root,"repo"),handoff=path.join(root,"handoff"),capture=path.join(handoff,"capture"),cell=path.join(capture,"cases",scenario);
 await mkdir(temp,{mode:0o700});await mkdir(handoff,{mode:0o700});await mkdir(cell,{recursive:true,mode:0o700});
 await mkdir(path.join(temp,"selected-private-inputs"),{mode:0o700});
 const secret="synthetic-private-sdk-canary-value";stagePrivateDiagnostics(temp,[id],[secret]);
 for(const directory of ["packages/shared/dist","packages/plugins/sdk/dist"]){
  const dir=path.join(repo,directory);await mkdir(dir,{recursive:true});const body=Buffer.from(secret);
  await writeFile(path.join(dir,"index.js"),body);const outputs=createHash("sha256").update(JSON.stringify(["index.js",body.length])).update(body).digest("hex");
  await writeFile(path.join(dir,".paperclip-build-complete"),JSON.stringify({sources:"a".repeat(64),outputs}));
 }
 const context={root:handoff,private:true as const,runId:"123",attempt:"1",executionIds:[id],cellReportProducer:await inspectCellReportProducer()};
 const source=path.join(temp,"artifacts-private/cases",scenario,"snapshots/source-sdk-privacy-observations.json"),destination=path.join(cell,"snapshots/source-sdk-privacy-observations.json");
 const reject=()=>retainPreparedSourceSdk({repositoryRoot:repo,temporaryRoot:temp,executionIds:[id],sourceRevision:"a".repeat(40),installed:false});
 const copy=()=>copySharedEvidence(capture,cell,temp,[secret],{executionId:id,context});
 return {root,temp,repo,handoff,capture,cell,context,source,destination,secret,reject,copy};
}
it("actual SDK privacy rejection keeps its existing typed audit in the external private bootstrap-failure capture",async()=>{
 const f=await fixture();await expect(f.reject()).rejects.toThrow("Source SDK evidence privacy check failed; bytes withheld");
 const bytes=await readFile(f.source);expect(JSON.parse(bytes.toString())).toMatchObject({complete:false,audit:{observations:expect.arrayContaining([expect.objectContaining({classification:"private_exact"})])}});
 await f.copy();expect(await readFile(f.destination)).toEqual(bytes);expect((await stat(f.destination)).mode&0o777).toBe(0o600);
 expect((await readFile(f.destination,"utf8"))).not.toContain(f.secret);await expect(stat(path.join(f.cell,"source-sdk-build"))).rejects.toThrow();
});

it.each(["symlink file","foreign capture","wrong execution","wrong producer","private canary","unknown shape","oversize audit"])("rejects %s before any external audit write",async fault=>{
 const f=await fixture();await expect(f.reject()).rejects.toThrow("Source SDK evidence privacy check failed");
 let cell=f.cell,input={executionId:id,context:f.context};
 if(fault==="symlink file"){const outside=path.join(f.root,"outside.json");await writeFile(outside,await readFile(f.source));await rm(f.source);await symlink(outside,f.source);}
 if(fault==="foreign capture"){cell=path.join(f.root,"foreign");await mkdir(cell);}
 if(fault==="wrong execution")input={...input,context:{...f.context,executionIds:["chat-features.runner-opencode.local.plugins.disable-plugin"]}};
 if(fault==="wrong producer")input={...input,context:{...f.context,cellReportProducer:{...f.context.cellReportProducer,staticManifestSha256:"0".repeat(64)}}};
 if(fault==="private canary"){const audit=JSON.parse(await readFile(f.source,"utf8"));audit.private=f.secret;await writeFile(f.source,JSON.stringify(audit));}
 if(fault==="unknown shape"){const audit=JSON.parse(await readFile(f.source,"utf8"));audit.path="private-unapproved-path";await writeFile(f.source,JSON.stringify(audit));}
 if(fault==="oversize audit")await writeFile(f.source,Buffer.alloc(1024*1024+1));
 await expect(copyPreparedSourceSdkAudit(f.temp,cell,[f.secret],input)).rejects.toThrow();
 await expect(stat(f.destination)).rejects.toThrow();
});
it("keeps the captured audit immutable and leaves non-SDK/missing-audit paths unchanged",async()=>{
 const f=await fixture();await f.copy();await expect(stat(f.destination)).rejects.toThrow();
 await expect(copyPreparedSourceSdkAudit(f.temp,f.cell,[],{executionId:"chat-features.runner-opencode.local.tasks.ambiguous-task",context:f.context})).resolves.toBeUndefined();
 await expect(f.reject()).rejects.toThrow("Source SDK evidence privacy check failed");await f.copy();const original=await readFile(f.destination);
 await expect(f.copy()).rejects.toThrow();expect(await readFile(f.destination)).toEqual(original);
});

it("rejects a malformed present framework report instead of hiding it as a missing setup report",async()=>{
 const f=await fixture();await writeFile(path.join(f.capture,"framework-report.json"),"{");
 await expect(f.copy()).rejects.toThrow();
});
