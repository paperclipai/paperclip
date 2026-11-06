import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {expect} from "@playwright/test";
import type {ChatCatalogContext,ChatSlackIngressReceipt} from "../chat-catalog-contract.js";
import type {ChatActivityItem} from "../../../packages/shared/src/types/chat-channels.js";
import type {IssueAttachment} from "../../../packages/shared/src/types/issue.js";
import type {IssueWorkProduct} from "../../../packages/shared/src/types/work-product.js";
import {pollUntil} from "../api.js";
import {definition,observeExternal,externalObservation,checks,root,verifyRenderedReply,type ExternalObservation} from "./external-support.js";
import {project,type Entity} from "./internal-support.js";
import {identityWorker} from "./identity-support.js";
import {prepareSlackFixture,slackCompanionFields,type SlackMessage} from "./external-slack-fixture.js";
import {renderSlackLaunchArtifact,hasSlackLaunchRendering,type SlackLaunchRendering} from "./external-slack-render.js";
const hash=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
interface Message {id:string;user:string;text:string;files:string[]}
const projection=(rows:SlackMessage[]):Message[]=>rows.map(row=>({id:row.ts,user:row.user??"",text:row.text??"",files:(row.files??[]).map(file=>file.id).sort()}));
interface ThreadEvidence {source:ChatSlackIngressReceipt;other:ChatSlackIngressReceipt&{runId:string};before:Message[];after:Message[];messages:Message[];duplicate:{canonicalDeliveryCaptured:boolean;duplicateReplayed:boolean};activity:ChatActivityItem[];attachments:IssueAttachment[];products:IssueWorkProduct[];files:Array<{id:string;hash:string;body:string;rendered?:SlackLaunchRendering}>}
interface Observation extends ExternalObservation {thread:ThreadEvidence}
type Fixture=Awaited<ReturnType<typeof prepareSlackFixture>>;
const privateFixtures=new WeakMap<ChatCatalogContext,{fixture:Fixture;otherRoot?:string;before?:Message[];lastRead?:number;rendered?:Map<string,SlackLaunchRendering>;lastThreads?:{after:Message[];messages:Message[]}}>();
function owned(ctx:ChatCatalogContext){const value=privateFixtures.get(ctx);if(!value)throw new Error("Actual Slack fixture is not prepared");return value;}
function completed(text:string){return !/\b(?:when|once|until|after)\b[^.!?\n]{0,100}\b(?:ready|completed|finished|built|delivered|done)\b/i.test(text)&&/\b(?:ready|completed|finished|built|delivered|done)\b/i.test(text)&&!/\b(?:not|isn['’]t|is not|hasn['’]t|have not)\s+(?:yet\s+)?(?:ready|completed|finished|built|delivered|done)\b|\b(?:will|would|should)\s+(?:be\s+)?(?:ready|completed|finished|built|delivered|done)\b/i.test(text);}
export function gradeSlackThread(value:unknown){
 const c=checks(),o=externalObservation(value) as Observation|undefined,t=o?.thread;
 c.add("actual-provider-thread-evidence",!!o&&!!t&&!!t.source?.provider&&!!t.other?.provider&&[t.before,t.after,t.messages,t.activity,t.attachments,t.products,t.files].every(Array.isArray),"Actual Slack messages, original and other-source receipts, registered result bytes and public lifecycle activity are required.");if(!o||!t||!t.source?.provider||!t.other?.provider||![t.before,t.after,t.messages,t.activity,t.attachments,t.products,t.files].every(Array.isArray))return c.result();
 const worker=o.state.worker as Entity|undefined,source=t.source,other=t.other;
 const tasks=o.tasks.filter(task=>task.id!==source.issueId&&task.id!==other.issueId&&task.assigneeAgentId===worker?.id&&task.companyId===o.companyId);
 const target=tasks[0],workerRuns=target?o.runs.filter(run=>run.agentId===worker?.id&&run.contextSnapshot?.issueId===target.id):[];
 const sourceRuns=o.runs.filter(run=>run.contextSnapshot?.issueId===source.issueId),otherRuns=o.runs.filter(run=>run.contextSnapshot?.issueId===other.issueId);
 c.add("exact-real-human-two-thread-context",source.query===o.state.originalQuery&&source.endpointId===other.endpointId&&source.issueId!==other.issueId&&source.provider.threadId!==other.provider.threadId&&source.provider.workspaceId===other.provider.workspaceId&&source.provider.channelId===other.provider.channelId&&source.linkedPaperclipUserId===other.linkedPaperclipUserId&&source.provider.senderUserId===other.provider.senderUserId&&otherRuns.length===1&&otherRuns[0]?.id===other.runId&&otherRuns[0]?.agentId===o.leadId&&otherRuns[0]?.status==="succeeded","The genuine linked sender has two distinct conversations under the same actual assigned agent; the setup source remains separately attributed.");
 c.add("one-attributed-Morgan-build",!!worker&&tasks.length===1&&!!target&&target.status==="done"&&target.projectId===(o.state.project as Entity|undefined)?.id&&sourceRuns.length>=1&&workerRuns.length===1&&workerRuns[0]?.status==="succeeded"&&o.runs.every(run=>run.companyId===o.companyId&&run.runtimeMode==="native"&&run.status==="succeeded"&&(run.contextSnapshot?.issueId===source.issueId&&run.agentId===o.leadId||run.id===other.runId||run.contextSnapshot?.issueId===target.id&&run.agentId===worker.id))&&o.activity.some(row=>row.action==="issue.created"&&row.entityId===target.id&&row.actorType==="agent"&&row.agentId===o.leadId),"Exactly one actual Morgan task is built under normal policy, with independently attributed task creation and source/worker native executions; no unrelated run is accepted.");
 const file=t.attachments.find(file=>file.issueId===target?.id&&file.originatingRunId===workerRuns[0]?.id&&t.products.some(product=>product.issueId===target?.id&&product.createdByRunId===workerRuns[0]?.id&&product.type==="artifact"&&["active","ready_for_review","approved"].includes(product.status)&&product.metadata?.attachmentId===file.id)&&t.files.some(actual=>actual.id===file.id&&actual.hash===file.sha256&&hash(actual.body)===file.sha256&&/<html\b/i.test(actual.body)&&/<h1\b/i.test(actual.body)&&/Acorn\s+Notes/i.test(actual.body)&&!!actual.rendered&&actual.rendered.sha256===file.sha256&&hasSlackLaunchRendering(actual.rendered)));
 c.add("inspectable-real-launch-page",!!file,"A real worker-attributed registered HTML result has independently retrieved matching bytes and the requested launch identity.");
 const reference=target?.identifier,completionReplies=o.phaseReplies.filter(reply=>sourceRuns.some(run=>run.id===reply.runId)&&!!reference&&reply.body.includes(reference)&&completed(reply.body));
 const delivered=t.messages.filter(message=>message.user===o.state.botUserId&&!!reference&&message.text.includes(reference)&&completed(message.text));
 c.add("completion-published-back-to-original-thread",completionReplies.length>=1&&delivered.length===1&&t.activity.some(row=>row.kind==="publication"&&row.status==="published"),"Actual successful source completion and exactly one independently read app-bot completion identify the same built task in the original Slack thread.");
 c.add("other-thread-receives-no-private-content",t.before.length>0&&JSON.stringify(t.before)===JSON.stringify(t.after),"The other live conversation's actual message IDs, authors, text and file references remain unchanged after the canonical request.");
 c.add("genuine-duplicate-is-idempotent",t.duplicate.canonicalDeliveryCaptured&&t.duplicate.duplicateReplayed&&t.activity.some(row=>row.kind==="delivery"&&row.status==="processed"&&/duplicate.*ignored/i.test(row.summary))&&tasks.length===1&&delivered.length===1,"The exact genuine signed event was replayed once; the product records duplicate suppression without another task or outgoing completion.");return c.result();
}
export const slackThreadExternalCases=[definition("chat-channels.reply-in-thread",async ctx=>{
 const worker=await identityWorker(ctx,"Morgan"),p=await project(ctx,"Launch",{description:"Acorn Notes launch page: introduce the calm research notebook and offer a join-the-list signup link. Produce an inspectable static HTML launch page in the authorized workspace.",workspace:{name:"Launch workspace",sourceType:"local_path",cwd:ctx.input.workspacePath,isPrimary:true}});
 const fixture=await prepareSlackFixture(ctx);privateFixtures.set(ctx,{fixture});
 try{await ctx.input.api.patch(`/api/chat-endpoints/${fixture.endpoint.id}`,{executionDefaults:{projectId:p.id}});return {worker,project:p,originalQuery:ctx.scenario.query,botUserId:fixture.binding.prerequisites.botUserId};}catch(error){await fixture.cleanup();privateFixtures.delete(ctx);throw error;}
},gradeSlackThread,{
 authentication:"human-session",journeyKind:"native-slack-thread",slackIngress:{kind:"native-slack-thread",maximumProviderCalls:20,ingressTimeoutMs:120000,setupThread:"same-agent-distractor"},expectedRunCount:4,minimumRunCount:2,expectedHumanMessageCount:1,turnTimeoutMs:120000,attemptTimeoutMs:600000,
 externalInput:{provider:"slack",fields:slackCompanionFields},
 sourceFiles:["chat-catalog-domains/external-slack-thread.ts","chat-catalog-domains/external-slack-fixture.ts","chat-catalog-domains/external-slack-provider.ts","chat-catalog-domains/external-slack-relay.ts","chat-catalog-domains/external-slack-render.ts","chat-catalog-domains/runtime-rendered-artifact.ts","chat-catalog-domains/external-fixtures.ts","chat-catalog-domains/external-support.ts","chat-catalog-domains/internal-support.ts","chat-catalog-domains/identity-support.ts","chat-slack-ingress.ts","../../packages/shared/src/types/chat-channels.ts","../../server/src/routes/chat-channels.ts","../../server/src/services/chat-channels.ts","../../server/src/services/chat-channels/inbound/authorization.ts","../../server/src/services/chat-channels/inbound/wakeups.ts","chat-scenarios/chat-channels.yaml"],
 async dispatchSlackOtherThread(ctx,_state,{query,signal}){
  const local=owned(ctx),f=local.fixture,start=f.provider.receipts.length;signal.throwIfAborted();
  const ts=await f.createDistractor(query);local.otherRoot=ts;
  const receipt=await f.resolveIngress(query,ts,f.provider.receipts.length-start,ts);
  const ready=await pollUntil({label:"actual other Slack source's sole completed native",deadlineAt:Date.now()+100000,intervalMs:1000,load:()=>ctx.allRuns(),accept:runs=>runs.length===1&&runs[0]?.runtimeMode==="native"&&runs[0]?.status==="succeeded"&&runs[0]?.agentId===ctx.input.fixtures.agent.id&&runs[0]?.contextSnapshot?.issueId===receipt.issueId,reject:runs=>runs.length>1||runs.some(run=>["failed","cancelled","timed_out"].includes(run.status))?"Other-thread setup admitted extra or failed native work":undefined});
  local.before=projection(await f.readThread(ts));signal.throwIfAborted();return {...receipt,runId:ready[0]!.id,providerCalls:f.provider.receipts.length-start};
 },
 async dispatchSlackQuery(ctx,_state,{query,signal}){
  if(query!==ctx.scenario.query)throw new Error("Slack canonical bytes changed");const f=owned(ctx).fixture,start=f.provider.receipts.length;
  f.relay.expectCanonical(query,f.threadId);
  const result=await f.provider.call<{ok:true;channel:string;ts:string;message:{user:string;text:string;thread_ts:string}}>("sender","chat.postMessage",{channel:f.binding.prerequisites.channelId,thread_ts:f.threadId,text:query,unfurl_links:false,unfurl_media:false},signal);
  if(result.channel!==f.binding.prerequisites.channelId||result.message.user!==f.binding.prerequisites.senderUserId||result.message.text!==query||result.message.thread_ts!==f.threadId)throw new Error("Actual Slack canonical publication did not bind exact human/thread/query");
  await pollUntil({label:"genuine canonical signed Slack delivery capture",deadlineAt:Date.now()+30000,load:async()=>f.relay.receipt(),accept:row=>row.canonicalDeliveryCaptured});
  const duplicate=await f.relay.replayCanonicalOnce();if(duplicate.status!==200)throw new Error("Actual signed duplicate was not acknowledged");
  return f.resolveIngress(query,result.ts,f.provider.receipts.length-start);
 },
 async observe(ctx,state){
  const o=await observeExternal(ctx,state),local=owned(ctx),f=local.fixture,source=state.slackIngressReceipt as ChatSlackIngressReceipt|undefined,other=state.slackOtherThreadSetupReceipt as (ChatSlackIngressReceipt&{runId:string})|undefined;
  if(!source||!other)return {...o,thread:undefined};
  const tasks=o.tasks.filter(row=>row.assigneeAgentId===(state.worker as Entity).id&&row.id!==source.issueId&&row.id!==other.issueId),target=tasks.length===1?tasks[0]:undefined;
  // Provider egress reads wait for actual native settlement; no periodic Slack
  // scan runs while the worker is building. Final/reload checks re-read bytes.
  if(o.runs.length&&o.runs.every(run=>run.status==="succeeded")&&target?.status==="done"&&(!local.lastRead||Date.now()-local.lastRead>2000)){
   local.lastThreads={after:projection(await f.readThread(local.otherRoot!)),messages:projection(await f.readThread(f.threadId))};local.lastRead=Date.now();
  }
  const attachments=target?await ctx.input.api.get<IssueAttachment[]>(`/api/issues/${target.id}/attachments`):[],products=target?await ctx.input.api.get<IssueWorkProduct[]>(`/api/issues/${target.id}/work-products`):[],files:ThreadEvidence["files"]=[];
  for(const file of attachments.filter(row=>/\.html?$/i.test(row.originalFilename??"")).slice(0,10)){if(file.byteSize>262144)throw new Error("Slack launch result exceeds bounded artifact inspection");const bytes=await ctx.input.api.getAttachmentContent(file.id);const body=bytes.toString("utf8"),digest=hash(bytes);local.rendered??=new Map();let rendered=local.rendered.get(digest);if(!rendered){rendered=await renderSlackLaunchArtifact(ctx,body);local.rendered.set(digest,rendered);}files.push({id:file.id,hash:digest,body,rendered});}
  const activity=await ctx.input.api.get<ChatActivityItem[]>(`/api/chat-endpoints/${f.endpoint.id}/activity`);
  return {...o,thread:{source,other,before:local.before??[],after:local.lastThreads?.after??[],messages:local.lastThreads?.messages??[],duplicate:f.relay.receipt(),activity,attachments,products,files}} satisfies Observation;
 },
 async verifyResult(ctx,_state,value){
  const o=value as Observation;await verifyRenderedReply(ctx,value);
  const target=o.tasks.find(row=>row.assigneeAgentId===(o.state.worker as Entity).id&&row.status==="done"),href=o.links.find(link=>{try{const url=new URL(link,o.origin);return url.origin===o.origin&&[target?.id,target?.identifier].some(id=>!!id&&url.pathname.endsWith(`/issues/${id}`));}catch{return false;}});
  if(!target||!href)throw new Error("Actual source completion must link its built Morgan task");
  await ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`).first().click();await expect(ctx.input.page.getByText(target.title!,{exact:true}).first()).toBeVisible();
  const file=o.thread.attachments.find(row=>o.thread.files.some(actual=>actual.id===row.id&&actual.hash===row.sha256));if(!file?.contentPath)throw new Error("Actual launch result lacks a supported public content route");
  let retrieved:Buffer|undefined;const page=await ctx.input.page.context().newPage();try{
   const pending=page.waitForEvent("download",{timeout:5000}).catch(()=>undefined);
   await page.goto(new URL(file.contentPath,o.origin).href,{waitUntil:"domcontentloaded"}).catch(error=>{if(!/download|ERR_ABORTED/i.test(String(error)))throw error;});
   const download=await pending;if(download){const path=await download.path();if(path)retrieved=await readFile(path);if(!retrieved||hash(retrieved)!==file.sha256)throw new Error("Actual browser launch-page download differs from the registered bytes");}else{await expect(page.locator("h1")).toBeVisible();retrieved=await ctx.input.api.getAttachmentContent(file.id);if(hash(retrieved)!==file.sha256)throw new Error("Public rendered result changed its registered bytes");}
  }finally{await page.close();}
  if(!retrieved||!hasSlackLaunchRendering(await renderSlackLaunchArtifact(ctx,retrieved.toString("utf8"))))throw new Error("Actual publicly retrieved launch result is not visibly usable");
 },
 async cleanup(ctx){const local=privateFixtures.get(ctx);try{await local?.fixture.cleanup();}finally{privateFixtures.delete(ctx);}},
})];
