import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
vi.mock("../chat-flow.js",()=>({sendChatMessage:vi.fn()}));
vi.mock("@playwright/test",()=>({expect:(node:any)=>({toBeVisible:async()=>{if(!node.visible())throw Error("Missing selected UI");},toContainText:async(text:string)=>{if(!node.text.includes(text))throw Error("Wrong selected action");}})}));
vi.mock("./external-provider.js",()=>({startNotesProvider:async()=>({calls:[],failWrites:vi.fn(),close:vi.fn()}),connectNotes:async()=>({connectionId:"connection",write:["write"]})}));
vi.mock("./identity-support.js",()=>({openStandingChat:async()=>({id:"source"}),probeAgentPermission:async()=>403}));
vi.mock("../chat-query-attachments.js",()=>({uploadFactualQueryAttachment:async()=>({issueId:"source"}),chatQueryWithAttachments:(q:string)=>q,verifyChatQueryAttachments:async()=>true}));
import { appReviewExternalCases } from "./external-app-review.js";
afterEach(()=>vi.restoreAllMocks());
function fixture(fault?:"wrong preview"|"missing takeover"|"wrong app"|"wrong action"){
 let opened=false,declined=false;const events:string[]=[];
 const action={connectionId:"connection",actionRequestId:"action",invocationId:"invocation",appDisplayName:"Synthetic Launch Notes",toolName:"launch_update",toolDisplayName:"Update launch page",risk:"write",rememberActionScope:"Same agent, action, connection and project",previewMarkdown:"The public launch is November 8, 2030.\n\nUpdate launch page"};
 const card={id:"selected",kind:"request_confirmation",status:"pending",sourceRunId:"source-native",payload:{toolAction:action}};
 const timeline={visible:()=>fault!=="wrong preview",text:action.previewMarkdown.split(/\n\s*\n/)[0],getByRole:(_role:string,opts:{name:string})=>({click:async()=>{
  if(opts.name!=="Review request")throw Error("Timeline preview has no decision controls");events.push("open exact review");opened=true;
 }})};
 const review={visible:()=>opened&&fault!=="missing takeover",text:fault==="wrong action"?"Read launch page":"Update launch page",getByRole:(role:string,opts:{name:string})=>role==="img"?{visible:()=>opened&&fault!=="wrong app"&&opts.name===action.appDisplayName}:{click:async()=>{
  if(!opened||opts.name!=="Decline")throw Error("Wrong decision target");declined=true;events.push("selected decline");throw Error("Stop after selected decline");
 }}};
 const page={locator:(selector:string)=>{events.push(selector);return timeline;},getByTestId:(id:string)=>{expect(id).toBe("task-chat-composer-takeover");return review;}};
 const ctx={scenario:{id:"app-permissions.ask-before-action",query:"Add this launch update to our notes app."},input:{page,fixtures:{company:{id:"company"},agent:{id:"ceo"}},api:{
  get:async(path:string)=>path==="/api/auth/get-session"?{user:{id:"person"}}:path.endsWith("/tools/trust-rules")?{trustRules:[]}:path.endsWith("/interactions")?[card]:Promise.reject(Error("Unexpected fixture read")),
  post:async()=>({id:"project"}),patch:async()=>({}),},evidence:async()=>{}},refreshIssue:async()=>{},issue:()=>({id:"source",conversationState:"waiting"}),allRuns:async()=>[{id:"source-native",status:"succeeded",contextSnapshot:{issueId:"source"}}]} as unknown as ChatCatalogContext;
 const definition=appReviewExternalCases[0]!;return{ctx,definition,events,declined:()=>declined};
}
it("the actual approval caller opens its selected timeline request and decides only in the real composer takeover",async()=>{
 const f=fixture(),state=await f.definition.setup(f.ctx);
 await expect(f.definition.act!(f.ctx,state)).rejects.toThrow("Stop after selected decline");
 expect(f.declined()).toBe(true);expect(f.events).toEqual(['[id="interaction-selected"]',"open exact review","selected decline"]);
 expect(state.agentApproveStatus).toBe(403);
});
it.each(["wrong preview","missing takeover","wrong app","wrong action"] as const)("does not decide a %s",async fault=>{
 const f=fixture(fault),state=await f.definition.setup(f.ctx);
 await expect(f.definition.act!(f.ctx,state)).rejects.toThrow();expect(f.declined()).toBe(false);
});
