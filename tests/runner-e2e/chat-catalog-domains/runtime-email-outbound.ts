import { createHash, randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import type { EmailPublicationSummary, EmailThreadSummary } from "../../../packages/shared/src/types/email.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { sendChatMessage, type ChatRun } from "../chat-flow.js";
import { pollUntil } from "../api.js";
import { collectRunEvents } from "../run-observations.js";
import { checks, type Entity } from "./internal-support.js";
import { openStandingChat, waitForReply } from "./identity-support.js";
import { runtimeDefinition, runtimeObservation, observeRuntime } from "./runtime-support.js";
import { externalRequirements } from "./external-fixtures.js";
import { actualOriginalEmailSend, assertsEmailDelivery, prepareOwnedEmailConnection, inspectOwnedEmailPublication, cleanupOwnedEmailConnection } from "./runtime-email.js";
import { armOwnedEmailReceiptDuplicate, readOwnedEmailDuplicate, releaseOwnedEmailReceiptDuplicate, type EmailDuplicateRequest, type EmailDuplicateReceipt } from "./runtime-email-duplicate.js";
const hash = (v: string) => createHash("sha256").update(v).digest("hex"), normalized = (v: string) => v.replace(/\s+/g, " ").trim();
const duplicateRequests = new WeakMap<ChatCatalogContext, EmailDuplicateRequest>();
export function truthfulEmailOutcome(reply: string, outcome: string) { return /sent|accepted|provider.*(?:receipt|message)|queued.*(?:accepted|sent)/i.test(reply) && (outcome === "delivered" || !assertsEmailDelivery(reply)) && !/\b(?:did not|never|not) (?:actually )?send\b/i.test(reply); }
export function gradeOutboundEmail(value: unknown) {
 const c = checks(), o = runtimeObservation(value); c.add("actual-authorized-task-bound-email", !!o, "A real authorized draft, normal task execution and independently accepted provider message are required."); if (!o) return c.result(); const s = o.state;
 c.add("real-human-draft-and-exact-recipient", s.actualHumanDraftBound === true && s.actualDraftTransmitted === true && s.exactAuthorizedRecipient === true && s.feedbackRequested === true, "Actual task-bound bytes contain the authorized human launch draft and request feedback from exactly the designated synthetic recipient.");
 c.add("ordinary-chat-delegation-and-native-send", s.normalTaskBound === true && s.actualNativeSendBound === true && s.nativeLedgerCausal === true && o.runs.length === 5 && o.runs.every(row => row.agentId === o.leadId && row.status === "succeeded"), "Canonical Agent Chat delegates one real same-agent normal task; its own admitted native execution alone performs the email send, with separately attributed completion and factual reply.");
 c.add("one-real-provider-message-despite-authentic-network-duplicate", s.independentProviderCount === 1 && s.originalProviderReceiptMatched === true && s.authenticDuplicateBound === true && s.duplicateReleased === true && s.finalIndependentProviderCount === 1 && s.oneSavedPublication === true, "One actual official sent receipt is replayed byte-for-byte once at the selected network boundary; actual provider and persisted publication checks still prove one email.");
 c.add("linked-task-thread-and-truthful-reported-outcome", s.actualThreadLinked === true && s.factualReplyBound === true && truthfulEmailOutcome(String(s.factualReply), String(s.actualOutcome)), "The saved returned conversation remains linked to the delegated task; a later run-attributed chat answer reports real acceptance and distinguishes unproven delivery.");
 return c.result();
}
type OutboundTask = Entity & { workMode?: string; originKind?: string; originId?: string | null; originRunId?: string | null; originFingerprint?: string | null };
type OutboundRun = ChatRun & { issueId?: string | null; wakeupRequestId?: string | null };
type OutboundActivity = Entity & { runId?: string | null; entityType?: string };
/** Standing-chat create_task creates ordinary work with parentId=null. Bind its actual public provenance, not an invented hierarchy. */
export function outboundOrdinaryHandoff(input: { companyId: string; sourceId: string; leadId: string; personId: string; setupRunId: string;
 tasks: OutboundTask[]; runs: OutboundRun[]; comments: Entity[]; activity: OutboundActivity[] }) {
 const { companyId, sourceId, leadId, personId, setupRunId, tasks, runs, comments, activity } = input;
 if (![companyId, sourceId, leadId, personId, setupRunId].every(value => typeof value === "string" && value.length > 0)) return undefined;
 const human = comments.filter(row => !row.authorAgentId);
 if (human.length !== 2 || human.some(row => row.authorUserId !== personId)) return undefined;
 const canonical = runs.filter(row => row.id !== setupRunId && row.companyId === companyId && row.agentId === leadId && row.runtimeMode === "native"
  && row.contextSnapshot?.issueId === sourceId && Array.isArray(row.contextSnapshot.wakeCommentIds) && row.contextSnapshot.wakeCommentIds.includes(human[1]!.id));
 if (canonical.length !== 1) return undefined;
 const candidates = tasks.flatMap(work => {
  if ((work.parentId != null && work.parentId !== sourceId) || work.id === sourceId || work.companyId !== companyId || work.workMode !== "standard" || work.createdByAgentId !== leadId || work.assigneeAgentId !== leadId
   || work.originKind !== "manual" || work.originRunId !== canonical[0]!.id) return [];
  const created = activity.filter(row => row.companyId === companyId && row.entityType === "issue" && row.entityId === work.id && row.action === "issue.created"
   && row.actorType === "agent" && row.actorId === leadId && row.agentId === leadId && row.runId === canonical[0]!.id);
  const admitted = runs.filter(row => row.companyId === companyId && row.agentId === leadId && row.runtimeMode === "native" && row.issueId === work.id
   && !!row.wakeupRequestId && row.contextSnapshot?.issueId === work.id
   && row.contextSnapshot.wakeSource === "assignment" && row.contextSnapshot.wakeReason === "issue_assigned");
  if (admitted.length !== 1) return [];
  const producer = admitted[0]!.contextSnapshot?.source;
  const protocol = producer === "paperclip_runner.create_task" && admitted[0]!.contextSnapshot?.parentIssueId === (work.parentId ?? null) && work.originId?.startsWith(`paperclip-runner:create-task:${sourceId}:`)
   && work.originId.length > `paperclip-runner:create-task:${sourceId}:`.length && /^[a-f0-9]{64}$/.test(work.originFingerprint ?? "")
   && created.some(row => row.details?.source === "paperclip_runner_protocol");
  const publicIssueCreate = producer === "issue.create" && created.some(row => row.details?.source === undefined);
  return protocol || publicIssueCreate ? [{ work, run: admitted[0]!, canonical: canonical[0]! }] : [];
 });
 return candidates.length === 1 ? candidates[0] : undefined;
}
export function outboundThreadMatches(thread: EmailThreadSummary, emailTask: Entity, workId: string, companyId: string, leadId: string, endpointId: string) {
 return emailTask.companyId === companyId && emailTask.parentId === workId && emailTask.assigneeAgentId === leadId && thread.issueId === emailTask.id
  && thread.endpoint.id === endpointId && thread.endpoint.companyId === companyId && thread.endpoint.assignedAgentId === leadId && thread.endpoint.status === "active";
}
const requirement = externalRequirements["chat-channels.outbound-email"]!;
export const runtimeOutboundEmailCases = [runtimeDefinition("chat-channels.outbound-email", async ctx => {
 try {
  const root = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT, attemptId = process.env.PAPERCLIP_E2E_ACCOUNTING_ATTEMPT_ID; if (!root || !attemptId) throw new Error("Exact owned receipt duplicate server hook is required before provider setup");
  const installed = readOwnedEmailDuplicate<{ executionId: string; attemptId: string; pid: number }>(root, "installed.json"); if (installed.executionId !== ctx.input.execution.id || installed.attemptId !== attemptId || !Number.isSafeInteger(installed.pid)) throw new Error("Selected outbound receipt duplicate hook does not bind this exact attempt");
  const source = await openStandingChat(ctx), connection = await prepareOwnedEmailConnection(ctx), nonce = randomUUID(), marker = `Launch draft ${nonce}`, draft = `${marker}\nAcorn helps independent teams launch accessible product pages. The launch page introduces the product, explains the lightweight workflow, and invites readers to join the early-access list. The launch date is November 12 and the public contact is launch@example.test.`;
  await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${source.id}`, { waitUntil: "domcontentloaded" });
  for (const scope of [{ scopeType: "company", scopeId: source.companyId }, { scopeType: "agent", scopeId: ctx.input.fixtures.agent.id }]) await ctx.input.api.post(`/api/companies/${source.companyId}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
  const setupQuery = `This is my authorized launch draft for my next request. Retain the complete draft in this conversation, including its reference. Do not email it yet.\n\n${draft}`;
  await sendChatMessage(ctx.input.page, setupQuery); await waitForReply(ctx);
  const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`), human = comments.filter(row => !row.authorAgentId), runs = await ctx.allRuns();
  const actualHumanDraftBound = human.length === 1 && human[0]?.body === setupQuery && human[0]?.authorUserId === connection.personId && runs.length === 1 && runs[0]?.status === "succeeded" && runs[0]?.contextSnapshot?.issueId === source.id;
  await ctx.input.api.post(`/api/companies/${source.companyId}/tools/policies`, { name: `Exact self-addressed launch review ${nonce}`, policyType: "allow", priority: 10, selectors: { connectionId: connection.endpoint.connectionId, toolNames: ["email.send"] }, conditions: { arguments: { fieldEquals: { to: [connection.endpoint.address] } } }, config: {} });
  const request: EmailDuplicateRequest = { executionId: ctx.input.execution.id, attemptId, inboxId: connection.endpoint.address!, marker, nonce, expiresAt: Date.now() + 480000 }; await armOwnedEmailReceiptDuplicate(root, request); duplicateRequests.set(ctx, request);
  return { ...connection, sourceId: source.id, draft, marker, setupQuery, setupRunId: runs[0]?.id, actualHumanDraftBound, emailRecipient: { id: connection.endpoint.id, companyId: source.companyId, connectionId: connection.endpoint.connectionId, email: connection.endpoint.address }, startedAt: new Date().toISOString() };
 } catch (error) { await cleanupOwnedEmailConnection(ctx); throw error; }
}, gradeOutboundEmail, {
 authentication: "human-session", setupHumanMessageCount: 1, expectedHumanMessageCount: 3, expectedRunCount: 5, turnTimeoutMs: 120000, attemptTimeoutMs: 1020000,
 externalInput: { provider: requirement.provider, fields: requirement.fields }, queryBindings: [{ catalogToken: "reviewer@example.test", stateKey: "emailRecipient", resourceKind: "agentmail-recipient", valueField: "email" }],
 sourceFiles: ["chat-catalog-domains/runtime-email-outbound.ts", "chat-catalog-domains/runtime-email.ts", "chat-catalog-domains/runtime-email-private.ts", "chat-catalog-domains/runtime-email-private-worker.ts", "chat-catalog-domains/runtime-email-duplicate.ts", "chat-catalog-domains/runtime-email-fault.ts", "server-entry.ts", "chat-query-bindings.ts", "../../server/src/services/email-channels.ts", "../../server/src/services/agentmail-api.ts", "../../server/src/services/connectors/agentmail.ts", "chat-scenarios/chat-channels.yaml"],
 async act(ctx, s) {
  const api = ctx.input.api, companyId = ctx.input.fixtures.company.id, sourceId = String(s.sourceId), endpointId = (s.endpoint as { id: string }).id;
  const sent = await pollUntil({ label: "Actual delegated task sends the authorized launch draft and returns ordinary completion", deadlineAt: Date.now() + 360000, load: async () => {
   await ctx.refreshIssue(); const runs = await ctx.allRuns(), tasks = await api.get<OutboundTask[]>(`/api/companies/${companyId}/issues`);
   const [comments, activity] = await Promise.all([api.get<Entity[]>(`/api/issues/${sourceId}/comments?order=asc`), api.get<OutboundActivity[]>(`/api/companies/${companyId}/activity?limit=1000`)]);
   const handoff = outboundOrdinaryHandoff({ companyId, sourceId, leadId: ctx.input.fixtures.agent.id, personId: String(s.personId ?? ""), setupRunId: String(s.setupRunId ?? ""), tasks, runs, comments, activity });
   const work = handoff?.work, emails = work ? tasks.filter(row => row.parentId === work.id && row.companyId === companyId) : [];
   const threads = await Promise.all(emails.map(async emailTask => { const thread = await api.get<EmailThreadSummary | null>(`/api/companies/${companyId}/email/tasks/${emailTask.id}`); return thread && outboundThreadMatches(thread, emailTask, work!.id, companyId, ctx.input.fixtures.agent.id, endpointId) ? thread : undefined; }));
   const matching = threads.filter((row): row is EmailThreadSummary => !!row); return { runs, tasks, work, handoff, thread: matching.length === 1 ? matching[0] : undefined };
  }, accept: v => ctx.issue()?.conversationState === "waiting" && v.runs.length === 4 && v.runs.every(row => row.status === "succeeded") && v.work?.status === "done" && v.thread?.publications.length === 1 && ["sent", "delivered"].includes(v.thread.publications[0]!.outcome), reject: v => v.runs.length > 4 ? "Email delegation exceeded its declared causal run bound" : undefined });
  const thread = sent.thread!, publication = await api.get<EmailPublicationSummary>(`/api/companies/${companyId}/email/deliveries/${thread.publications[0]!.id}`), work = sent.work!, run = sent.handoff!.run, request = publication.request!;
  s.emailTaskId = thread.issueId; s.workTaskId = work.id; s.publicationId = publication.id; s.actualOutcome = publication.outcome;
  s.actualDraftTransmitted = normalized(request.text).includes(normalized(String(s.draft))); s.feedbackRequested = /feedback|review|thoughts|comments|suggestions|what (?:do you|you) think/i.test(request.text);
  s.exactAuthorizedRecipient = JSON.stringify(request.to) === JSON.stringify([(s.emailRecipient as { email: string }).email]) && !request.cc?.length && !request.bcc?.length;
  s.normalTaskBound = !!sent.handoff && sent.handoff.work.id === work.id && sent.handoff.run.id === run.id;
  const events = run ? await collectRunEvents<{ seq?: number; eventType?: string; payload?: unknown }>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`)) : []; s.actualNativeSendBound = actualOriginalEmailSend(events, { companyId, taskId: work.id, endpointId, publicationId: publication.id });
  const direct = await inspectOwnedEmailPublication(ctx, publication, String(s.startedAt)); s.independentProviderCount = direct.matchedSent?.length; s.originalProviderReceiptMatched = direct.originalMessageMatched;
  const duplicateRequest = duplicateRequests.get(ctx)!, root = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT!;
  const duplicate = await pollUntil({ label: "Actual authentic sent-receipt network duplicate observed", deadlineAt: Date.now() + 30000, load: async () => { try { return readOwnedEmailDuplicate<EmailDuplicateReceipt>(root, "receipt.json"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }, accept: row => !!row });
  s.authenticDuplicateBound = duplicate?.executionId === duplicateRequest.executionId && duplicate.attemptId === duplicateRequest.attemptId && duplicate.nonce === duplicateRequest.nonce && duplicate.publicationId === publication.id && duplicate.providerMessageId === publication.providerMessageId && /^[a-f0-9]{64}$/.test(duplicate.authenticPayloadSha256) && duplicate.injectedDuplicateCount === 1 && !duplicate.expired;
  await ctx.input.evidence("outbound-authentic-network-duplicate.json", { ...duplicate, injection: "one identical actual official message.sent frame replayed once; no fabricated provider response" });
  await releaseOwnedEmailReceiptDuplicate(root, duplicateRequest); s.duplicateReleased = true; duplicateRequests.delete(ctx);
  const before = sent.runs.map(row => row.id), followup = "Please inspect the saved email conversation and its actual provider receipt, then report the real outcome and what is known about recipient delivery. Do not send another email.";
  await sendChatMessage(ctx.input.page, followup);
  const final = await pollUntil({ label: "Actual launch email outcome reported in Agent Chat", deadlineAt: Date.now() + 180000, load: async () => { await ctx.refreshIssue(); return ctx.allRuns(); }, accept: rows => ctx.issue()?.conversationState === "waiting" && rows.length === 5 && rows.every(row => row.status === "succeeded") });
  const factual = final.find(row => !before.includes(row.id))!, comments = await api.get<Entity[]>(`/api/issues/${sourceId}/comments?order=asc`), human = comments.filter(row => !row.authorAgentId), canonical = sent.runs.find(row => Array.isArray(row.contextSnapshot?.wakeCommentIds) && row.contextSnapshot.wakeCommentIds.includes(human[1]?.id)), completion = sent.runs.filter(row => Array.isArray(row.contextSnapshot?.chatCompletionUpdates) && row.contextSnapshot.chatCompletionUpdates.some((update: Entity) => update.id === work.id && update.status === "done"));
  s.factualReplyBound = human.length === 3 && human[2]?.body === followup && factual.contextSnapshot?.issueId === sourceId && Array.isArray(factual.contextSnapshot.wakeCommentIds) && factual.contextSnapshot.wakeCommentIds.length === 1 && factual.contextSnapshot.wakeCommentIds[0] === human[2]?.id;
  s.factualReply = comments.filter(row => row.createdByRunId === factual.id && row.authorAgentId === ctx.input.fixtures.agent.id).map(row => row.body).join("\n");
  s.nativeLedgerCausal = !!canonical && !!run && completion.length === 1 && new Set([s.setupRunId, canonical.id, run.id, completion[0]!.id, factual.id]).size === 5 && final.every(row => [s.setupRunId, canonical.id, run.id, completion[0]!.id, factual.id].includes(row.id));
  const saved = await api.get<EmailThreadSummary>(`/api/companies/${companyId}/email/tasks/${thread.issueId}`), emailTask = await api.get<Entity>(`/api/issues/${thread.issueId}`); const ordinary = (await api.get<Array<Entity & { workMode?: string }>>(`/api/companies/${companyId}/issues`)).filter(row => row.workMode !== "chat"); s.oneSavedPublication = saved.publications.length === 1 && saved.publications[0]?.id === publication.id && ordinary.length === 2 && ordinary.every(row => [work.id, thread.issueId].includes(row.id)); s.actualThreadLinked = outboundThreadMatches(saved, emailTask, work.id, companyId, ctx.input.fixtures.agent.id, endpointId) && saved.conversationId === publication.conversationId;
  const last = await inspectOwnedEmailPublication(ctx, publication, String(s.startedAt)); s.finalIndependentProviderCount = last.matchedSent?.length;
  (s.providerProbes as unknown[]).push(...[direct, last].map(row => ({ phase: "actual-outbound-provider-receipt", directProviderProbeCount: row.directProviderProbeCount, status: "verified", usage: "unavailable", cost: "unavailable" })));
 },
 async verifyResult(ctx, s) { const source = ctx.input.page.url(); await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${s.emailTaskId}`, { waitUntil: "domcontentloaded" }); const task = await ctx.input.api.get<Entity>(`/api/issues/${s.emailTaskId}`); await expect(ctx.input.page.getByTestId("issue-detail-header").getByRole("heading", { name: task.title!, exact: true })).toBeVisible(); await ctx.input.capture("actual-outbound-email-thread", "The task-bound launch email and actual provider result", "outbound-email-thread.png"); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); },
 async cleanup(ctx) { try { const r = duplicateRequests.get(ctx); if (r) await releaseOwnedEmailReceiptDuplicate(process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT!, r); } finally { duplicateRequests.delete(ctx); await cleanupOwnedEmailConnection(ctx); } },
})];
