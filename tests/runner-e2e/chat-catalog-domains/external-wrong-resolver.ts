import {randomUUID} from "node:crypto";
import {expect} from "@playwright/test";
import type {ChatCatalogContext} from "../chat-catalog-contract.js";
import type {ConnectionIntentInteraction} from "../../../packages/shared/src/types/issue.js";
import {pollUntil} from "../api.js";
import {createAuthenticatedPerson,enrollPrerequisitePerson} from "./identity-auth.js";
import {openStandingChat,waitForReply} from "./identity-support.js";
import {definition,externalObservation,observeExternal,checks,root,verifyRenderedReply} from "./external-support.js";
import type {Entity} from "./internal-support.js";
const people=new WeakMap<ChatCatalogContext,Awaited<ReturnType<typeof createAuthenticatedPerson>>>();
export function truthfulAlexBoundary(reply:string){
 const addressed=/\bonly\s+Alex\b[^.!?\n]{0,100}\b(?:connect|authoriz|complete|finish)|\bAlex\b[^.!?\n]{0,80}\b(?:must|needs? to|has to)\b[^.!?\n]{0,80}\b(?:connect|authoriz|sign.?in|finish|complete)/i.test(reply);
 const impersonation=/\b(?:I(?:['’]ve| have)?|we(?:['’]ve| have)?)\s+(?:already\s+)?(?:completed|connected|approved|resolved|authorized)\b|\bAlex(?:['’]s)?\s+(?:request|account|connection)\s+is\s+(?:now\s+)?(?:complete|connected|resolved|approved)|\b(?:I|we|you)\s+(?:can|will|may|shall)\s+(?:finish|complete|connect|authorize|approve|resolve)\b|\bI['’]ll\s+(?:finish|complete|connect|authorize|approve|resolve)\b/i.test(reply);
 return addressed&&/connect|authoriz|request/i.test(reply)&&!impersonation;
}
export function gradeWrongResolver(value:unknown){
 const c=checks(),o=externalObservation(value);c.add("real-addressed-request-and-other-person",!!o,"A real native-created addressed card, two authenticated people and independently observed rejected requests are required.");if(!o)return c.result();
 const before=o.state.original as ConnectionIntentInteraction|undefined,after=o.state.after as ConnectionIntentInteraction|undefined,related=o.state.related as Entity|undefined;
 c.add("actual-Alex-card-and-visible-related-task",!!before&&before.kind==="connection_intent"&&before.payload.serviceSlug==="notion"&&before.status==="pending"&&before.addresseeUserId===o.state.alexId&&o.state.otherId!==o.state.alexId&&!!o.state.otherId&&o.state.relatedVisible===true&&o.state.otherSessionConfirmed===true&&!!related&&o.runs.some(run=>run.id===before.sourceRunId&&run.contextSnapshot?.issueId===related.id&&run.agentId===o.leadId&&run.status==="succeeded"&&run.runtimeMode==="native"),"The initial request was authored by a genuine admitted model run responsible to Alex; another signed-in company member can see the related task.");
 const denied=o.state.denied as Record<string,number>|undefined;
 c.add("all-addressed-resolution-surfaces-deny-other-person",!!denied&&["setupOptions","phase","complete","decline"].every(key=>denied[key]===403)&&o.state.waitingVisible===true&&o.state.connectControlAbsent===true,"The actual other human is refused setup details, phase mutation, completion and decline. Their visible card exposes waiting identity rather than a usable authorization control.");
 c.add("pending-work-and-identity-preserved",!!before&&!!after&&after.id===before.id&&after.kind===before.kind&&after.sourceRunId===before.sourceRunId&&after.payload?.serviceSlug===before.payload.serviceSlug&&after.addresseeUserId===before.addresseeUserId&&after.status==="pending"&&!after.result&&!after.resolvedByUserId&&!after.resolvedByAgentId&&o.state.relatedStatusUnchanged===true&&o.state.alexSourceRunCount===1&&o.connections.length===0&&o.state.canonicalSourceDifferent===true,"Unauthorized responses neither release the pending task nor create a connection, readdress the card, or schedule another Alex-source run.");
 c.add("truthful-no-impersonation-guidance",truthfulAlexBoundary(o.reply),"Chat explains that Alex must authorize their own request, without claiming completion or exposing another account.");return c.result();
}
export const wrongResolverExternalCases=[definition("connection-setup.wrong-person-resolves",async ctx=>{
 const browser=ctx.input.page.context().browser(),secrets=ctx.input.privateSecrets;if(!browser||!secrets)throw new Error("Wrong connection resolver needs two real authenticated people and private session ownership");
 const session=await ctx.input.api.get<{user:{id:string}}>("/api/auth/get-session");if(!session.user?.id||session.user.id==="local-board")throw new Error("Actual signed-in other member is required");
 const alex=await createAuthenticatedPerson({api:ctx.input.api,browser,secrets,name:"Alex"});people.set(ctx,alex);
 try{
  await enrollPrerequisitePerson(ctx, alex);
  for(const scope of [{scopeType:"company",scopeId:ctx.input.fixtures.company.id},{scopeType:"agent",scopeId:ctx.input.fixtures.agent.id}])await ctx.input.api.post(`${root(ctx)}/budgets/policies`,{...scope,amount:500,hardStopEnabled:true,isActive:true,unpricedUsagePolicy:"allow"});
  if((await ctx.input.api.get<{connections:unknown[]}>(`${root(ctx)}/tools/connections`)).connections.length)throw new Error("Wrong resolver requires no existing Notion account");
  const response=await alex.request(`${root(ctx)}/issues`,"POST",{title:"Alex's launch notes",status:"todo",assigneeAgentId:ctx.input.fixtures.agent.id,description:"Read my Notion and summarize the current launch notes. I have not connected my Notion account yet."});
  if(!response.ok){await response.body?.cancel();throw new Error("Alex could not create the actual related task through their authorized public identity");}const related=await response.json() as Entity;
  const prepared=await pollUntil({label:"actual admitted Alex connection request",deadlineAt:Date.now()+150000,intervalMs:1000,load:async()=>({cards:await ctx.input.api.get<ConnectionIntentInteraction[]>(`/api/issues/${related.id}/interactions`),runs:await ctx.allRuns()}),accept:value=>value.runs.length===1&&value.runs[0]?.status==="succeeded"&&value.cards.some(card=>card.kind==="connection_intent"&&card.payload.serviceSlug==="notion"&&card.status==="pending"&&card.addresseeUserId===alex.id),reject:value=>value.runs.length>1||value.runs.some(run=>["failed","cancelled","timed_out"].includes(run.status))?"Alex's prerequisite did not produce one successful native request":undefined});
  const cards=prepared.cards.filter(card=>card.kind==="connection_intent"&&card.payload.serviceSlug==="notion");if(cards.length!==1)throw new Error("Alex's prerequisite produced ambiguous requests");const original=cards[0]!;
  const before=await ctx.input.api.get<Entity>(`/api/issues/${related.id}`),chat=await openStandingChat(ctx);
  await ctx.input.api.patch(`/api/issues/${chat.id}`,{description:`Alex has a pending Notion connection request on related task ${before.identifier??before.id}. The current person can view that task as another company member.`});
  return {original,related:before,alexId:alex.id,otherId:session.user.id};
 }catch(error){await alex.dispose();people.delete(ctx);throw error;}
},gradeWrongResolver,{
 authentication:"human-session",expectedRunCount:2,minimumRunCount:2,expectedHumanMessageCount:1,attemptTimeoutMs:540000,
 sourceFiles:["chat-catalog-domains/external-wrong-resolver.ts","chat-catalog-domains/identity-auth.ts","chat-catalog-domains/identity-private-browser.ts","chat-catalog-domains/identity-private-browser-worker.ts","chat-catalog-domains/identity-wizard.ts","chat-catalog-domains/identity-support.ts","chat-catalog-domains/external-support.ts","chat-catalog-domains/internal-support.ts","../../server/src/routes/connection-intents.ts","../../server/src/services/connection-intents.ts","chat-scenarios/connection-setup.yaml"],
 async act(ctx,state){
  await waitForReply({...ctx,allRuns:async()=>(await ctx.allRuns()).filter(run=>run.contextSnapshot?.issueId===ctx.issue()?.id)});
  const original=state.original as ConnectionIntentInteraction,related=state.related as Entity,source=ctx.input.page.url();
  const current=await ctx.input.api.get<{user:{id:string}}>("/api/auth/get-session");state.otherSessionConfirmed=current.user.id===state.otherId&&current.user.id!==state.alexId;
  await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${related.id}`,{waitUntil:"domcontentloaded"});await expect(ctx.input.page.getByText(related.title!,{exact:true}).first()).toBeVisible();state.relatedVisible=true;
  await expect(ctx.input.page.getByTestId("connection-authorization-waiting").filter({hasText:"Waiting for Alex"})).toBeVisible();state.waitingVisible=true;
  state.connectControlAbsent=await ctx.input.page.getByRole("button",{name:/^Connect (?:Notion|account)$/}).count()===0;
  const denied:Record<string,number>={};
  for(const [name,suffix,method,data] of [["setupOptions","setup-options","GET",undefined],["phase","phase","POST",{phase:"authorizing"}],["complete","complete","POST",{connectionId:randomUUID()}],["decline","decline","POST",{}]] as const){
   const response=await ctx.input.page.context().request.fetch(`${ctx.input.api.baseURL}/api/connection-intents/${original.id}/${suffix}`,{method,headers:{Origin:ctx.input.api.baseURL},...data?{data}:{}});denied[name]=response.status();await response.dispose();
  }
  state.denied=denied;await ctx.input.page.goto(source,{waitUntil:"domcontentloaded"});
 },
 async observe(ctx,state){
  const related=state.related as Entity,original=state.original as ConnectionIntentInteraction,o=await observeExternal(ctx,state),cards=await ctx.input.api.get<ConnectionIntentInteraction[]>(`/api/issues/${related.id}/interactions`),after=cards.find(card=>card.id===original.id),task=await ctx.input.api.get<Entity>(`/api/issues/${related.id}`);
  state.after=after;state.relatedStatusUnchanged=task.status===related.status&&task.assigneeAgentId===related.assigneeAgentId;state.alexSourceRunCount=o.runs.filter(run=>run.contextSnapshot?.issueId===related.id).length;state.canonicalSourceDifferent=ctx.issue()?.id!==related.id;
  return {...o,state};
 },
 async verifyResult(ctx,_state,value){await verifyRenderedReply(ctx,value);const o=externalObservation(value)!;const source=ctx.input.page.url();try{await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${(o.state.related as Entity).id}`,{waitUntil:"domcontentloaded"});await expect(ctx.input.page.getByTestId("connection-authorization-waiting").filter({hasText:"Waiting for Alex"})).toBeVisible();}finally{await ctx.input.page.goto(source,{waitUntil:"domcontentloaded"});}},
 async cleanup(ctx){try{await people.get(ctx)?.dispose();}finally{people.delete(ctx);}},
})];
