import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const owner=vi.hoisted(()=>({id:"manual-worker",companyId:"company"}));
vi.mock("./runtime-support.js", async importOriginal => ({ ...await importOriginal<typeof import("./runtime-support.js")>(), runtimeWorker: vi.fn(async () => ({...owner})) }));
import { runtimeTreeCases } from "./runtime-tree.js";
afterEach(() => { vi.useRealTimers();owner.id="manual-worker";owner.companyId="company"; });
it.each([[0,true],[1,true],[0,false]] as const)("requires real positive-cap independent budget prerequisite for tree case%s (hold=%s)",async(index,budgetHeld)=>{
 vi.useFakeTimers();vi.setSystemTime(100);
 const events:string[]=[];let imported=false,positiveCap=false;
 const api={post:vi.fn(async(route:string,body:Record<string,unknown>)=>{
  if(route.endsWith("/issues"))return {id:body.parentId?"manual-child":"parent"};
  if(route.endsWith("/pause")){events.push("manual-pause");return {};}
  if(route.endsWith("/budgets/policies")){positiveCap=Number(body.amount)>0;expect(body.amount).toBe(100);expect(body.scopeId).toBe("manual-worker");events.push("positive-policy");return {};}
  if(route.endsWith("/cost-events")){
   expect(body).toMatchObject({agentId:"manual-worker",provider:"synthetic-eval-import",biller:"synthetic-eval-import",model:"imported-fixture-receipt",costStatus:"reported",costCents:125,inputTokens:0,outputTokens:0});
   expect(body.heartbeatRunId).toBeUndefined();imported=true;events.push("synthetic-accounting-import");return {id:"receipt"};
  }
  if(route.endsWith("/tree-holds")){events.push("actual-budget-observed");throw new Error("stop-after-budget-prerequisite");}
  throw new Error("Unexpected fixture mutation");
 }),get:vi.fn(async()=>({status:"paused",lifecycleHolds:budgetHeld&&positiveCap&&imported?["manual","budget"]:["manual"]}))};
 const evidence=vi.fn(async(_file:string,value:{modelProviderUsage:string;importedFixtureCostCents:number;hardCapCents:number})=>{
  expect(value.modelProviderUsage).toContain("Not model/provider usage");expect(value.importedFixtureCostCents).toBe(125);expect(value.hardCapCents).toBe(100);events.push("accounting-provenance");
 });
 const ctx={scenario:{id:runtimeTreeCases[index]!.scenarioId},observationDeadlineAt:900000,input:{nonce:"fixture",fixtures:{company:{id:"company"},agent:{id:"ceo"}},api,evidence}} as unknown as ChatCatalogContext;
 const result=expect(runtimeTreeCases[index]!.setup(ctx)).rejects.toThrow(budgetHeld?"stop-after-budget-prerequisite":"Timed out waiting");
 await vi.advanceTimersByTimeAsync(46000);await result;
 expect(events).toEqual(["manual-pause","positive-policy","synthetic-accounting-import","accounting-provenance",...(budgetHeld?["actual-budget-observed"]:[])]);
 expect(api.post.mock.calls.filter(([route])=>route.includes("cost-events"))).toHaveLength(1);
 expect(api.post.mock.calls.filter(([route])=>route.includes("budgets/policies"))).toHaveLength(1);
});

it.each(["foreign company","source CEO"])("rejects %s as the independent held worker",async invalid=>{
 if(invalid==="foreign company")owner.companyId="foreign";else owner.id="ceo";
 const post=vi.fn(async(_route:string,_body:unknown)=>({id:"parent"}));const ctx={input:{fixtures:{company:{id:"company"},agent:{id:"ceo"}},api:{post}}} as unknown as ChatCatalogContext;
 await expect(runtimeTreeCases[0]!.setup(ctx)).rejects.toThrow("distinct same-company worker");
 expect(post).toHaveBeenCalledOnce();expect(post.mock.calls[0]?.[0]).not.toContain("budgets");
});
it("preserves the independent policy and rejects starving any active branch",async()=>{
 expect(runtimeTreeCases[0]!.setupPolicy?.funding).toBe("preserve-scenario");
 const policy=(scopeType:string,scopeId:string,amount:number)=>({scopeType,scopeId,amount,isActive:true,hardStopEnabled:true,unpricedUsagePolicy:"allow"});
 let holdPresent=true;
 const policies=[policy("company","company",500),...['ceo','first','second'].map(id=>policy("agent",id,500)),policy("agent","manual",100)];
 const state={worker:{id:"first"},workerRunId:"first-run",workerWasReallyWaiting:true,second:{worker:{id:"second"},workerRunId:"second-run",workerWasReallyWaiting:true},manualWorker:{id:"manual"},manualChild:{id:"manual-child"},manualHold:{id:"hold"}};
 const ctx={input:{fixtures:{company:{id:"company"},agent:{id:"ceo"}},api:{get:async(route:string)=>route.endsWith("/budgets/overview")?{policies}:route.endsWith("/tree-control/state")?{activePauseHold:{holdId:"hold"}}:route==="/api/agents/ceo"?{lifecycleState:"ready",status:"idle"}:{id:"manual",status:"paused",lifecycleHolds:holdPresent?["manual","budget"]:["manual"]}}},allRuns:async()=>[{id:"first-run",agentId:"first",status:"running",companyId:"company"},{id:"second-run",agentId:"second",status:"running",companyId:"company"}]} as unknown as ChatCatalogContext;
 expect((await runtimeTreeCases[0]!.verifySetup!(ctx,state)).passed).toBe(true);
 holdPresent=false;expect((await runtimeTreeCases[0]!.verifySetup!(ctx,state)).passed).toBe(false);holdPresent=true;
 for(const p of policies){const before=p.amount;p.amount=0;expect((await runtimeTreeCases[0]!.verifySetup!(ctx,state)).passed).toBe(false);p.amount=before;}
});
