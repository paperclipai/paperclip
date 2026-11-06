import { pollUntil } from "./api.js";
import { validateChatCatalogGrade } from "./chat-catalog-contract.js";
import type { ChatConversation, ChatEndpoint, ExternalChannelBindingSummary } from "../../packages/shared/src/types/chat-channels.js";
import type { IssueComment } from "../../packages/shared/src/types/issue.js";
import type { ChatCatalogCase, ChatCatalogContext, ChatSlackIngressReceipt } from "./chat-catalog-contract.js";
import type { ChatRun } from "./chat-flow.js";
export const nativeSlackScenarioIds = ["chat-channels.reply-in-thread", "chat-channels.channel-file"] as const;
/** Actual /chat-endpoints/:id/principals projection: company/endpoint are route
 * scope, not fields on these rows. Raw provider identity is checked separately. */
interface SlackPrincipalLink { principalId:string;externalDetail?:string|null;paperclipUserId?:string|null;status:string }
interface SlackSenderIdentity {userId:string;workspaceId:string;handle:string}
export async function verifySelectedSlackSender(ctx:ChatCatalogContext,receipt:ChatSlackIngressReceipt,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<SlackSenderIdentity>{
 const config=ctx.input.privateInputs?.configuration("external-provider") as {providers?:{slack?:{disposable?:boolean;resourceIds?:string[];prerequisites?:Record<string,string>}}}|undefined,binding=config?.providers?.slack,p=binding?.prerequisites;
 if(binding?.disposable!==true||!p||![receipt.provider.workspaceId,receipt.provider.channelId,receipt.provider.senderUserId].every(id=>binding.resourceIds?.includes(id))||p.workspaceId!==receipt.provider.workspaceId||p.channelId!==receipt.provider.channelId||p.senderUserId!==receipt.provider.senderUserId||!/^PAPERCLIP_CHAT_EVAL_[A-Z0-9_]+$/.test(p.senderTokenEnv??""))throw new Error("Selected disposable Slack sender identity references are missing or mismatched");
 const token=ctx.input.privateInputs?.read(p.senderTokenEnv!);if(!token||!ctx.input.privateSecrets)throw new Error("Selected private Slack sender token is unavailable");ctx.input.privateSecrets.push(token);
 async function call(method:"auth.test"|"users.info",body:Record<string,string>){
  try{const response=await fetcher(`https://slack.com/api/${method}`,{method:"POST",redirect:"error",signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),headers:{authorization:`Bearer ${token}`,"content-type":"application/json; charset=utf-8"},body:JSON.stringify(body)});if(!response.ok){await response.body?.cancel();throw new Error();}const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>262144)throw new Error();const result=JSON.parse(bytes.toString("utf8"));if(result.ok!==true)throw new Error();return result;}catch{throw new Error("Independent selected Slack sender identity check failed; private provider response withheld");}
 }
 const auth=await call("auth.test",{});if(auth.team_id!==receipt.provider.workspaceId||auth.user_id!==receipt.provider.senderUserId||auth.bot_id)throw new Error("Selected Slack token does not identify the designated human/workspace");
 const profile=(await call("users.info",{user:receipt.provider.senderUserId})).user;
 if(!profile||profile.id!==auth.user_id||profile.team_id!==auth.team_id||profile.is_bot||profile.deleted||typeof profile.name!=="string"||!profile.name||profile.name.length>80||/[\r\n]/.test(profile.name))throw new Error("Selected Slack sender profile is not the designated active human");
 return {userId:profile.id,workspaceId:profile.team_id,handle:profile.name};
}
export function validSlackIngressDeclaration(c: Pick<ChatCatalogCase, "scenarioId" | "slackIngress" | "expectedRunCount" | "minimumRunCount" | "expectedHumanMessageCount" | "setupHumanMessageCount" | "queryBindings" | "queryAttachments" | "queryOutcome" | "companionSurface" | "runPolicy" | "turnTimeoutMs" | "attemptTimeoutMs"> & { journeyKind?: string }) {
  return (nativeSlackScenarioIds as readonly string[]).includes(c.scenarioId) && c.journeyKind === "native-slack-thread"
    && c.slackIngress?.kind === "native-slack-thread" && c.slackIngress.maximumProviderCalls === 20 && c.slackIngress.ingressTimeoutMs === 120000
    && Object.keys(c.slackIngress).sort().join(",") === (c.scenarioId === "chat-channels.reply-in-thread" ? "ingressTimeoutMs,kind,maximumProviderCalls,setupThread" : "ingressTimeoutMs,kind,maximumProviderCalls")
    && c.turnTimeoutMs === 120000
    && (c.scenarioId === "chat-channels.channel-file" ? !c.slackIngress.setupThread && c.attemptTimeoutMs === 900000 && c.expectedRunCount === 6 && c.minimumRunCount === 2 && c.expectedHumanMessageCount === 2
      : c.attemptTimeoutMs === 600000 && c.expectedRunCount === 4 && c.minimumRunCount === 2 && c.expectedHumanMessageCount === 1 && c.slackIngress.setupThread === "same-agent-distractor") && (c.setupHumanMessageCount ?? 0) === 0
    && !c.queryBindings?.length && !c.queryAttachments?.length && !c.queryOutcome && !c.companionSurface && !c.runPolicy;
}
export function slackIngressReceiptMatches(input: { receipt: ChatSlackIngressReceipt; query: string; companyId: string; agentId: string;
  endpoint: ChatEndpoint; conversation: ChatConversation | undefined; binding: ExternalChannelBindingSummary; comment: IssueComment | undefined; links: SlackPrincipalLink[];linksEndpointId:string;senderIdentity:SlackSenderIdentity }) {
  const { receipt: r, endpoint: e, conversation: c, binding: b, comment } = input;
  return !!r && r.query === input.query && Number.isSafeInteger(r.providerCalls) && r.providerCalls >= 1 && r.providerCalls <= 20
    && /^T[A-Z0-9]+$/.test(r.provider.workspaceId) && /^[CG][A-Z0-9]+$/.test(r.provider.channelId) && /^[UW][A-Z0-9]+$/.test(r.provider.senderUserId)
    && /^\d+\.\d{6}$/.test(r.provider.threadId) && /^\d+\.\d{6}$/.test(r.provider.canonicalMessageId)
    && e.id === r.endpointId && e.companyId === input.companyId && e.assignedAgentId === input.agentId && e.provider === "slack" && e.providerAccountId === r.provider.workspaceId
    && !!c && c.id === r.conversationId && c.endpointId === e.id && c.companyId === input.companyId && c.issueId === r.issueId
    && c.externalThreadId === `slack:${r.provider.channelId}:${r.provider.threadId}` && c.externalConversationId === `slack:${r.provider.channelId}`
    && b.provider === "slack" && b.endpointId === e.id && b.conversationId === c.id && b.assignedAgentLocked === true
    && !!comment && comment.id === r.humanCommentId && comment.issueId === r.issueId && comment.companyId === input.companyId
    && comment.body === input.query && !comment.authorAgentId && comment.authorUserId === r.linkedPaperclipUserId && comment.metadata?.sourceChannel === "slack"
    && Array.isArray(comment.metadata.sections) && comment.metadata.sections.some(section => section.rows.some(row => row.type === "key_value" && row.label === "Provider ID" && row.value === r.provider.senderUserId))
    && input.linksEndpointId===e.id&&input.senderIdentity.userId===r.provider.senderUserId&&input.senderIdentity.workspaceId===r.provider.workspaceId
    && input.links.some(link => typeof link.principalId==="string"&&!!link.principalId&&link.externalDetail===`@${input.senderIdentity.handle}`&&link.status === "linked" && link.paperclipUserId === r.linkedPaperclipUserId);
}
export function sameSlackThreadNewMessage(first: ChatSlackIngressReceipt, next: ChatSlackIngressReceipt) {
  return next.query === first.query && next.endpointId === first.endpointId && next.conversationId === first.conversationId && next.issueId === first.issueId
    && next.linkedPaperclipUserId === first.linkedPaperclipUserId && next.humanCommentId !== first.humanCommentId
    && next.provider.workspaceId === first.provider.workspaceId && next.provider.channelId === first.provider.channelId && next.provider.threadId === first.provider.threadId
    && next.provider.senderUserId === first.provider.senderUserId && next.provider.canonicalMessageId !== first.provider.canonicalMessageId;
}
export const slackOtherThreadSetupQuery = "Please summarize the current company project status in this separate discussion.";
async function independentlyBoundSlackReceipt(ctx:ChatCatalogContext,receipt:ChatSlackIngressReceipt,query:string,signal:AbortSignal){
  for(const id of [receipt?.endpointId,receipt?.conversationId,receipt?.issueId,receipt?.humanCommentId])if(typeof id!=="string"||!/^[a-zA-Z0-9-]{1,100}$/.test(id))throw new Error("Invalid Slack product receipt identity");
  const api = ctx.input.api;
  const endpoint = await api.get<ChatEndpoint>(`/api/chat-endpoints/${receipt.endpointId}`);
  const conversations = await api.get<ChatConversation[]>(`/api/chat-endpoints/${receipt.endpointId}/conversations`);
  const binding = await api.get<ExternalChannelBindingSummary>(`/api/issues/${receipt.issueId}/chat-binding`);
  const comments = await api.get<IssueComment[]>(`/api/issues/${receipt.issueId}/comments?order=asc`);
  const links = await api.get<SlackPrincipalLink[]>(`/api/chat-endpoints/${receipt.endpointId}/principals`);
  const senderIdentity=await verifySelectedSlackSender(ctx,receipt,signal);
  const matched = slackIngressReceiptMatches({ receipt, query: query, companyId: ctx.input.fixtures.company.id, agentId: ctx.input.fixtures.agent.id,
    endpoint, conversation: conversations.find(row => row.id === receipt.conversationId), binding, comment: comments.find(row => row.id === receipt.humanCommentId), links,linksEndpointId:receipt.endpointId,senderIdentity })&&receipt.providerCalls+2<=20;
  return matched;
}
export function slackOtherThreadBoundaryMatches(input:{receipt:ChatSlackIngressReceipt & {runId:string};runs:ChatRun[];companyId:string;agentId:string;sourceIssueId?:string}){
 const {receipt:r,runs}=input;
 return r.query===slackOtherThreadSetupQuery&&runs.length===1&&runs[0]?.id===r.runId&&runs[0].companyId===input.companyId&&runs[0].agentId===input.agentId&&runs[0].runtimeMode==="native"&&runs[0].status==="succeeded"&&runs[0].contextSnapshot?.issueId===r.issueId&&(!input.sourceIssueId||input.sourceIssueId!==r.issueId);
}
/** One exact precondition exchange on another actual Slack source. Its human
 * comment never enters the canonical source's setup-human history. */
export async function prepareNativeSlackOtherThread(ctx:ChatCatalogContext,c:ChatCatalogCase,state:Record<string,unknown>,deadlineAt:number){
 if(c.scenarioId!=="chat-channels.reply-in-thread"||c.slackIngress?.setupThread!=="same-agent-distractor"||!validSlackIngressDeclaration(c)||!c.dispatchSlackOtherThread||ctx.issue()||(await ctx.allRuns()).length)throw new Error("Invalid or nonempty declared Slack other-thread setup");
 const signal=AbortSignal.timeout(Math.min(120000,deadlineAt-Date.now()));
 let listener:(()=>void)|undefined;
 const timeout=new Promise<never>((_resolve,reject)=>{listener=()=>reject(new Error("Slack other-thread setup exceeded its declared deadline"));signal.addEventListener("abort",listener,{once:true});});
 let receipt:ChatSlackIngressReceipt & {runId:string};
 try{receipt=await Promise.race([c.dispatchSlackOtherThread(ctx,state,{query:slackOtherThreadSetupQuery,signal}),timeout]);}finally{if(listener)signal.removeEventListener("abort",listener);}

 const matched=await independentlyBoundSlackReceipt(ctx,receipt,slackOtherThreadSetupQuery,signal)&&slackOtherThreadBoundaryMatches({receipt,runs:await ctx.allRuns(),companyId:ctx.input.fixtures.company.id,agentId:ctx.input.fixtures.agent.id});
 await ctx.input.evidence("chat-slack-other-thread-setup.json",{receipt,matched,canonicalSourceHumanCount:0,includedInTotalNativeBound:true});
 if(!matched||signal.aborted)throw new Error("Actual Slack other-thread setup did not prove its sole linked-human/company/source/native execution");
 state.slackOtherThreadSetupReceipt=receipt;
}
/** Provider transport belongs to the selected domain; public product identity
 * and exact canonical persistence are independently checked here. */
export async function dispatchNativeSlackIngress(ctx: ChatCatalogContext, c: ChatCatalogCase, state: Record<string, unknown>, deadlineAt: number, phase: "canonical" | "unsupported-file" = "canonical") {
  if (!validSlackIngressDeclaration(c) || !c.dispatchSlackQuery || c.act || !ctx.selectSlackSource) throw new Error("Invalid actual native Slack ingress contract");
  const driver = phase === "canonical" ? c.dispatchSlackQuery : c.scenarioId === "chat-channels.channel-file" ? c.dispatchSlackUnsupportedFile : undefined;
  if (!driver) throw new Error("Undeclared Slack ingress phase");
  const remaining = Math.min(c.slackIngress!.ingressTimeoutMs, deadlineAt - Date.now());
  if (remaining <= 0) throw new Error("Slack setup exhausted the actual attempt deadline");
  const signal = AbortSignal.timeout(remaining); let listener: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => { listener = () => reject(new Error("Actual Slack ingress exceeded its declared deadline")); signal.addEventListener("abort", listener, { once: true }); });
  let receipt: ChatSlackIngressReceipt;
  try { receipt = await Promise.race([driver(ctx, state, { query: ctx.scenario.query, signal }), interrupted]); }
  finally { if (listener) signal.removeEventListener("abort", listener); }
  // Fail before interpreting identifiers as API routes.
  for (const id of [receipt?.endpointId, receipt?.conversationId, receipt?.issueId, receipt?.humanCommentId]) if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("Invalid Slack product receipt identity");
  const matched = await independentlyBoundSlackReceipt(ctx,receipt,ctx.scenario.query,signal);
  const first = state.slackIngressReceipt as ChatSlackIngressReceipt | undefined;
  const sameThreadNewMessage = phase === "canonical" || !!first && sameSlackThreadNewMessage(first, receipt);
  await ctx.input.evidence(`chat-slack-ingress-${phase}-binding.json`, { matched, sameThreadNewMessage, phase, canonicalQuery: ctx.scenario.query, receipt, assignedAgentId: ctx.input.fixtures.agent.id,
    linkedIdentityConfirmed: matched, independentProviderIdentityCalls:2,privateProviderConfiguration: "withheld", providerSenderMapping: "private official human token/profile plus scoped public principal and actual comment" });
  const other=state.slackOtherThreadSetupReceipt as ChatSlackIngressReceipt|undefined;
  const otherThreadDistinct=ctx.scenario.id!=="chat-channels.reply-in-thread"||!!other&&other.endpointId===receipt.endpointId&&other.issueId!==receipt.issueId&&other.conversationId!==receipt.conversationId&&other.provider.threadId!==receipt.provider.threadId&&other.provider.workspaceId===receipt.provider.workspaceId&&other.provider.channelId===receipt.provider.channelId&&other.provider.senderUserId===receipt.provider.senderUserId&&other.linkedPaperclipUserId===receipt.linkedPaperclipUserId;
  if (signal.aborted || !matched || !sameThreadNewMessage || !otherThreadDistinct) throw new Error("Slack ingress did not independently bind exact canonical human, linked identity, company and provider thread");
  await ctx.selectSlackSource(receipt.issueId);
  return receipt;
}
export async function completeNativeSlackFileConditional(ctx: ChatCatalogContext, c: ChatCatalogCase, state: Record<string, unknown>, deadlineAt: number) {
  if (c.scenarioId !== "chat-channels.channel-file" || !c.verifySlackSupportedTransfer || !c.dispatchSlackUnsupportedFile) throw new Error("Missing actual Slack file conditional");
  const first = await pollUntil({ label: "real supported Slack transfer before unsupported upload", deadlineAt, intervalMs: 1000,
    load: async () => { const grade = validateChatCatalogGrade(await c.verifySlackSupportedTransfer!(ctx, state)); const runs = await ctx.allRuns(); return { grade, runs }; },
    accept: value => value.grade.passed && value.runs.length >= 1 && value.runs.length <= 3 && value.runs.every(run => run.runtimeMode === "native" && run.companyId === ctx.input.fixtures.company.id && run.status === "succeeded") && slackNativeRunCheck(ctx, value.runs).passed });
  state.slackSupportedTransferRunIds = first.runs.map(run => run.id);
  await ctx.input.evidence("chat-slack-supported-transfer-checkpoint.json", { grade: first.grade, runIds: state.slackSupportedTransferRunIds, beforeUnsupportedUpload: true });
  state.slackUnsupportedIngressReceipt = await dispatchNativeSlackIngress(ctx, c, state, deadlineAt, "unsupported-file");
}
export function slackNativeRunCheck(ctx: ChatCatalogContext, runs: ChatRun[], state?: Record<string, unknown>) {
  const source = ctx.issue();
  const sourceRuns = runs.filter(run => run.contextSnapshot?.issueId === source?.id);
  const other=state?.slackOtherThreadSetupReceipt as (ChatSlackIngressReceipt & {runId:string})|undefined;
  const otherStillBound=!other||slackOtherThreadBoundaryMatches({receipt:other,runs:runs.filter(run=>run.contextSnapshot?.issueId===other.issueId),companyId:ctx.input.fixtures.company.id,agentId:ctx.input.fixtures.agent.id,sourceIssueId:source?.id});
  return { id: "catalog-real-slack-source-native", passed: otherStillBound && !!source && source.companyId === ctx.input.fixtures.company.id && source.assigneeAgentId === ctx.input.fixtures.agent.id
    && sourceRuns.length >= 1 && sourceRuns.every(run => run.agentId === ctx.input.fixtures.agent.id && run.runtimeMode === "native" && run.status === "succeeded")
    && runs.every(run => typeof run.contextSnapshot?.issueId === "string")
    && (!state?.slackUnsupportedIngressReceipt || Array.isArray(state.slackSupportedTransferRunIds) && sourceRuns.some(run => !(state.slackSupportedTransferRunIds as unknown[]).includes(run.id))),
    detail: "The actual inbound source has a genuine assigned-agent native admission; fast responses cannot substitute. The independent case oracle binds every downstream task and automatic source follow-up to this provider exchange." };
}
