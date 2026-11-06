import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { boardMutationGuard } from "../../../server/src/middleware/board-mutation-guard.js";
import { transition } from "../../../server/src/modules/agent-lifecycle/domain/policy.js";
const mock = vi.hoisted(() => ({ gate: vi.fn() }));
vi.mock("./runtime-busy-worker.js", async original => ({ ...await original<object>(), prepareRuntimeWorkerGate: mock.gate }));
import * as inventory from "./internal-task-inventory.js";
import * as delegation from "./runtime-delegation.js";
const companyId = "11111111-1111-4111-8111-111111111111", firstId = "22222222-2222-4222-8222-222222222222", secondId = "33333333-3333-4333-8333-333333333333", leadId = "44444444-4444-4444-8444-444444444444";
const baseURL = "http://127.0.0.1:3218";
function owner(id=firstId) { return { id, companyId, status: "idle", lifecycleState: "ready", lifecycleVersion: 7, lifecycleHolds: [] as string[], lifecycleError: null }; }
function pause(before=owner()) { const requested = { ...before, status: "paused", lifecycleState: transition("ready", "pause"), lifecycleVersion: 8, lifecycleHolds: ["manual"] }; return { before, requested, settled: { ...requested, lifecycleState: transition("pausing", "complete"), lifecycleVersion: 9 } }; }
beforeEach(() => { vi.stubGlobal("fetch", () => { throw new Error("No real network permitted in pure task prerequisites"); }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); mock.gate.mockReset(); });
it("actual inventory preflight accepts real completed manual pauses instead of impossible ready-plus-paused lifecycle", async () => {
 const first=pause(),second=pause(owner(secondId)),rows=[first,second];
 const ctx={ input:{fixtures:{company:{id:companyId},agent:{id:leadId}},api:{get:async(path:string)=>path.endsWith(leadId)?owner(leadId):rows.find(x=>path.endsWith(x.before.id))!.settled}}} as unknown as ChatCatalogContext;
 const grade=await inventory.taskInventoryCases[0]!.verifySetup!(ctx,{workerIds:[firstId,secondId],ownerPauseReceipts:rows.map(({before,requested})=>({before,requested}))});
 expect(grade.passed).toBe(true);
});
function passesBoardGuard(headers:Record<string,string>) { let passed=false;let status=200;const req={method:"POST",actor:{type:"board",source:"session"},header:(k:string)=>k==="host"?"127.0.0.1:3218":headers[k]??headers[k[0]!.toUpperCase()+k.slice(1)],socket:{},app:{get:()=>undefined}} as unknown as Request;const res={status:(value:number)=>{status=value;return res;},json:()=>{}} as unknown as Response;boardMutationGuard()(req,res,()=>{passed=true;});return{passed,status}; }
it("actual delegation upload uses the owned browser Origin and reaches the unchanged authenticated board guard", async () => {
 const stop=new Error("Controlled authenticated upload boundary; no server or file write");mock.gate.mockResolvedValue({worker:{id:firstId},gate:{scriptPath:"/synthetic/gate"}});
 const ctx={input:{nonce:"synthetic",fixtures:{company:{id:companyId},agent:{id:leadId}},api:{baseURL,post:async(path:string)=>path.endsWith("/comments")?{id:secondId}:{id:firstId}},page:{url:()=>baseURL+"/RUN/chat",request:{post:async(_url:string,options:{headers?:Record<string,string>})=>{const g=passesBoardGuard(options.headers??{});if(g.passed)throw stop;return{status:()=>g.status,dispose:async()=>{}};}}}},allRuns:async()=>[]} as unknown as ChatCatalogContext;
 await expect(delegation.runtimeDelegationCases[0]!.setup(ctx)).rejects.toBe(stop);
});

it("accepts the public pause already-settled response without inventing an operation object", () => {
 const r=pause(); expect(inventory.inventoryOwnerPauseRetained({before:r.before,requested:r.settled},r.settled,companyId,firstId)).toBe(true);
});
it.each(["wrong-owner", "foreign-company", "stale-version", "no-hold", "extra-hold", "not-paused", "error", "not-ready-before", "held-before", "invalid-version", "overflow"])("rejects %s inventory pause evidence", kind => {
 const r=pause();
 if(kind==="wrong-owner")r.settled.id=secondId;
 if(kind==="foreign-company")r.settled.companyId=secondId;
 if(kind==="stale-version")r.settled.lifecycleVersion--;
 if(kind==="no-hold")r.settled.lifecycleHolds=[];
 if(kind==="extra-hold")r.settled.lifecycleHolds.push("budget");
 if(kind==="not-paused")r.settled.lifecycleState="ready";
 if(kind==="error")Object.assign(r.settled,{lifecycleError:"failed"});
 if(kind==="not-ready-before")r.before.lifecycleState="paused";
 if(kind==="held-before")r.before.lifecycleHolds.push("manual");
 if(kind==="invalid-version")r.before.lifecycleVersion=NaN;
 if(kind==="overflow")r.before.lifecycleVersion=Number.MAX_SAFE_INTEGER;
 expect(inventory.inventoryOwnerPauseRetained(r,r.settled,companyId,firstId)).toBe(false);
});
it("preserves all501 open seeds, both paused owners, genuine unassigned work and assigned in-progress work", () => {
 const rows=Array.from({length:501},(_,i)=>inventory.openInventoryTaskSeed(i,firstId,secondId));
 expect(rows).toHaveLength(501);expect(rows.filter(r=>r.assigneeAgentId===null)).toHaveLength(167);
 expect(rows.some(r=>r.status==="in_progress"&&r.assigneeAgentId===firstId)).toBe(true);
 expect(rows.some(r=>r.status==="in_progress"&&r.assigneeAgentId===secondId)).toBe(true);
 expect(rows.some(r=>r.status==="blocked")).toBe(true);expect(rows.some(r=>!r.assigneeAgentId&&r.status==="in_progress")).toBe(false);
});
it("requires distinct actual paused owners in the real preflight", async () => {
 const r=pause();const ctx={input:{fixtures:{company:{id:companyId},agent:{id:leadId}},api:{get:async(p:string)=>p.endsWith(leadId)?owner(leadId):r.settled}}} as unknown as ChatCatalogContext;
 const grade=await inventory.taskInventoryCases[0]!.verifySetup!(ctx,{workerIds:[firstId,firstId],ownerPauseReceipts:[r,r]});expect(grade.passed).toBe(false);
});
it.each(["absent", "foreign"])("the actual unchanged board guard rejects %s Origin", kind => {
 const headers:Record<string,string>=kind==="absent"?{}:{Origin:"https://foreign.invalid"};expect(passesBoardGuard(headers)).toEqual({passed:false,status:403});
});
it.each(["blank-browser", "foreign-browser", "foreign-upload", "wrong-company", "wrong-task", "query", "credentials"])("rejects %s before human attachment upload", kind => {
 let browser=baseURL+"/RUN/chat",target=`/api/companies/${companyId}/issues/${firstId}/attachments`;
 if(kind==="blank-browser")browser="about:blank";
 if(kind==="foreign-browser")browser="https://foreign.invalid/RUN/chat";
 if(kind==="foreign-upload")target="https://foreign.invalid"+target;
 if(kind==="wrong-company")target=target.replace(companyId,secondId);
 if(kind==="wrong-task")target=target.replace(firstId,secondId);
 if(kind==="query")target+="?redirect=1";
 if(kind==="credentials")browser="http://user:pass@127.0.0.1:3218/RUN/chat";
 expect(()=>delegation.launchBriefBrowserOrigin(baseURL,browser,target,companyId,firstId)).toThrow();
});
it("retains real byte payload, exact owned endpoint and trusted Origin in the caller", async () => {
 const stop=new Error("Stop after actual multipart boundary");mock.gate.mockResolvedValue({worker:{id:firstId},gate:{scriptPath:"/synthetic/gate"}});
 let calls=0;const post=vi.fn(async(url:string,options:{headers:Record<string,string>;multipart:{issueCommentId:string;file:{name:string;mimeType:string;buffer:Buffer}}})=>{calls++;expect(url).toBe(`/api/companies/${companyId}/issues/${firstId}/attachments`);expect(options.headers).toEqual({Origin:baseURL});expect(options.multipart.issueCommentId).toBe(secondId);expect(options.multipart.file.name).toBe("design-brief.md");expect(options.multipart.file.mimeType).toBe("text/markdown");expect(options.multipart.file.buffer.toString()).toContain("Research without the busywork");throw stop;});
 const ctx={input:{nonce:"synthetic",fixtures:{company:{id:companyId},agent:{id:leadId}},api:{baseURL,post:async(p:string)=>p.endsWith("/comments")?{id:secondId}:{id:firstId}},page:{url:()=>baseURL+"/RUN/chat",request:{post}}},allRuns:async()=>[]} as unknown as ChatCatalogContext;
 await expect(delegation.runtimeDelegationCases[0]!.setup(ctx)).rejects.toBe(stop);expect(calls).toBe(1);
});
