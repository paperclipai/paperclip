import { describe, expect, it } from "vitest";
import { loadChatCatalogImplementation, type ChatCatalogDescriptor } from "./chat-catalog-registry.js";
import { sameSlackThreadNewMessage, slackIngressReceiptMatches, validSlackIngressDeclaration, slackNativeRunCheck, verifySelectedSlackSender, slackOtherThreadBoundaryMatches, slackOtherThreadSetupQuery } from "./chat-slack-ingress.js";
import type { ChatCatalogContext, ChatSlackIngressReceipt } from "./chat-catalog-contract.js";
import type { ChatConversation, ChatEndpoint, ExternalChannelBindingSummary } from "../../packages/shared/src/types/chat-channels.js";
import type { IssueComment } from "../../packages/shared/src/types/issue.js";
const query = "What happened in this thread?";
const metadata = { scenarioId: "chat-channels.reply-in-thread", journeyKind: "native-slack-thread", slackIngress: { kind: "native-slack-thread" as const, maximumProviderCalls: 20 as const, ingressTimeoutMs: 120000 as const, setupThread:"same-agent-distractor" as const }, expectedRunCount: 4, minimumRunCount: 2, expectedHumanMessageCount: 1, turnTimeoutMs: 120000, attemptTimeoutMs: 600000 };
function input() {
  const receipt: ChatSlackIngressReceipt = { query, endpointId: "endpoint", conversationId: "conversation", issueId: "issue", humanCommentId: "comment", linkedPaperclipUserId: "person", providerCalls: 2, provider: { workspaceId: "T123", channelId: "C123", threadId: "1234567890.123456", canonicalMessageId: "1234567891.123456", senderUserId: "U123" } };
  return { receipt, query, companyId: "company", agentId: "agent", endpoint: { id: "endpoint", companyId: "company", assignedAgentId: "agent", provider: "slack", providerAccountId: "T123" } as ChatEndpoint,
    conversation: { id: "conversation", companyId: "company", endpointId: "endpoint", issueId: "issue", externalConversationId: "slack:C123", externalThreadId: "slack:C123:1234567890.123456" } as ChatConversation,
    binding: { endpointId: "endpoint", conversationId: "conversation", provider: "slack", assignedAgentLocked: true } as ExternalChannelBindingSummary,
    comment: { id: "comment", companyId: "company", issueId: "issue", authorAgentId: null, authorUserId: "person", body: query, metadata: { version: 1, sourceChannel: "slack", sections: [{ title: "Slack sender", rows: [{ type: "key_value", label: "Provider ID", value: "U123" }] }] } } as IssueComment,
    linksEndpointId:"endpoint",senderIdentity:{workspaceId:"T123",userId:"U123",handle:"fixture.sender"},links: [{ principalId:"principal",externalDetail:"@fixture.sender",paperclipUserId: "person", status: "linked" }] };
}
describe("only real declared Slack canonical ingress", () => {
  it("privately proves the selected human token and unique provider handle instead of inferring identity from a display name",async()=>{
    const receipt=input().receipt,secrets:string[]=[],calls:string[]=[];
    const ctx={input:{privateSecrets:secrets,privateInputs:{configuration:()=>({providers:{slack:{disposable:true,resourceIds:["T123","C123","U123"],prerequisites:{workspaceId:"T123",channelId:"C123",senderUserId:"U123",senderTokenEnv:"PAPERCLIP_CHAT_EVAL_SLACK_SENDER"}}}}),read:()=>"synthetic-private-token"}}} as unknown as ChatCatalogContext;
    let actualUser="U123";
    const fetcher=(async(url,options)=>{calls.push(String(url));expect((options?.headers as Record<string,string>).authorization).toBe("Bearer synthetic-private-token");return new Response(JSON.stringify(String(url).endsWith("auth.test")?{ok:true,user_id:actualUser,team_id:"T123"}:{ok:true,user:{id:actualUser,team_id:"T123",name:"fixture.sender",is_bot:false}}));}) as typeof fetch;
    await expect(verifySelectedSlackSender(ctx,receipt,AbortSignal.timeout(1000),fetcher)).resolves.toEqual({userId:"U123",workspaceId:"T123",handle:"fixture.sender"});
    expect(calls).toEqual(["https://slack.com/api/auth.test","https://slack.com/api/users.info"]);expect(secrets).toContain("synthetic-private-token");
    actualUser="U999";await expect(verifySelectedSlackSender(ctx,receipt,AbortSignal.timeout(1000),fetcher)).rejects.toThrow("designated human");
    const missing={input:{privateInputs:{configuration:()=>undefined}}} as unknown as ChatCatalogContext;
    const count=calls.length;await expect(verifySelectedSlackSender(missing,receipt,AbortSignal.timeout(1000),fetcher)).rejects.toThrow("references");expect(calls).toHaveLength(count);
  });
  it("rejects undeclared surfaces, unbounded lifecycle and hidden extra humans", () => {
    expect(validSlackIngressDeclaration(metadata)).toBe(true);
    expect(validSlackIngressDeclaration({ ...metadata, scenarioId: "tasks.create-backlog" })).toBe(false);
    expect(validSlackIngressDeclaration({ ...metadata, journeyKind: "agent-chat" })).toBe(false);
    expect(validSlackIngressDeclaration({ ...metadata, minimumRunCount: 0 })).toBe(false);
    expect(validSlackIngressDeclaration({ ...metadata, expectedHumanMessageCount: 2 })).toBe(false);
    expect(validSlackIngressDeclaration({ ...metadata, queryBindings: [{ catalogToken: "token", stateKey: "issue", resourceKind: "issue", valueField: "identifier" }] })).toBe(false);
  });
  it("cross-checks actual exact canonical comment, linked human, endpoint, company and provider thread DTOs", () => {
    expect(slackIngressReceiptMatches(input())).toBe(true);
    for (const mutate of [
      (v: ReturnType<typeof input>) => { v.comment.body += " Try harder"; },
      (v: ReturnType<typeof input>) => { v.comment.authorAgentId = "agent"; },
      (v: ReturnType<typeof input>) => { v.receipt.provider.senderUserId = "U999"; },
      (v: ReturnType<typeof input>) => { v.links[0]!.status = "revoked"; },
      (v: ReturnType<typeof input>) => { v.linksEndpointId="another-endpoint"; },
      (v: ReturnType<typeof input>) => { v.links[0]!.externalDetail="@another.principal"; },
      (v: ReturnType<typeof input>) => { v.links[0]!.principalId=""; },
      (v: ReturnType<typeof input>) => { v.senderIdentity.userId="U999"; },
      (v: ReturnType<typeof input>) => { v.senderIdentity.workspaceId="T999"; },
      (v: ReturnType<typeof input>) => { v.conversation.externalThreadId = "slack:C123:9999999999.123456"; },
      (v: ReturnType<typeof input>) => { v.conversation.externalConversationId = "C123"; },
      (v: ReturnType<typeof input>) => { v.endpoint.companyId = "foreign"; },
      (v: ReturnType<typeof input>) => { v.binding.conversationId = "another"; },
      (v: ReturnType<typeof input>) => { v.receipt.providerCalls = 21; },
    ]) { const value = input(); mutate(value); expect(slackIngressReceiptMatches(value)).toBe(false); }
  });
  it("requires the selected actual provider driver and rejects hidden scripted followups", async () => {
    const descriptor: ChatCatalogDescriptor = { ...metadata, journeyKind: "native-slack-thread", modulePath: "./chat-catalog-domains/external-slack.js", exportName: "slackCases", sourceFiles: ["chat-slack-ingress.ts"], oracleVersion: "controls", turnTimeoutMs: 120000, attemptTimeoutMs: 600000 };
    const implementation = { ...descriptor, setup: async () => ({}), observe: async () => ({}), grade: () => ({ passed: false, checks: [{ id: "unobserved", passed: false, detail: "Not an observed outcome" }] }), verifyResult: async () => {} };
    await expect(loadChatCatalogImplementation(descriptor, async () => ({ slackCases: [implementation] }))).rejects.toThrow("actual Slack ingress");
    const actual = { ...implementation, dispatchSlackQuery: async () => input().receipt, dispatchSlackOtherThread:async()=>({...input().receipt,runId:"setup-native"}) };
    await expect(loadChatCatalogImplementation(descriptor, async () => ({ slackCases: [actual] }))).resolves.toBe(actual);
    await expect(loadChatCatalogImplementation(descriptor, async () => ({ slackCases: [{ ...actual, act: async () => {} }] }))).rejects.toThrow("actual Slack ingress");
    const fileDescriptor: ChatCatalogDescriptor = { ...descriptor, scenarioId: "chat-channels.channel-file", slackIngress:{kind:"native-slack-thread" as const,maximumProviderCalls:20 as const,ingressTimeoutMs:120000 as const}, expectedRunCount: 6, minimumRunCount: 2, expectedHumanMessageCount: 2, attemptTimeoutMs: 900000 };
    const file = { ...actual, ...fileDescriptor,dispatchSlackOtherThread:undefined };
    await expect(loadChatCatalogImplementation(fileDescriptor, async () => ({ slackCases: [file] }))).rejects.toThrow("supported and unsupported transfer phases");
    const completeFile = { ...file, verifySlackSupportedTransfer: async () => ({ passed: true, checks: [{ id: "actual-transfer", passed: true, detail: "Independent phase-specific byte/egress evidence" }] }), dispatchSlackUnsupportedFile: async () => input().receipt };
    await expect(loadChatCatalogImplementation(fileDescriptor, async () => ({ slackCases: [completeFile] }))).resolves.toBe(completeFile);

  });
  it("requires a separate same-thread canonical upload and declared two-phase bounds for the file conditional", () => {
    const file = { ...metadata, scenarioId: "chat-channels.channel-file", slackIngress:{kind:"native-slack-thread" as const,maximumProviderCalls:20 as const,ingressTimeoutMs:120000 as const}, expectedRunCount: 6, minimumRunCount: 2, expectedHumanMessageCount: 2, attemptTimeoutMs: 900000 };
    expect(validSlackIngressDeclaration(file)).toBe(true);
    expect(validSlackIngressDeclaration({ ...file, expectedHumanMessageCount: 1 })).toBe(false);
    expect(validSlackIngressDeclaration({ ...metadata, scenarioId: "chat-channels.channel-file" })).toBe(false);
    const first = input().receipt, next = structuredClone(first); next.humanCommentId = "second-comment"; next.provider.canonicalMessageId = "1234567892.123456";
    expect(sameSlackThreadNewMessage(first, next)).toBe(true);
    expect(sameSlackThreadNewMessage(first, first)).toBe(false);
    expect(sameSlackThreadNewMessage(first, { ...next, query: "Use a different hidden instruction" })).toBe(false);
    expect(sameSlackThreadNewMessage(first, { ...next, provider: { ...next.provider, threadId: "9999999999.123456" } })).toBe(false);
  });
  it("cannot qualify a fast response, wrong agent or unrelated native run as the source execution", () => {
    const ctx = { issue: () => ({ id: "issue", companyId: "company", assigneeAgentId: "agent" }), input: { fixtures: { company: { id: "company" }, agent: { id: "agent" } } } } as unknown as ChatCatalogContext;
    const run = { id: "run", companyId: "company", agentId: "agent", runtimeMode: "native", status: "succeeded", contextSnapshot: { issueId: "issue" } };
    expect(slackNativeRunCheck(ctx, [run]).passed).toBe(true);
    expect(slackNativeRunCheck(ctx, [run], { slackUnsupportedIngressReceipt: {}, slackSupportedTransferRunIds: [run.id] }).passed).toBe(false);
    expect(slackNativeRunCheck(ctx, [run, { ...run, id: "second-native" }], { slackUnsupportedIngressReceipt: {}, slackSupportedTransferRunIds: [run.id] }).passed).toBe(true);
    expect(slackNativeRunCheck(ctx, []).passed).toBe(false);
    expect(slackNativeRunCheck(ctx, [{ ...run, agentId: "other" }]).passed).toBe(false);
    expect(slackNativeRunCheck(ctx, [{ ...run, contextSnapshot: { issueId: "other" } }]).passed).toBe(false);
  });
});

it("binds exactly one other-source setup native without treating that source's human as canonical setup history",()=>{
 const receipt={...input().receipt,query:slackOtherThreadSetupQuery,runId:"setup-native"};
 const run={id:"setup-native",companyId:"company",agentId:"agent",runtimeMode:"native",status:"succeeded",contextSnapshot:{issueId:"issue"}};
 const value={receipt,runs:[run],companyId:"company",agentId:"agent"};
 expect(slackOtherThreadBoundaryMatches(value)).toBe(true);
 for(const wrong of [{...value,runs:[]},{...value,runs:[run,{...run,id:"unrelated"}]},{...value,runs:[{...run,contextSnapshot:{issueId:"other-source"}}]},{...value,runs:[{...run,agentId:"other-agent"}]},{...value,runs:[{...run,status:"running"}]},{...value,receipt:{...receipt,query:"Undeclared setup instruction"}},{...value,sourceIssueId:"issue"}])expect(slackOtherThreadBoundaryMatches(wrong)).toBe(false);
 expect(validSlackIngressDeclaration({...metadata,slackIngress:{kind:"native-slack-thread",maximumProviderCalls:20,ingressTimeoutMs:120000}})).toBe(false);
 expect(validSlackIngressDeclaration({...metadata,expectedRunCount:3})).toBe(false);
});
