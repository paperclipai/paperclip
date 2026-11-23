import { mkdtemp, mkdir, truncate, writeFile, readFile, rm, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { packageEvidence } from "./evidence.js";
import { inspectCellReportProducer, privateCellEvidenceOwner } from "./manual-private-report-assets.js";
import { appendPrivateAttemptDiagnostic, privateAttemptDiagnostic } from "./private-attempt-diagnostic.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
async function fixture() {
 const root=await mkdtemp(path.join(await realpath(os.tmpdir()),"closed-budget-"));roots.push(root);
 const cell=path.join(root,"capture/cases/activity.agent-feedback");await mkdir(cell,{recursive:true});
 const id="chat-features.runner-opencode.local.activity.agent-feedback";
 const owner=await privateCellEvidenceOwner({root,private:true,runId:"123",attempt:"1",executionIds:[id],cellReportProducer:await inspectCellReportProducer()},id);
 return {root,cell,input:{privateDir:cell,uploadDir:path.join(root,"upload"),secrets:[],expectPassScreenshot:true,privateCell:{owner,layout:"original" as const}}};
}
it("a real sparse oversized source still rejects, but its closed byte witness survives the existing runner diagnostic path",async()=>{
 const f=await fixture();const source=path.join(f.cell,"result.json");await writeFile(source,"");await truncate(source,256*1024*1024+1);
 const error=await packageEvidence(f.input).then(()=>null,error=>error);expect(error?.message).toBe("Private cell evidence exceeds byte allowance");
 const d=privateAttemptDiagnostic({stage:"package-original",result:{status:"passed"},error});
 expect(d).toMatchObject({finalization:"byte-bound",packagingBudget:{bound:"physical-bytes",inventoryComplete:false,scanFinished:false,requiredEvidenceComplete:null,qualification:"unqualified",filesExamined:1,bytesExamined:268435457,byKind:{json:{files:1,bytes:268435457}}}});
 const commands=path.join(f.root,"_runner_file_commands");await mkdir(commands);const envFile=path.join(commands,"set_env_budget");await writeFile(envFile,"");
 await appendPrivateAttemptDiagnostic({stage:"package-original",result:{status:"passed"},error},{GITHUB_ACTIONS:"true",RUNNER_TEMP:f.root,GITHUB_ENV:envFile});
 const wire=await readFile(envFile,"utf8");expect(wire).toContain('"bound":"physical-bytes"');expect(wire).not.toContain(source);expect(wire).not.toContain("closed-budget-");expect(wire.trim().split("\n")).toHaveLength(1);
});

it("retains the real ZIP expansion scanner and reports its distinct bound with incomplete required evidence",async()=>{
 const f=await fixture();const dir=path.join(f.cell,"blob-report");await mkdir(dir);const zip=path.join(dir,"oversized.zip");
 execFileSync("python3",["-c","import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED); f=z.open('synthetic.txt','w'); block=b'0'*1048576; [f.write(block) for _ in range(257)]; f.close(); z.close()",zip],{stdio:"pipe",timeout:30000});
 const evidence=await packageEvidence(f.input);
 expect(evidence.leaks).toMatchObject([{reason:"zip inspection exceeded its expanded-byte bound"}]);
 expect(privateAttemptDiagnostic({stage:"seal-original",evidence})).toMatchObject({carrierReasons:[{source:"packaging",carrier:"blob-zip",reason:"zip inspection exceeded its expanded-byte bound",count:1}],packagingBudget:{bound:"zip-expanded-bytes",inventoryComplete:true,scanFinished:true,requiredEvidenceComplete:false,qualification:"unqualified"}});
 expect(evidence.files).not.toContain("blob-report/oversized.zip");
});
it("a completed small scan reports exact closed metadata but cannot qualify an outcome without required carriers",async()=>{
 const f=await fixture();await writeFile(path.join(f.cell,"result.json"),'{"status":"passed"}');await writeFile(path.join(f.cell,"server.log"),"synthetic");
 const evidence=await packageEvidence(f.input);const d=privateAttemptDiagnostic({stage:"seal-original",result:{status:"passed"},evidence});
 expect(d).toMatchObject({status:"passed",packagingBudget:{bound:"none",filesExamined:2,bytesExamined:28,inventoryComplete:true,scanFinished:true,requiredEvidenceComplete:false,qualification:"unqualified",byKind:{json:{files:1,bytes:19},log:{files:1,bytes:9}}}});
 expect(evidence.missing).toContain("final-state.png");
});
it("unknown names/strings are discarded and malformed or contradictory counters never escape",()=>{
 const clean={bound:"none",listedFiles:0,filesExamined:0,bytesExamined:0,inventoryComplete:true,scanFinished:true,requiredEvidenceComplete:null,byKind:Object.fromEntries(["json","log","image","video","zip","html","text","asset"].map(k=>[k,{files:0,bytes:0}]))};
 for(const mutate of [(b:any)=>{b.bytesExamined=-1;},(b:any)=>{b.listedFiles=4098;},(b:any)=>{b.filesExamined=0.5;},(b:any)=>{b.byKind.json.bytes=1;},(b:any)=>{delete b.byKind.log;},(b:any)=>{b.inventoryComplete=false;b.requiredEvidenceComplete=true;}]){
  const budget=structuredClone(clean);mutate(budget);expect(privateAttemptDiagnostic({stage:"package-original",evidence:{budget}})).toMatchObject({packagingBudget:null});
 }
 const raw={...clean,bound:"private-secret-value",path:"private-secret-value",sessionId:"private-secret-value",byKind:{...clean.byKind,"private-secret-value":{files:1,bytes:1}}};
 const d=privateAttemptDiagnostic({stage:"package-original",evidence:{budget:raw}});expect(d).toMatchObject({packagingBudget:{bound:"unknown",qualification:"unqualified"}});expect(JSON.stringify(d)).not.toContain("private-secret-value");
});
it("sealer failure names its own limit without pretending package counters measure a completed original seal",()=>{
 const budget={bound:"none",listedFiles:0,filesExamined:0,bytesExamined:0,inventoryComplete:true,scanFinished:true,requiredEvidenceComplete:true,byKind:Object.fromEntries(["json","log","image","video","zip","html","text","asset"].map(k=>[k,{files:0,bytes:0}]))};
 expect(privateAttemptDiagnostic({stage:"seal-original",evidence:{budget},error:new Error("Complete original evidence exceeds byte allowance")})).toMatchObject({packagingBudget:{scope:"package-standard-files",bound:"original-seal-bytes",qualification:"unqualified"}});
});

it("entry excess still rejects before file reads and emits only a bounded incomplete counter",async()=>{
 const f=await fixture();const dir=path.join(f.cell,"snapshots");await mkdir(dir);
 for(let n=0;n<4097;n+=64)await Promise.all(Array.from({length:Math.min(64,4097-n)},(_,i)=>writeFile(path.join(dir,`synthetic-${n+i}.json`),"{}")));
 const error=await packageEvidence(f.input).then(()=>null,error=>error);expect(error?.message).toBe("Private cell evidence exceeds entry allowance");
 expect(privateAttemptDiagnostic({stage:"package-original",error})).toMatchObject({packagingBudget:{bound:"entries",listedFiles:4097,filesExamined:0,bytesExamined:0,inventoryComplete:false,qualification:"unqualified"}});
});
it("diagnostic counters cannot rescue a secret-bearing file or admit a symlink",async()=>{
 const f=await fixture();await writeFile(path.join(f.cell,"server.log"),"synthetic-private-value");
 const result=await packageEvidence({...f.input,secrets:["synthetic-private-value"]});expect(result.leaks.length).toBeGreaterThan(0);
 expect(privateAttemptDiagnostic({stage:"package-original",evidence:result})).toMatchObject({packagingBudget:{requiredEvidenceComplete:false,qualification:"unqualified"}});
 expect(JSON.stringify(privateAttemptDiagnostic({stage:"package-original",evidence:result}))).not.toContain("synthetic-private-value");
 await rm(path.join(f.cell,"server.log"));await symlink(path.join(f.root,"outside"),path.join(f.cell,"server.log"));
 const linked=await packageEvidence(f.input);expect(linked.files).not.toContain("server.log");expect(linked.missing).toContain("final-state.png");
});
