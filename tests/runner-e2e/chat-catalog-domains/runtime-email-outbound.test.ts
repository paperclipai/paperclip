import { expect, it, vi } from "vitest";
import { gradeOutboundEmail, truthfulEmailOutcome, runtimeOutboundEmailCases, outboundOrdinaryHandoff, outboundThreadMatches } from "./runtime-email-outbound.js";
function valid() { return { companyId: "company", leadId: "ceo", scenarioId: "chat-channels.outbound-email", origin: "http://127.0.0.1:42123", reply: "", agents: [], tasks: [], activity: [], links: [], humanQueries: [], runs: [1,2,3,4,5].map(id => ({ id: String(id), agentId: "ceo", status: "succeeded" })), state: { actualHumanDraftBound: true, actualDraftTransmitted: true, exactAuthorizedRecipient: true, feedbackRequested: true, normalTaskBound: true, actualNativeSendBound: true, nativeLedgerCausal: true, independentProviderCount: 1, originalProviderReceiptMatched: true, authenticDuplicateBound: true, duplicateReleased: true, finalIndependentProviderCount: 1, oneSavedPublication: true, actualThreadLinked: true, factualReplyBound: true, factualReply: "The provider accepted the original launch email; its conversation and message receipt are saved with the task. Recipient delivery remains unconfirmed.", actualOutcome: "sent" } }; }
it("accepts actual authorized draft, delegated native send, authentic duplicate and one physical provider message", () => expect(gradeOutboundEmail(valid()).passed).toBe(true));
it("accepts substantive natural outcome paraphrases without requiring a fixed URL or wording", () => { const o = valid(); o.state.factualReply = "Your launch draft was sent for review and the original provider message is recorded. I cannot confirm whether it was delivered."; expect(gradeOutboundEmail(o).passed).toBe(true); });
it("rejects inaccessible/wrong draft, wrong recipient and an acknowledgement without task-native send", () => { for (const field of ["actualDraftTransmitted", "exactAuthorizedRecipient", "actualNativeSendBound", "nativeLedgerCausal"]) { const o = valid(); (o.state as Record<string, unknown>)[field] = false; expect(gradeOutboundEmail(o).passed).toBe(false); } });
it("rejects forged/unobserved duplicate proof or an extra physical provider message", () => { const o = valid(); o.state.authenticDuplicateBound = false; expect(gradeOutboundEmail(o).passed).toBe(false); const p = valid(); p.state.finalIndependentProviderCount = 2; expect(gradeOutboundEmail(p).passed).toBe(false); });
it("distinguishes actual recipient delivery from accepted send and requires the correct factual reply phase", () => { expect(truthfulEmailOutcome("It was sent and was delivered.", "sent")).toBe(false); expect(truthfulEmailOutcome("It was sent and was delivered.", "delivered")).toBe(true); const o = valid(); o.state.factualReplyBound = false; expect(gradeOutboundEmail(o).passed).toBe(false); });

const stopAfterObservation = new Error("stopped after the actual outbound observer load");
const poll = vi.hoisted(() => ({ observed: undefined as unknown }));
vi.mock("../api.js", async original => ({ ...await original<object>(), pollUntil: async (input: { load(): Promise<unknown> }) => {
  poll.observed = await input.load(); throw stopAfterObservation;
} }));
function actualHandoff() {
  const companyId = "company", sourceId = "chat", leadId = "ceo", canonicalId = "canonical";
  const work = { id: "work", companyId, parentId: null, workMode: "standard", assigneeAgentId: leadId, createdByAgentId: leadId,
    status: "done", originKind: "manual", originRunId: canonicalId, originId: "paperclip-runner:create-task:chat:launch", originFingerprint: "a".repeat(64) };
  const runs = [{ id: "setup", companyId, agentId: leadId, runtimeMode: "native", status: "succeeded", contextSnapshot: { issueId: sourceId, wakeCommentIds: ["draft"] } },
    { id: canonicalId, companyId, agentId: leadId, runtimeMode: "native", status: "succeeded", contextSnapshot: { issueId: sourceId, wakeCommentIds: ["canonical-human"] } },
    { id: "work-run", companyId, agentId: leadId, issueId: work.id, wakeupRequestId: "assignment-wakeup", runtimeMode: "native", status: "succeeded", contextSnapshot: { issueId: work.id, source: "paperclip_runner.create_task", wakeSource: "assignment", wakeReason: "issue_assigned", parentIssueId: null } },
    { id: "completion", companyId, agentId: leadId, runtimeMode: "native", status: "succeeded", contextSnapshot: { issueId: sourceId, chatCompletionUpdates: [{ id: work.id, status: "done" }] } }];
  const activity = [{ id: "created", companyId, entityId: work.id, entityType: "issue", action: "issue.created", actorType: "agent", actorId: leadId, agentId: leadId, runId: canonicalId, details: { source: "paperclip_runner_protocol" } }];
  const email = { id: "email-task", companyId, parentId: work.id, assigneeAgentId: leadId };
  const thread = { issueId: email.id, conversationId: "thread", endpoint: { id: "endpoint", companyId, assignedAgentId: leadId, status: "active" }, publications: [{ id: "publication", outcome: "sent" }] };
  return { companyId, sourceId, leadId, work, runs, activity, email, thread };
}
async function observeActualHandoff(input = actualHandoff()) {
  const reads: string[] = [];
  const api = { get: async (url: string) => { reads.push(url);
    if (url === `/api/companies/${input.companyId}/issues`) return [input.work, input.email];
    if (url === `/api/companies/${input.companyId}/activity?limit=1000`) return input.activity;
    if (url === `/api/issues/${input.sourceId}/comments?order=asc`) return [{ id: "draft", authorUserId: "person" }, { id: "canonical-human", authorUserId: "person" }];
    if (url === `/api/companies/${input.companyId}/email/tasks/${input.email.id}`) return input.thread;
    throw new Error(`Unexpected source-only public read: ${url}`);
  } };
  const ctx = { input: { api, fixtures: { company: { id: input.companyId }, agent: { id: input.leadId } } },
    refreshIssue: async () => undefined, allRuns: async () => input.runs };
  await expect(runtimeOutboundEmailCases[0]!.act!(ctx as never, { sourceId: input.sourceId, personId: "person", setupRunId: "setup", endpoint: { id: "endpoint" } })).rejects.toBe(stopAfterObservation);
  return { value: poll.observed as { work?: { id: string }; thread?: { issueId: string } }, reads };
}
it("actual outbound observer accepts a public standing-chat native handoff whose ordinary work has no parent", async () => {
  const { value } = await observeActualHandoff(); expect(value.work?.id).toBe("work"); expect(value.thread?.issueId).toBe("email-task");
});

function pureHandoff(input = actualHandoff()) { return outboundOrdinaryHandoff({ ...input, personId: "person", setupRunId: "setup", tasks: [input.work, input.email],
 comments: [{ id: "draft", authorUserId: "person" }, { id: "canonical-human", authorUserId: "person" }] }); }
it("rejects wrong originating actor, company, canonical run, idempotency and missing public audit evidence", () => {
 for (const mutate of [(v: ReturnType<typeof actualHandoff>) => { v.work.createdByAgentId = "foreign"; }, (v: ReturnType<typeof actualHandoff>) => { v.work.companyId = "foreign"; },
  (v: ReturnType<typeof actualHandoff>) => { v.work.originRunId = "setup"; }, (v: ReturnType<typeof actualHandoff>) => { v.work.originId = "paperclip-runner:create-task:other:launch"; }, (v: ReturnType<typeof actualHandoff>) => { v.work.originFingerprint = "unbound"; },
  (v: ReturnType<typeof actualHandoff>) => { v.activity[0]!.actorId = "foreign"; }, (v: ReturnType<typeof actualHandoff>) => { v.activity[0]!.runId = "setup"; }, (v: ReturnType<typeof actualHandoff>) => { v.activity[0]!.entityId = "other"; }, (v: ReturnType<typeof actualHandoff>) => { v.activity.length = 0; }]) {
  const input = actualHandoff(); mutate(input); expect(pureHandoff(input)).toBeUndefined();
 }
});
it("rejects wrong or absent actual native work admission and a different canonical human/source", () => {
 for (const mutate of [(v: ReturnType<typeof actualHandoff>) => { v.runs[2]!.agentId = "foreign"; }, (v: ReturnType<typeof actualHandoff>) => { v.runs[2]!.companyId = "foreign"; },
  (v: ReturnType<typeof actualHandoff>) => { v.runs[2]!.issueId = "other"; }, (v: ReturnType<typeof actualHandoff>) => { v.runs[2]!.wakeupRequestId = ""; }, (v: ReturnType<typeof actualHandoff>) => { v.runs[2]!.runtimeMode = "legacy"; },
  (v: ReturnType<typeof actualHandoff>) => { v.runs[2]!.contextSnapshot.wakeReason = "unrelated"; }, (v: ReturnType<typeof actualHandoff>) => { v.runs[1]!.contextSnapshot.issueId = "other"; },
  (v: ReturnType<typeof actualHandoff>) => { v.runs[1]!.contextSnapshot.wakeCommentIds = ["draft"]; }, (v: ReturnType<typeof actualHandoff>) => { v.runs.splice(2, 1); }]) {
  const input = actualHandoff(); mutate(input); expect(pureHandoff(input)).toBeUndefined();
 }
});
it("does not accept missing principal identity or a third human question as canonical delegation", () => {
 const input = actualHandoff(), base = { ...input, personId: "person", setupRunId: "setup", tasks: [input.work], comments: [{ id: "draft", authorUserId: "person" }, { id: "canonical-human", authorUserId: "person" }] };
 expect(outboundOrdinaryHandoff({ ...base, personId: "" })).toBeUndefined();
 expect(outboundOrdinaryHandoff({ ...base, comments: [...base.comments, { id: "third", authorUserId: "person" }] })).toBeUndefined();
 expect(outboundOrdinaryHandoff({ ...base, comments: [base.comments[0]!, { ...base.comments[1]!, authorUserId: "foreign" }] })).toBeUndefined();
});
it("requires one unique task/run provenance join and keeps the explicit email-child/thread binding", () => {
 const v = actualHandoff(), base = { ...v, personId: "person", setupRunId: "setup", tasks: [v.work], comments: [{ id: "draft", authorUserId: "person" }, { id: "canonical-human", authorUserId: "person" }] };
 expect(pureHandoff(v)?.work.id).toBe(v.work.id);
 expect(outboundOrdinaryHandoff({ ...base, runs: [...v.runs, { ...v.runs[2]!, id: "other-admission" }] })).toBeUndefined();
 expect(outboundThreadMatches(v.thread as never, v.email, v.work.id, v.companyId, v.leadId, "endpoint")).toBe(true);
 for (const mutate of [(i: ReturnType<typeof actualHandoff>) => { i.email.parentId = i.sourceId; }, (i: ReturnType<typeof actualHandoff>) => { i.thread.issueId = "other"; },
  (i: ReturnType<typeof actualHandoff>) => { i.thread.endpoint.companyId = "foreign"; }, (i: ReturnType<typeof actualHandoff>) => { i.thread.endpoint.assignedAgentId = "foreign"; }, (i: ReturnType<typeof actualHandoff>) => { i.thread.endpoint.id = "other"; }]) {
  const bad = actualHandoff(); mutate(bad); expect(outboundThreadMatches(bad.thread as never, bad.email, bad.work.id, bad.companyId, bad.leadId, "endpoint")).toBe(false);
 }
});
it("actual callback does not select a wrong originating run or unrelated email thread", async () => {
 const wrong = actualHandoff(); wrong.work.originRunId = "setup"; expect((await observeActualHandoff(wrong)).value.work).toBeUndefined();
 const thread = actualHandoff(); thread.thread.issueId = "other"; expect((await observeActualHandoff(thread)).value.thread).toBeUndefined();
});

it("accepts a supported current-source child only with the same provenance and rejects a foreign parent", () => {
 const child = actualHandoff(); (child.work as { parentId: string | null }).parentId = child.sourceId;
 (child.runs[2]!.contextSnapshot as { parentIssueId: string | null }).parentIssueId = child.sourceId;
 expect(pureHandoff(child)?.work.id).toBe(child.work.id);
 (child.work as { parentId: string | null }).parentId = "unrelated-parent";
 (child.runs[2]!.contextSnapshot as { parentIssueId: string | null }).parentIssueId = "unrelated-parent";
 expect(pureHandoff(child)).toBeUndefined();
});

it("accepts the supported public issue-create assignment producer with canonical actor/run audit even without protocol-only idempotency fields", () => {
 const input = actualHandoff(); input.work.originId = ""; input.work.originFingerprint = "";
 input.runs[2]!.contextSnapshot.source = "issue.create"; input.activity[0]!.details = {} as { source: string };
 expect(pureHandoff(input)?.work.id).toBe("work");
});
it("does not mix a public-API wake with protocol audit or accept an unknown task producer", () => {
 const mixed = actualHandoff(); mixed.runs[2]!.contextSnapshot.source = "issue.create"; expect(pureHandoff(mixed)).toBeUndefined();
 const unknown = actualHandoff(); unknown.runs[2]!.contextSnapshot.source = "unrelated"; expect(pureHandoff(unknown)).toBeUndefined();
});

it("accepts the actual issue.create wake projection which does not publish protocol parentIssueId", () => {
 const input = actualHandoff(); input.work.originId = ""; input.work.originFingerprint = "";
 input.runs[2]!.contextSnapshot.source = "issue.create"; input.activity[0]!.details = {} as { source: string };
 delete (input.runs[2]!.contextSnapshot as Record<string, unknown>).parentIssueId;
 expect(pureHandoff(input)?.work.id).toBe("work");
});

it("still rejects a native protocol wake with a mismatched parent even for the correct saved ordinary task", () => {
 const input = actualHandoff(); (input.runs[2]!.contextSnapshot as { parentIssueId: string | null }).parentIssueId = input.sourceId;
 expect(pureHandoff(input)).toBeUndefined();
});
