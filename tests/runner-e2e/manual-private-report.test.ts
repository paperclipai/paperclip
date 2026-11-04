import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MANUAL_PRIVATE_EXECUTIONS, MANUAL_PRIVATE_PROTOCOL } from "./manual-private-retention.js";
vi.mock("./private-history.js",async original=>({...await original<typeof import("./private-history.js")>(),retainPrivateTransfer:vi.fn().mockResolvedValue({private:true})}));
import { retainPrivateTransfer } from "./private-history.js";
import { stageDashboardBrandAssets } from "./report-assets.js";
import { uploadReport } from "./manual-private-transfer.js";
const roots:string[]=[];
afterEach(async()=>{vi.clearAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),"manual-report-scan-test-"));roots.push(root);const source=path.join(root,"report");await mkdir(source);
 const workflowSha="a".repeat(40),targetSha="b".repeat(40),id=MANUAL_PRIVATE_EXECUTIONS[0]!;
 await writeFile(path.join(root,"manual-report-input-completeness.json"),JSON.stringify({meaning:"available-files-and-transfer-only",doesNotAttestFeatureOutcome:true,cells:[{executionId:id,availableFileInventoryComplete:true,requiredPassEvidenceComplete:null,missingRequiredEvidence:[]}]}));
 const env={MANUAL_PRIVATE_IDS:JSON.stringify([id]),MANUAL_PRIVATE_APPROVALS_JSON:JSON.stringify({version:1,approvals:[{workflowSha,targetSha,runId:"123",attempt:"1",executionIds:[id],protocol:MANUAL_PRIVATE_PROTOCOL,launchSha256:"c".repeat(64)}]}),GITHUB_SHA:workflowSha,TARGET_SHA:targetSha,GITHUB_RUN_ID:"123",GITHUB_RUN_ATTEMPT:"1",RUNNER_E2E_PRIVATE_HISTORY_S3_BUCKET:"private-bucket",PRIVATE_REPORT_ROOT:root,PRIVATE_REPORT_SOURCE:source,AWS_ACCESS_KEY_ID:"synthetic-report-access-123456",AWS_SECRET_ACCESS_KEY:"synthetic-report-secret-123456",AWS_SESSION_TOKEN:"synthetic-report-session-123456"};
 return{root,source,env};
}
it.each(["root","encoded","shape","unsupported"])("rejects fresh %s report output before any archive upload",async kind=>{
 const f=await fixture();const value=kind==="root"?f.env.AWS_SESSION_TOKEN:kind==="encoded"?Buffer.from(f.env.AWS_SECRET_ACCESS_KEY).toString("base64"):kind==="shape"?"sk-proj-synthetic123456789012345":"opaque";
 await writeFile(path.join(f.source,kind==="unsupported"?"new.db":"report.log"),value);
 await expect(uploadReport(f.env)).rejects.toThrow();expect(retainPrivateTransfer).not.toHaveBeenCalled();
});
it("scans and seals genuine generated report bytes before transfer",async()=>{
 const f=await fixture();await writeFile(path.join(f.source,"report.log"),"The original feature failed; raw grade unchanged.\n");await uploadReport(f.env);
 expect(retainPrivateTransfer).toHaveBeenCalledOnce();const options=vi.mocked(retainPrivateTransfer).mock.calls[0]![0];
 expect(options.directory).not.toBe(f.source);expect(options.evidenceCompleteness).toMatchObject({doesNotAttestFeatureOutcome:true});
});

it("retains the actual brand asset producer tree",async()=>{
 const f=await fixture();await mkdir(path.join(f.source,"normalized"));await stageDashboardBrandAssets(path.join(f.source,"normalized"));
 await mkdir(path.join(f.source,"html"));await writeFile(path.join(f.source,"html/index.html"),"<!doctype html><title>Synthetic report metadata</title>");
 await uploadReport(f.env);expect(retainPrivateTransfer).toHaveBeenCalledOnce();
});
