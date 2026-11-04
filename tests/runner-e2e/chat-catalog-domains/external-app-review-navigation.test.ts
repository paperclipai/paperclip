import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
vi.mock("../chat-flow.js",()=>({sendChatMessage:vi.fn()}));
vi.mock("@playwright/test",()=>({expect:(node:any)=>({toBeVisible:async()=>{if(!node.visible())throw Error("Missing selected UI");},toContainText:async(text:string)=>{if(!node.text.includes(text))throw Error("Wrong selected action");}})}));
vi.mock("./external-provider.js",()=>({startNotesProvider:async()=>({calls:[],failWrites:vi.fn(),close:vi.fn()}),connectNotes:async()=>({connectionId:"connection",write:["write"]})}));
vi.mock("./identity-support.js",()=>({openStandingChat:async()=>({id:"source"}),probeAgentPermission:async()=>403,cleanupIdentityProbes:vi.fn()}));
vi.mock("../chat-query-attachments.js",()=>({uploadFactualQueryAttachment:async()=>({issueId:"source"}),chatQueryWithAttachments:(q:string)=>q,verifyChatQueryAttachments:async()=>true}));
vi.mock("./external-app-review-probe.js", () => ({ probeReviewApproval: vi.fn(async () => ({status: 403, code: "interaction_governed_action_denied", boundaryUnchanged: true, keyRevoked: true})) }));
import { probeReviewApproval } from "./external-app-review-probe.js";
import { appReviewExternalCases } from "./external-app-review.js";
afterEach(()=>vi.restoreAllMocks());
function fixture(fault?:"wrong preview"|"missing takeover"|"wrong app"|"wrong action"|"missing disclosure"|"wrong full body"|"wrong hash"|"wrong date"){
 let opened=false,declined=false;const events:string[]=[];
 let runtimeConfig={retained:true,heartbeat:{enabled:false,maxDailyRuns:3,maxConcurrentRuns:1,maxDailyCostCents:500}};
 const proposalText = "# Launch update\n\n" + "Owned destination context. ".repeat(7) + "The public launch is November 8, 2030.";
 const argumentsSummaryJson = JSON.stringify({text: fault === "wrong date" ? proposalText.replace("November 8", "November 9") : proposalText});
 const argumentsHash = createHash("sha256").update(argumentsSummaryJson).digest("hex");
 const action={connectionId:"connection",actionRequestId:"action",invocationId:"invocation",appDisplayName:"Synthetic Launch Notes",toolName:"launch_update",toolDisplayName:"Update launch page",risk:"write",rememberActionScope:"Same agent, action, connection and project",previewMarkdown:"Update launch page · Text: a short preview…",argumentsSummaryJson,argumentsHash: fault === "wrong hash" ? "0".repeat(64) : argumentsHash};
 const card={id:"selected",kind:"request_confirmation",status:"pending",sourceRunId:"source-native",payload:{toolAction:action}};
 const timeline={visible:()=>fault!=="wrong preview",text:action.previewMarkdown.split(/\n\s*\n/)[0],getByRole:(_role:string,opts:{name:string})=>({click:async()=>{
  if(opts.name!=="Review request")throw Error("Timeline preview has no decision controls");events.push("open exact review");opened=true;
 }})};
 const details={visible:()=>opened&&fault!=="missing disclosure",locator:(kind:string)=>kind==="summary"?{click:async()=>{events.push("inspect selected proposal");}}:kind==="pre"?{visible:()=>opened&&fault!=="missing disclosure",textContent:async()=>fault==="wrong full body"?"different body":action.argumentsSummaryJson}:{textContent:async()=>action.argumentsHash},filter(){return this;}};
 const review={visible:()=>opened&&fault!=="missing takeover",text:fault==="wrong action"?"Read launch page":"Update launch page",locator:()=>details,getByRole:(role:string,opts:{name:string})=>role==="img"?{visible:()=>opened&&fault!=="wrong app"&&opts.name===action.appDisplayName}:{click:async()=>{
  if(!opened||opts.name!=="Decline")throw Error("Wrong decision target");declined=true;events.push("selected decline");throw Error("Stop after selected decline");
 }}};
 const page={locator:(selector:string)=>{events.push(selector);return timeline;},getByTestId:(id:string)=>{expect(id).toBe("task-chat-composer-takeover");return review;}};
 const ctx={scenario:{id:"app-permissions.ask-before-action",query:"Add this launch update to our notes app."},input:{page,fixtures:{company:{id:"company"},agent:{id:"ceo"}},api:{
  get:async(path:string)=>path==="/api/agents/ceo"?{runtimeConfig}:path==="/api/auth/get-session"?{user:{id:"person"}}:path.endsWith("/tools/trust-rules")?{trustRules:[]}:path.endsWith("/interactions")?[card]:path.endsWith("/runs/source-native/decisions")?{runId:"source-native",decisions:[{invocation:{id:"invocation",companyId:"company",agentId:"ceo",issueId:"source",runId:"source-native",connectionId:"connection",catalogEntryId:"write",argumentsHash,status:"awaiting_approval"},actionRequest:{id:"action",status:"pending",canonicalArgumentsHash:argumentsHash}}]}:Promise.reject(Error("Unexpected fixture read")),
  post:async()=>({id:"project"}),patch:async(path:string,body:any)=>{if(path==="/api/agents/ceo")runtimeConfig=body.runtimeConfig;return{};},},evidence:async()=>{}},refreshIssue:async()=>{},issue:()=>({id:"source",conversationState:"waiting"}),allRuns:async()=>[{id:"source-native",companyId:"company",agentId:"ceo",status:"succeeded",contextSnapshot:{issueId:"source"}}]} as unknown as ChatCatalogContext;
 const definition=appReviewExternalCases[0]!;return{ctx,definition,events,declined:()=>declined,runtimeConfig:()=>runtimeConfig};
}
it("the actual approval caller opens its selected timeline request and decides only in the real composer takeover",async()=>{
 const f=fixture(),state=await f.definition.setup(f.ctx);
 await expect(f.definition.act!(f.ctx,state)).rejects.toThrow("Stop after selected decline");
 expect(f.declined()).toBe(true);expect(f.events).toEqual(['[id="interaction-selected"]',"open exact review","inspect selected proposal","selected decline"]);
 expect(state.agentApproveStatus).toBe(403);
 expect(probeReviewApproval).toHaveBeenCalledWith(expect.objectContaining({companyId:"company",agentId:"ceo",issueId:"source",interaction:expect.objectContaining({id:"selected",sourceRunId:"source-native"}),run:expect.objectContaining({id:"source-native",companyId:"company",agentId:"ceo",status:"succeeded"}),invocation:expect.objectContaining({companyId:"company",agentId:"ceo",issueId:"source",runId:"source-native",status:"awaiting_approval"})}));
});
it.each(["wrong preview","missing takeover","wrong app","wrong action","missing disclosure","wrong full body","wrong hash","wrong date"] as const)("does not decide a %s",async fault=>{
 const f=fixture(fault),state=await f.definition.setup(f.ctx);
 await expect(f.definition.act!(f.ctx,state)).rejects.toThrow();expect(f.declined()).toBe(false);
});

it("provisions the declared six native review turns while retaining finite cost and concurrency limits",async()=>{
 const f=fixture();await f.definition.setup(f.ctx);
 expect(f.definition.expectedRunCount).toBe(6);
 expect(f.runtimeConfig()).toEqual({retained:true,heartbeat:{enabled:false,maxDailyRuns:6,maxConcurrentRuns:1,maxDailyCostCents:500}});
});

it("does not run the review journey when the six-turn fixture allowance was not saved",async()=>{
 const f=fixture();vi.spyOn(f.ctx.input.api,"patch").mockResolvedValue({});
 await expect(f.definition.setup(f.ctx)).rejects.toThrow("declared six-turn daily allowance");
 expect(f.runtimeConfig().heartbeat.maxDailyRuns).toBe(3);
});
