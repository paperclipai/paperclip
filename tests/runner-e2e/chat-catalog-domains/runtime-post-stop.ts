import { expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { ChatCatalogContext, NativeStopBoundaryReceipt } from "../chat-catalog-contract.js";
import type { IssueComment } from "../../../packages/shared/src/types/issue.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { collectRunEvents } from "../run-observations.js";
import { readRegisteredArtifacts } from "../registered-artifact.js";
import { checks } from "./internal-support.js";
import { openStandingChat } from "./identity-support.js";
import { prepareRuntimeWorkerGate, readRuntimeTaskGate } from "./runtime-busy-worker.js";
import { suspendOwnedProviderForCleanup, releaseOwnedCleanupProvider, ownedCleanupProviderHasExited } from "./runtime-provider-cleanup.js";
import type { NativeFaultRun } from "./runtime-native-fault.js";
import { hasSimplerWebsite, renderRuntimeArtifact } from "./runtime-rendered-artifact.js";
import { observeRuntime, runtimeDefinition, runtimeObservation, type RuntimeAgent } from "./runtime-support.js";
interface StopIntent { schema?: string; intentId?: string; intentAuditId?: string; companyId?: string; runId?: string; issueId?: string; scope?: string; dispatchState?: string; dispatched?: boolean; recordedAt?: string; acknowledgedAt?: string; acknowledgementAuditId?: string }
interface StopHandle { page: Page; completed?: Promise<number> }
const handles = new WeakMap<ChatCatalogContext, StopHandle>();
export function sameSourcePostStopChronology(input: { boundary: NativeStopBoundaryReceipt; old: NativeFaultRun; next: NativeFaultRun; human: Pick<IssueComment, "id" | "body" | "issueId" | "companyId" | "authorAgentId" | "authorUserId" | "createdAt">; query: string; companyId: string; agentId: string; humanId: string; prompt: string; wakeCommentIds: string[] }) {
  const { old, next, human, boundary: b } = input, intent = old.resultJson?.nativeCancellation as StopIntent | undefined;
  const before = Date.parse(b.intentRecordedAt), sent = Date.parse(String(human.createdAt)), ack = Date.parse(intent?.acknowledgedAt ?? ""), started = Date.parse(String(next.startedAt)), ended = Date.parse(String(old.finishedAt));
  return old.id === b.runId && old.nativeIssueId === b.issueId && old.companyId === input.companyId && old.agentId === input.agentId && old.runtimeMode === "native" && old.status === "cancelled"
    && intent?.schema === "paperclip.native-cancellation.v1" && intent.intentId === b.intentId && intent.issueId === b.issueId && intent.companyId === input.companyId && intent.runId === old.id && intent.scope === "run"
    && !!intent.intentAuditId && !!intent.acknowledgementAuditId && intent.recordedAt === b.intentRecordedAt && intent.dispatchState === "acknowledged" && intent.dispatched === true
    && human.issueId === b.issueId && human.companyId === input.companyId && !human.authorAgentId && human.authorUserId === input.humanId && human.body === input.query
    && before <= sent && sent < ack && next.id !== old.id && next.nativeIssueId === b.issueId && next.companyId === input.companyId && next.agentId === input.agentId && next.runtimeMode === "native" && next.status === "succeeded"
    && started >= ack && started >= ended && input.wakeCommentIds.length === 1 && input.wakeCommentIds[0] === human.id && input.prompt.includes(human.id) && input.prompt.includes(input.query);
}
export async function releasePostStopGateAfterCleanup(old: Pick<NativeFaultRun, "status" | "resultJson">, providerExited: boolean, release: () => Promise<void>) {
  const intent = old.resultJson?.nativeCancellation as StopIntent | undefined;
  if (old.status !== "cancelled" || intent?.dispatchState !== "acknowledged" || intent.dispatched !== true || !intent.acknowledgedAt || !intent.acknowledgementAuditId || !providerExited)
    throw new Error("The old native cleanup must be independently proven before releasing the original neutral tool gate");
  await release();
}
export function gradePostStop(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("actual-same-source-stop-continuation-evidence", !!o, "A real setup human request, actual native provider cleanup, canonical human instruction and normal continuation must be independently observed."); if (!o) return c.result();
  const s = o.state;
  c.add("human-stop-cleanup-and-exact-message-chronology", s.stopStatus === 200 && s.gateReleasedAfterCleanup === true && s.chronologyBound === true && s.providerExited === true && s.initialHumanRetained === true,
    "The same actual source run has a real Stop intent and ACK; the owned protocol endpoint has retired (the OpenCode proxy, not SDK server health), and only its eligible successor consumes the unchanged canonical message after cleanup.");
  c.add("one-eligible-current-owner-with-no-revival-or-duplicate", o.runs.length === 2 && o.runs.filter(row => row.status === "cancelled").length === 1 && o.runs.filter(row => row.status === "succeeded").length === 1
    && o.runs.every(row => row.agentId === o.leadId) && s.singleSuccessor === true && s.sameCurrentAssignment === true && s.oldEvidenceRetained === true && o.humanQueries.length === 2 && o.tasks.length === 0,
    "The original stopped execution remains cancelled, one native source continuation owns the new direction under current assignment, and no duplicate task or user message appears.");
  c.add("actual-visible-single-page-result-from-continuation", s.actualSimplePage === true && s.artifactRunBound === true && /single[ -]page|one page|Acorn|website|site|page/i.test(String(s.canonicalReply)) && /ready|built|created|updated|implemented|saved|now/i.test(String(s.canonicalReply))
    && !/still (?:queued|waiting)|not (?:yet )?(?:built|implemented|ready)|could not (?:build|implement)|kept.*(?:tabs|multi[ -]page)/i.test(String(s.canonicalReply)),
    "The subsequent native reply reports the real saved simple single page; registered bytes and visible design independently prove the result.");
  return c.result();
}
export const runtimePostStopCases = [runtimeDefinition("recovery.post-stop-message", async ctx => {
  const source = await openStandingChat(ctx), lead = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`);
  const { gate } = await prepareRuntimeWorkerGate(ctx, { worker: lead, taskBound: true });
  const secondary = await ctx.input.page.context().newPage(); handles.set(ctx, { page: secondary });
  try {
  const first = `Build an Acorn Notes website with a visible heading, product paragraph and labelled signup action. Initially use several panels and tabs. Work directly in this conversation; save and register the actual website.html artifact here, without delegating another task. First run the bounded command ${gate.command} once and wait for its output before implementing the website. Do not replace the command or invent its output. Preserve later human changes to this same website.`;
  await sendChatMessage(ctx.input.page, first);
  const running = await pollUntil({ label: "Genuine initial source Website request executing its bounded native tool", deadlineAt: Date.now() + 150000,
    load: async () => ({ runs: await ctx.allRuns(), waiting: await readRuntimeTaskGate(ctx, gate, source.id, lead.id) }),
    accept: v => v.waiting === "waiting" && v.runs.length === 1 && v.runs[0]?.agentId === lead.id && v.runs[0].status === "running",
    reject: v => v.runs.some(row => row.status !== "running" && row.status !== "queued") ? "The genuine initial source execution ended before Stop setup" : undefined });
  const original = await ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${running.runs[0]!.id}`);
  if (original.nativeIssueId !== source.id || original.runtimeMode !== "native") throw new Error("The initial native execution is not bound to the actual canonical source chat");
  const people = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  const comments = await ctx.input.api.get<IssueComment[]>(`/api/issues/${source.id}/comments?order=asc`), initial = comments.filter(row => !row.authorAgentId);
  if (initial.length !== 1 || initial[0]?.body !== first || initial[0].authorUserId !== people.user.id) throw new Error("The initial Website request is not the exact genuine signed-in human setup turn");
  await secondary.goto(ctx.input.page.url(), { waitUntil: "domcontentloaded" }); await expect(secondary.getByTestId("task-chat-composer-stop")).toBeEnabled();
  return { gate, sourceId: source.id, workerRunId: original.id, initialHuman: initial[0], humanId: people.user.id };
  } catch (error) { if (gate.gate) await writeFile(gate.gate, "The pending fixture tool has been released.", "utf8"); await secondary.close(); handles.delete(ctx); throw error; }
}, gradePostStop, {
  canonicalBoundary: "native-stop-cleanup", authentication: "human-session", setupHumanMessageCount: 1, expectedHumanMessageCount: 2, expectedRunCount: 2, attemptTimeoutMs: 720000,
  runPolicy: { kind: "terminal-counts", terminalStatusCounts: { cancelled: 1, succeeded: 1 } },
  sourceFiles: ["chat-catalog-domains/runtime-post-stop.ts", "chat-catalog-domains/runtime-provider-cleanup.ts", "chat-catalog-domains/runtime-native-fault.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-rendered-artifact.ts", "chat-catalog-domains/runtime-support.ts", "chat-native-stop-boundary.ts", "../../server/src/services/native-runtime/native-session-executor.ts", "../../server/src/services/explicit-native-continuation.ts", "../../packages/paperclip-runner/src/live/runnerd-codex-transport.ts", "../../packages/paperclip-runner/runner/crates/runner-core/src/codex_provider.rs", "../../packages/paperclip-runner/runner/crates/runner-core/src/process_supervisor.rs", "registered-artifact.ts", "chat-scenarios/recovery.yaml"],
  setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["actual-source-native-owner"] },
  async verifySetup(ctx, state) { const c = checks(), run = await ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${state.workerRunId}`);
    c.add("actual-source-native-owner", run.status === "running" && run.nativeIssueId === ctx.issue()?.id && run.agentId === ctx.input.fixtures.agent.id && run.runtimeMode === "native", "The actual canonical conversation already has its genuine native setup owner, without fabricated status or response history."); return c.result(); },
  async beforeCanonicalSend(ctx, state) {
    const handle = handles.get(ctx); if (!handle || !ctx.issue()) throw new Error("Actual same-source human Stop tab is unavailable");
    await suspendOwnedProviderForCleanup(ctx, { runId: String(state.workerRunId), issueId: ctx.issue()!.id, agentId: ctx.input.fixtures.agent.id });
    const endpoint = `/api/heartbeat-runs/${state.workerRunId}/cancel`;
    const response = handle.page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === endpoint, { timeout: 30000 });
    handle.completed = response.then(r => r.status()); void handle.completed.catch(() => undefined);
    await handle.page.getByTestId("task-chat-composer-stop").click();
    const run = await pollUntil({ label: "Actual public human Stop durably records pending native cleanup intent", deadlineAt: Date.now() + 1000, intervalMs: 25,
      load: () => ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${state.workerRunId}`),
      accept: row => (row.resultJson?.nativeCancellation as StopIntent | undefined)?.dispatchState === "pending" });
    const intent = run.resultJson!.nativeCancellation as StopIntent;
    if (!intent.intentId || !intent.recordedAt || !intent.intentAuditId || intent.issueId !== ctx.issue()!.id) throw new Error("The actual pending Stop lacks its native source/audit identity");
    return { runId: run.id, issueId: ctx.issue()!.id, intentId: intent.intentId, intentRecordedAt: intent.recordedAt };
  },
  async act(ctx, state) {
    const cleaned = await pollUntil({ label: "Actual old source cancellation ACK and owned provider endpoint retirement before neutral gate release", deadlineAt: Date.now() + 90000,
      load: async () => ({ old: await ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${state.workerRunId}`), providerExited: await ownedCleanupProviderHasExited(ctx) }),
      accept: v => v.old.status === "cancelled" && (v.old.resultJson?.nativeCancellation as StopIntent | undefined)?.dispatchState === "acknowledged" && v.providerExited });
    await releasePostStopGateAfterCleanup(cleaned.old, cleaned.providerExited, () => writeFile((state.gate as { gate: string }).gate, "The pending fixture tool has been released.", "utf8"));
    state.gateReleasedAfterCleanup = true;
    const settled = await pollUntil({ label: "One normal same-source continuation after actual stopped-provider cleanup", deadlineAt: Date.now() + 300000,
      load: async () => { await ctx.refreshIssue(); return { runs: await ctx.allRuns(), source: ctx.issue() }; },
      accept: v => v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.find(row => row.id === state.workerRunId)?.status === "cancelled" && v.runs.find(row => row.id !== state.workerRunId)?.status === "succeeded",
      reject: v => v.runs.length > 2 || v.runs.some(row => row.id !== state.workerRunId && ["failed", "timed_out", "cancelled"].includes(row.status)) ? "The actual continuation duplicated or failed" : undefined });
    state.stopStatus = await handles.get(ctx)!.completed;
    const old = await ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${state.workerRunId}`), successor = settled.runs.find(row => row.id !== old.id)!;
    const next = await ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${successor.id}`), comments = await ctx.input.api.get<IssueComment[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
    const human = comments.filter(row => !row.authorAgentId), canonical = human[1];
    const native = next.runnerProfileJson?.nativeExecutionInput as { task?: { prompt?: string } } | undefined;
    state.chronologyBound = !!canonical && sameSourcePostStopChronology({ boundary: state.nativeStopBoundary as NativeStopBoundaryReceipt, old, next, human: canonical, query: ctx.scenario.query, companyId: ctx.input.fixtures.company.id, agentId: ctx.input.fixtures.agent.id, humanId: String(state.humanId), prompt: native?.task?.prompt ?? "", wakeCommentIds: (next.contextSnapshot?.wakeCommentIds as string[] | undefined) ?? [] });
    state.initialHumanRetained = human[0]?.id === (state.initialHuman as IssueComment).id && human[0]?.body === (state.initialHuman as IssueComment).body;
    state.singleSuccessor = settled.runs.filter(row => row.id !== old.id).length === 1;
    state.sameCurrentAssignment = ctx.issue()?.assigneeAgentId === next.agentId || (ctx.issue() as { conversationAgentId?: string }).conversationAgentId === next.agentId;
    const events = await collectRunEvents<{ seq?: number; eventType?: string; createdAt?: string; payload?: { schema?: string; runId?: string; nativeSessionId?: string } }>((afterSeq, limit) => ctx.input.api.get(`/api/heartbeat-runs/${old.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
    state.oldEvidenceRetained = events.length > 0 && old.status === "cancelled";
    state.providerExited = await ownedCleanupProviderHasExited(ctx);
    if (old.errorCode === "native_session_cleanup_quarantined") state.chronologyBound = state.chronologyBound === true && !!next.nativeSessionId && next.nativeSessionId !== old.nativeSessionId && events.some(event => event.eventType === "native.stopped_conversation_verified" && event.payload?.schema === "paperclip.stopped_native_conversation.v1" && event.payload.runId === old.id && event.payload.nativeSessionId === old.nativeSessionId && Date.parse(event.createdAt ?? "") <= Date.parse(String(next.startedAt)));
    state.canonicalReply = comments.filter(row => row.createdByRunId === next.id && row.authorAgentId === next.agentId).map(row => row.body).join("\n"); state.successorRunId = next.id;
    await releaseOwnedCleanupProvider(ctx);
  },
  async observe(ctx, state) {
    const o = await observeRuntime(ctx, state);
    if (state.successorRunId) { const [artifact] = await readRegisteredArtifacts(ctx.input.api, String(state.sourceId), String(state.successorRunId), ["website.html"]);
      state.artifactRunBound = artifact?.contentVerified === true; state.actualSimplePage = !!artifact?.contentVerified && hasSimplerWebsite(await renderRuntimeArtifact(ctx, artifact.content)); }
    return o;
  },
  async verifyResult(ctx) { await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); },
  async cleanup(ctx, state) { try { await releaseOwnedCleanupProvider(ctx); } finally { if (state.gate) await writeFile((state.gate as { gate: string }).gate, "The pending fixture tool has been released.", "utf8"); const handle = handles.get(ctx); if (handle) { await handle.completed?.catch(() => undefined); await handle.page.close(); handles.delete(ctx); } } },
})];
