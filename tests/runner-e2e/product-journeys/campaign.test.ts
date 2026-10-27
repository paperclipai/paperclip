import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createConnectionProof } from "../connection-evidence.js";
import { retainOnboardingArtifact, validateOnboardingArtifact } from "./artifact-evidence.js";
const persistenceFault = vi.hoisted(() => ({ kind: null as "write" | "rename" | null, active: false, latestReport: null as any }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual,
    async writeFile(...args: Parameters<typeof actual.writeFile>) {
      if (String(args[0]).endsWith("/normalized-results.tmp")) {
        persistenceFault.latestReport = JSON.parse(String(args[1]));
        if (persistenceFault.active && persistenceFault.kind === "write") throw Error("private disk diagnostic api_key_fixture");
      }
      return actual.writeFile(...args);
    },
    async rename(...args: Parameters<typeof actual.rename>) {
      if (String(args[1]).endsWith("/normalized-results.json") && persistenceFault.active && persistenceFault.kind === "rename") throw Error("private rename diagnostic api_key_fixture");
      return actual.rename(...args);
    },
  };
});
vi.mock("@playwright/test", () => ({ chromium: { launch: async () => ({ newContext: async () => ({setDefaultTimeout(){}, pages:()=>[]}), close:async()=>{} }) }, expect: {} }));
vi.mock("../dashboard-regenerate.js", () => ({ regenerateRunnerDashboard: vi.fn(async (input:{outputDirectory?:string}) => {
  if(input.outputDirectory){const {writeFile}=await import("node:fs/promises");await Promise.all(["index.html","dashboard.html"].map(name=>writeFile(path.join(input.outputDirectory!,name),"dashboard")));}
}) }));
vi.mock("./task-properties.js", () => ({taskProperties: async (_context:unknown,_session:unknown,_id:unknown,evidence:any) => {evidence.checks.push({id:"assignment-persisted",passed:true},{id:"no-agent-work",passed:true});}}));
import { chromium } from "@playwright/test";
import { launchProductJourneys } from "./launch.js";
import { regenerateRunnerDashboard } from "../dashboard-regenerate.js";
const roots: string[]=[];
afterEach(async()=>{vi.useRealTimers(); vi.restoreAllMocks(); persistenceFault.kind=null; persistenceFault.active=false; persistenceFault.latestReport=null; process.exitCode=0; await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
type Hook = "collect" | "release" | "stop" | "finalizeEvidence" | "checkpointEvidence";
async function run(options:{authFailure?:boolean;onboardingFailure?:boolean;missingArtifact?:boolean;drift?:boolean;cleanupFailure?:boolean;collectionFailure?:boolean;mini?:boolean;missingReceipt?:boolean;zeroRequests?:boolean;missingCheck?:boolean;finalizationFailure?:boolean;persistenceFailure?:"write"|"rename";persistenceAfter?:"collection"|"release";stallHook?:Hook;onHook?:(hook:Hook,signal?:AbortSignal)=>void}={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),"journey-campaign-test-")); roots.push(root);
  const module=path.join(root,"provider.mjs");
  const proof = createConnectionProof();
  const artifact = retainOnboardingArtifact({ id: "artifact-1", originatingRunId: "run-1", bytes: Buffer.from(`${JSON.stringify(proof.expected, null, 2)}\n`), proof });
  await writeFile(module, `import {readFile,writeFile} from 'node:fs/promises';
const identity={kind:'cloud',targetId:'qa',origin:'https://qa.example.test',commit:'${"a".repeat(40)}',cloudRelease:'v1',runtimeImage:'image',configurationHash:'config'};
let onboarded=false;
const context={identity,company:{id:'company-1',issuePrefix:'QA'},api:{post:async()=>({id:'issue-fixture-1',identifier:'QA-1'})},startingState:'onboarding',capabilities:['company','board-user','task-write'],page:{async screenshot(){} }};
export const provider={version:1, async acquire(input){return {
async authenticate(){${options.authFailure ? "throw {outcome:'failed',code:'login_code_expired'};" : ""}},
async onboard(evidence){${options.onboardingFailure ? "throw {outcome:'failed',code:'onboarding_failed'};" : `${options.missingArtifact ? "" : `evidence.artifact=${JSON.stringify(artifact)};`}evidence.checks.push(...['fresh-workspace','ui-connection-and-native-agent','first-task-complete','downloadable-artifact-verified'${options.missingCheck ? "" : ",'native-trace-verified'"}].map(id=>({id,passed:true})));onboarded=true;return context;`}},
async prepare(){throw Error('onboarding receipt was not reused')},
async identity(){return {...identity,commit:'${(options.drift?"b":"a").repeat(40)}'}},
async collect(){${options.collectionFailure ? "throw Error('private collection error');" : options.missingReceipt ? "return [];" : `return onboarded?[{journeyId:'cloud-onboarding',runIds:['run-1'],usage:{runs:[{runId:'run-1',usage:{costUsd:0.01}}]},operations:{campaignId:input.campaignId,attemptId:input.campaignId+':cloud-onboarding:1',modelCostUsd:0.01,setupCostUsd:0.005,requestCount:${options.zeroRequests ? 0 : 2},feedback:{collection:'complete',complaints:0,suggestions:0},traceIds:['a'.repeat(32)]}}]:[];`}}, async own(){}, async release(){${options.cleanupFailure ? "throw Error('private raw error');" : "return 'released';"}}, async stop(){}
, async finalizeEvidence(){
const report=JSON.parse(await readFile(input.outputDir+'/normalized-results.json','utf8'));
if(report.results.some(r=>r.cleanup==='not_started'))throw Error('final evidence preceded cleanup');
${options.finalizationFailure ? "throw Error('private evidence upload diagnostic');" : ""}
}, async checkpointEvidence(){
const report=JSON.parse(await readFile(input.outputDir+'/normalized-results.json','utf8'));
if(report.results.some(r=>r.cleanup!=='failed'))throw Error('failure checkpoint preceded failure persistence');
await writeFile(input.outputDir+'/failure-checkpoint.json',JSON.stringify(report));
}}}};`);
  const config={version:1,id:"qa",mode:"new-cloud",adapterModule:module,journeys:["cloud-onboarding","task-properties"],executionEnvironment:"daytona",baseline:{features:{},connections:[]},limits:{durationMs:60000,modelBudgetCents:1000,maxRuns:1},...(options.mini?{modelProfileId:"runner-codex-mini"}:{})};
  const file=path.join(root,"target.json"),output=path.join(root,"report"); await writeFile(file,JSON.stringify(config));
  const lifecycle: string[] = [];
  let artifactBeforeRelease: unknown;
  {
    persistenceFault.kind=options.persistenceFailure ?? null;
    const { provider } = await import(pathToFileURL(module).href);
    const acquire = provider.acquire;
    vi.spyOn(provider,"acquire").mockImplementation(async (...args: unknown[]) => {
      const session = await acquire(...args);
      return { ...session,
        async collect(input?: {signal:AbortSignal}) { options.onHook?.("collect",input?.signal); if(options.stallHook==="collect")await new Promise(()=>{}); try { return await session.collect(); } finally { if (options.persistenceAfter !== "release" && options.persistenceFailure) persistenceFault.active=true; } },
        async release(outcome: string,input?: {signal:AbortSignal}) { lifecycle.push(`release:${outcome}`); artifactBeforeRelease=JSON.parse(await readFile(path.join(output,"normalized-results.json"),"utf8")).results[0].productJourney.artifact; options.onHook?.("release",input?.signal); if(options.stallHook==="release")await new Promise(()=>{}); try { return await session.release(outcome); } finally { if (options.persistenceAfter === "release" && options.persistenceFailure) persistenceFault.active=true; } },
        async stop(input?: {signal:AbortSignal}) { lifecycle.push("stop"); options.onHook?.("stop",input?.signal); if(options.stallHook==="stop")await new Promise(()=>{}); },
        async finalizeEvidence(input?: {signal:AbortSignal}) { lifecycle.push("finalizeEvidence"); options.onHook?.("finalizeEvidence",input?.signal); if(options.stallHook==="finalizeEvidence")await new Promise(()=>{}); return session.finalizeEvidence(); },
        async checkpointEvidence(input?: {signal:AbortSignal}) { lifecycle.push("checkpointEvidence"); options.onHook?.("checkpointEvidence",input?.signal); if(options.stallHook==="checkpointEvidence")await new Promise(()=>{}); return session.checkpointEvidence(); },
      };
    });
  }
  await launchProductJourneys(["--target-config",file,"--output",output],path.resolve(import.meta.dirname,"../../.."));
  return { ...JSON.parse(await readFile(path.join(output,"normalized-results.json"),"utf8")),
    lifecycle, outputDir:output, attemptedReport: persistenceFault.latestReport, artifactBeforeRelease, expectedArtifact:artifact,
    failureCheckpoint: await readFile(path.join(output,"failure-checkpoint.json"),"utf8").then(JSON.parse).catch(()=>null) };
}
describe("product journey campaign boundary outcomes",()=>{
  it("accepts the conventional pnpm separator in a credential-free preview", async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),"journey-preview-test-")); roots.push(root);
    const file=path.join(root,"target.json");
    await writeFile(file,JSON.stringify({version:1,id:"qa",mode:"existing-cloud",adapterModule:"/not-installed-private-provider.mjs",adapterConfig:{operatorSecret:"never-print"},journeys:["task-properties"],executionEnvironment:"daytona",baseline:{features:{},connections:[]},limits:{durationMs:60000,modelBudgetCents:0,maxRuns:0}}));
    const output=vi.spyOn(console,"log").mockImplementation(()=>{});
    const launch=vi.spyOn(chromium,"launch");
    await launchProductJourneys(["--","--target-config",file,"--preview"],path.resolve(import.meta.dirname,"../../.."));
    const preview=JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(preview).toMatchObject({modelProfileId:null,retries:0,limits:{modelBudgetCents:0,maxRuns:0}});
    expect(JSON.stringify(preview)).not.toContain("never-print"); expect(launch).not.toHaveBeenCalled();
  });
  it("retains browser startup failure and every selected dependent result", async () => {
    vi.spyOn(chromium, "launch").mockRejectedValueOnce(new Error("private startup detail"));
    const campaign = await run();
    expect(campaign.results.map((r:any)=>r.productJourney.outcome)).toEqual(["failed", "blocked"]);
    expect(JSON.stringify(campaign)).not.toContain("private startup detail");
  });
  it("preserves failed auth and reports every dependent journey blocked",async()=>{
    const campaign=await run({authFailure:true});
    expect(campaign.results.map((r:any)=>r.productJourney.outcome)).toEqual(["failed","blocked"]);
    expect(campaign.results[0].productJourney.phases[0]).toEqual({phase:"authentication",outcome:"failed",code:"login_code_expired"});
  });
  it("does not turn onboarding failure into preconfigured-state success",async()=>{
    const campaign=await run({onboardingFailure:true});
    expect(campaign.results.map((r:any)=>r.productJourney.outcome)).toEqual(["failed","blocked"]);
    expect(campaign.results[0].productJourney.phases.find((p:any)=>p.phase==="journey").outcome).toBe("failed");
  });
  it("reuses a verified onboarding context for the same shared story",async()=>{
    const campaign=await run();
    expect(campaign.results.map((r:any)=>r.status)).toEqual(["passed","passed"]);
    expect(campaign.results.map((r:any)=>r.productJourney.startingState)).toEqual(["onboarding","onboarding"]);
    expect(campaign.results[1]).toMatchObject({provider:null,model:null,runtimeMode:"none"});
  });
  it("writes exact artifact bytes and independent expectations before disposable cleanup", async () => {
    const campaign = await run();
    const retained = campaign.results[0].productJourney.artifact;
    expect(campaign.artifactBeforeRelease).toEqual(campaign.expectedArtifact);
    expect(retained).toEqual(campaign.expectedArtifact);
    expect(() => validateOnboardingArtifact(retained)).not.toThrow();
    expect(Buffer.from(retained.contentBase64, "base64").toString("utf8")).toBe(`${JSON.stringify(retained.expected, null, 2)}\n`);
    expect(campaign.results[1].productJourney.artifact).toBeUndefined();
    expect(campaign.lifecycle[0]).toBe("release:passed");
  });
  it("fails new onboarding and blocks reuse when its artifact evidence was discarded", async () => {
    const campaign = await run({ missingArtifact: true });
    expect(campaign.results[0].error).toBe("onboarding_artifact_evidence_missing");
    expect(campaign.results.map((result:any) => result.productJourney.outcome)).toEqual(["failed", "blocked"]);
    expect(campaign.lifecycle[0]).toBe("release:failed");
  });
  it("fails deployment drift and blocks descendants",async()=>{
    const campaign=await run({drift:true});
    expect(campaign.results[0].error).toBe("deployment_changed_during_journey");
    expect(campaign.results[1].productJourney.outcome).toBe("blocked");
  });
  it("keeps cleanup failures visible without copying raw errors",async()=>{
    const campaign=await run({cleanupFailure:true});
    expect(campaign.results.every((r:any)=>r.cleanup==="failed"&&r.status==="failed")).toBe(true);
    expect(JSON.stringify(campaign)).not.toContain("private raw error");
  });
  it("preserves failed authentication and blocked dependents when finalization also fails",async()=>{
    const campaign=await run({authFailure:true,collectionFailure:true,cleanupFailure:true});
    expect(campaign.results.map((r:any)=>r.productJourney.outcome)).toEqual(["failed","blocked"]);
    expect(campaign.results.every((r:any)=>r.status==="failed"&&r.cleanup==="failed")).toBe(true);
    expect(campaign.results[1].productJourney.phases).toContainEqual({phase:"collection",outcome:"failed",code:"evidence_collection_failed"});
  });
  it("fails paid success when its provider silently omits accounting evidence",async()=>{
    const campaign=await run({missingReceipt:true});
    expect(campaign.results[0].status).toBe("failed");
    expect(campaign.results[0].error).toBe("paid_journey_receipt_missing");
    expect(campaign.results[0].productJourney.phases).toContainEqual({phase:"collection",outcome:"failed",code:"paid_journey_receipt_missing"});
  });
  it.each(["zeroRequests","missingCheck"] as const)("retains disposable resources when success evidence has %s",async field=>{
    const campaign=await run({[field]:true});
    expect(campaign.results.every((r:any)=>r.status==="failed")).toBe(true);
    expect(campaign.lifecycle[0]).toBe("release:failed");
    expect(campaign.results[0].runIds).toEqual(["run-1"]);
    expect(campaign.results[0].productJourney.operations.modelCostUsd).toBe(0.01);
    expect(campaign.results[0].productJourney.phases).toContainEqual({phase:"collection",outcome:"failed",code:"evidence_collection_failed"});
  });
  it.each(["collect","release","stop","finalizeEvidence","checkpointEvidence"] as const)("bounds a stalled %s hook and still closes the browser",async hook=>{
    vi.useFakeTimers();
    const close=vi.fn(async()=>{});
    vi.spyOn(chromium,"launch").mockResolvedValueOnce({newContext:async()=>({setDefaultTimeout(){},pages:()=>[]}),close} as any);
    let notify!:()=>void;
    const entered=new Promise<void>(resolve=>{notify=resolve;});
    let signal:AbortSignal|undefined;
    const pending=run({stallHook:hook,...(hook==="checkpointEvidence"?{finalizationFailure:true}:{}),...(hook==="stop"?{cleanupFailure:true}:{}),onHook(name,input){if(name===hook){signal=input;notify();}}});
    await entered;
    await vi.advanceTimersByTimeAsync(hook==="collect"?60_000:600_000);
    const campaign=await pending;
    expect(signal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(campaign.results.every((r:any)=>r.status==="failed")).toBe(true);
    if(hook==="collect")expect(campaign.lifecycle[0]).toBe("release:failed");
    if(hook==="release"){
      expect(campaign.lifecycle).toContain("stop");
      expect(campaign.lifecycle).not.toContain("finalizeEvidence");
      expect(campaign.results.every((r:any)=>r.cleanup==="failed"&&r.productJourney.resourceDisposition==="cleanup-failed")).toBe(true);
    }
  });
  it("bounds a stalled browser close without skipping final evidence",async()=>{
    vi.useFakeTimers();
    let notify!:()=>void;
    const entered=new Promise<void>(resolve=>{notify=resolve;});
    const close=vi.fn(async()=>{notify();await new Promise(()=>{});});
    vi.spyOn(chromium,"launch").mockResolvedValueOnce({newContext:async()=>({setDefaultTimeout(){},pages:()=>[]}),close} as any);
    const pending=run();
    await entered;
    await vi.advanceTimersByTimeAsync(10_000);
    const campaign=await pending;
    expect(close).toHaveBeenCalledOnce();
    expect(campaign.results.every((r:any)=>r.cleanup==="failed")).toBe(true);
    expect(campaign.results[0].productJourney.phases).toContainEqual({phase:"cleanup",outcome:"failed",code:"browser_cleanup_timeout"});
    expect(campaign.lifecycle).toContain("finalizeEvidence");
  });
  it("rejects a hook that finishes past its deadline before the timeout callback runs",async()=>{
    vi.useFakeTimers();
    let signal:AbortSignal|undefined;
    const campaign=await run({onHook(hook,input){if(hook==="collect"){signal=input;vi.setSystemTime(Date.now()+60_000);}}});
    expect(signal?.aborted).toBe(true);
    expect(campaign.lifecycle[0]).toBe("release:failed");
    expect(campaign.results[0].productJourney.phases).toContainEqual({phase:"collection",outcome:"failed",code:"evidence_collection_timeout"});
  });
  it("keeps a timed-out renderer's late writes away from retained failure results",async()=>{
    vi.useFakeTimers();
    let entered!:()=>void,release!:()=>void,finished!:()=>void;
    const rendering=new Promise<void>(resolve=>{entered=resolve;});
    const continueRendering=new Promise<void>(resolve=>{release=resolve;});
    const lateWrite=new Promise<void>(resolve=>{finished=resolve;});
    vi.mocked(regenerateRunnerDashboard).mockImplementationOnce(async input=>{
      const earlier=await readFile(path.join(input.bundle,"normalized-results.json"),"utf8");
      entered();
      await continueRendering;
      await writeFile(path.join(input.outputDirectory??input.bundle,"normalized-results.json"),earlier);
      finished();
    });
    const pending=run({onHook(hook){if(hook==="release")vi.advanceTimersByTime(569_000);}});
    await rendering;
    await vi.advanceTimersByTimeAsync(1_000);
    const campaign=await pending;
    expect(campaign.results.every((r:any)=>r.status==="failed")).toBe(true);
    release();
    await lateWrite;
    const retained=JSON.parse(await readFile(path.join(campaign.outputDir,"normalized-results.json"),"utf8"));
    expect(retained.results.every((r:any)=>r.status==="failed")).toBe(true);
    expect(retained.results[0].productJourney.phases).toContainEqual({phase:"cleanup",outcome:"failed",code:"report_generation_failed"});
    expect(campaign.lifecycle).not.toContain("finalizeEvidence");
  });
  it("retains an evidence-finalization failure after the cleanup report was written",async()=>{
    const campaign=await run({finalizationFailure:true});
    expect(campaign.results.every((r:any)=>r.status==="failed"&&r.cleanup==="failed")).toBe(true);
    expect(campaign.results[0].productJourney.phases).toContainEqual({phase:"cleanup",outcome:"failed",code:"evidence_finalization_failed"});
    expect(campaign.failureCheckpoint.results.every((r:any)=>r.cleanup==="failed")).toBe(true);
    expect(JSON.stringify(campaign)).not.toContain("private evidence upload diagnostic");
  });
  it("attempts evidence finalization even when dashboard generation fails",async()=>{
    vi.mocked(regenerateRunnerDashboard).mockRejectedValueOnce(new Error("private render diagnostic"));
    const campaign=await run();
    expect(campaign.results.every((r:any)=>r.status==="failed"&&r.cleanup==="failed")).toBe(true);
    expect(campaign.results[0].productJourney.phases).toContainEqual({phase:"cleanup",outcome:"failed",code:"report_generation_failed"});
    expect(campaign.results[0].productJourney.phases).not.toContainEqual({phase:"cleanup",outcome:"failed",code:"evidence_finalization_failed"});
    expect(JSON.stringify(campaign)).not.toContain("private render diagnostic");
  });
  it("retains an explicitly selected mini model without adding a model to the browser story",async()=>{
    const campaign=await run({mini:true});
    expect(campaign.results[0]).toMatchObject({profileId:"runner-codex-mini",model:"gpt-5.4-mini"});
    expect(campaign.expected[0]).toBe("product-journeys.qa.runner-codex-mini.daytona.cloud-onboarding");
    expect(campaign.results[1]).toMatchObject({profileId:"browser",model:null,runtimeMode:"none"});
  });
  it.each(["write","rename"] as const)("still stops owned work and closes the browser when evidence %s fails",async kind=>{
    const close=vi.fn(async()=>{});
    vi.spyOn(chromium,"launch").mockResolvedValueOnce({newContext:async()=>({setDefaultTimeout(){},pages:()=>[]}),close} as any);
    const errors=vi.spyOn(console,"error").mockImplementation(()=>{});
    const listeners={interrupt:process.listenerCount("SIGINT"),terminate:process.listenerCount("SIGTERM")};
    const campaign=await run({persistenceFailure:kind});
    expect(campaign.lifecycle).toEqual(["release:failed"]); expect(close).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGINT")).toBe(listeners.interrupt); expect(process.listenerCount("SIGTERM")).toBe(listeners.terminate);
    expect(campaign.attemptedReport.results.every((r:any)=>r.status==="failed"&&r.cleanup==="failed")).toBe(true);
    expect(campaign.attemptedReport.results[0].productJourney.phases).toContainEqual({phase:"cleanup",outcome:"failed",code:"evidence_persistence_failed"});
    expect(JSON.stringify(campaign)).not.toContain("api_key_fixture"); expect(JSON.stringify(errors.mock.calls)).not.toContain("api_key_fixture");
    expect(errors).toHaveBeenCalledWith("evidence_persistence_failed"); expect(process.exitCode).toBe(1);
  });
  it("withholds lease finalization when the report fails to persist after resource cleanup",async()=>{
    const close=vi.fn(async()=>{});
    vi.spyOn(chromium,"launch").mockResolvedValueOnce({newContext:async()=>({setDefaultTimeout(){},pages:()=>[]}),close} as any);
    vi.spyOn(console,"error").mockImplementation(()=>{});
    const campaign=await run({persistenceFailure:"rename",persistenceAfter:"release"});
    expect(campaign.lifecycle).toEqual(["release:passed"]); expect(close).toHaveBeenCalledOnce();
    expect(campaign.attemptedReport.results.every((r:any)=>r.cleanup==="failed")).toBe(true);
    expect(process.exitCode).toBe(1);
  });
  it("preserves failed authentication and blocked dependents through evidence persistence failure",async()=>{
    vi.spyOn(console,"error").mockImplementation(()=>{});
    const campaign=await run({authFailure:true,persistenceFailure:"write"});
    expect(campaign.lifecycle).toEqual(["release:failed"]);
    expect(campaign.attemptedReport.results.map((r:any)=>r.productJourney.outcome)).toEqual(["failed","blocked"]);
    expect(campaign.attemptedReport.results[0].error).toBe("login_code_expired");
    expect(campaign.attemptedReport.results[1].error).toBe("prerequisite_journey_failed");
    expect(JSON.stringify(campaign.attemptedReport)).not.toContain("api_key_fixture");
  });
});
