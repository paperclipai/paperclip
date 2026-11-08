import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { HeartbeatRun } from "../../../packages/shared/src/types/heartbeat.js";
import type { IssueQueuedCommentQueue, IssueThreadInteraction } from "../../../packages/shared/src/types/issue.js";
import { pollUntil } from "../api.js";
import { renderRuntimeArtifact, hasSimplerWebsite } from "./runtime-rendered-artifact.js";
import { collectRunEvents } from "../run-observations.js";
import { readRegisteredArtifacts } from "../registered-artifact.js";
import { createIssueThreadInteractionSchema } from "../../../packages/shared/src/validators/issue.js";
import { checks, type Entity } from "./internal-support.js";
import { busyRuntimeWorker, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { clickInteractionAction } from "./runtime-support.js";
import { runtimeQueueCases } from "./runtime-queue.js";
import { runtimeDefinition, runtimeObservation, observeRuntime } from "./runtime-support.js";
export function gradeInterruption(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("actual-fresh-direction-native-interruption-evidence", !!o, "A genuine native active owner, saved accepted plan direction, supported human Interrupt and one eligible successor are required."); if (!o) return c.result();
  const s = o.state, before = s.directionQueue as IssueQueuedCommentQueue, original = s.oldRunAfter as HeartbeatRun, next = s.successor as HeartbeatRun;
  c.add("genuine-saved-fresh-direction-before-interruption", before?.issueId === (s.task as Entity).id && before.targetRunId === s.workerRunId && before.protocol === "paperclip_runner_v1"
    && before.entries.length === 1 && before.entries[0]?.source?.kind === "interaction" && before.entries[0].source.requiresFreshSession === true
    && before.entries[0].source.interactionId === (s.approvedDirection as Entity).id && s.planApprovedByHuman === true && s.interruptControlEnabled === true,
  "An actual human accepted the exact saved simpler plan; its typed fresh-session response is waiting behind the original native owner, making the production Interrupt control legitimately available.");
  c.add("actual-human-interrupt-and-native-stop-confirmed", s.humanInterrupted === true && s.interruptStatus === 200 && original?.id === s.workerRunId && original.status === "cancelled"
    && s.nativeStopAcknowledged === true && s.oldEvidenceRetained === true && /interrupt|stop|cancel/i.test(String(s.queryReply))
    && /human|you|control|button|interrupt/i.test(String(s.queryReply)) && !/I(?:'ve| have)? (?:already )?(?:stopped|interrupted|cancelled)/i.test(String(s.queryReply)),
  "The canonical reply guides the authorized human control; the real click and matching durable native cancellation ACK establish stopped execution while retaining its evidence.");
  c.add("one-owner-after-cleanup-with-exact-accepted-direction", s.successorCount === 1 && !!next && next.agentId === (s.worker as Entity).id && next.status === "succeeded"
    && Date.parse(String(next.startedAt)) >= Date.parse(String(original.finishedAt)) && s.neverConcurrentOwners === true
    && s.acceptedDirectionInputBound === true && s.freshSessionBound === true && s.queueEmptyAfterDelivery === true,
  "Only one eligible fresh continuation starts after the old owner settles and receives the exact accepted revision once; pending queue admission alone does not count as delivery.");
  c.add("actual-simpler-single-page-result-and-preserved-plan", s.actualSimplePage === true && s.planRevisionRetained === true && s.deliveryRevisionBound === true
    && o.tasks.length === 1 && o.tasks[0]?.id === (s.task as Entity).id && o.tasks[0]?.status === "done" && o.runs.length === 3
    && o.runs.filter(row => row.status === "cancelled").length === 1 && o.runs.filter(row => row.status === "succeeded").length === 2,
  "The successor saves the real approved simpler single page on the original task while its accepted plan revision and stopped attempt remain inspectable.");
  return c.result();
}
export const runtimeInterruptionCases = [runtimeDefinition("steering.interrupt-with-direction", async ctx => {
  const state: Record<string, unknown> = await busyRuntimeWorker(ctx), task = state.task as Entity, source = ctx.input.page.url();
  const marker = `Simpler layout ${ctx.input.nonce}`, body = `# Approved simpler website direction\n${marker}\nReplace the complex multi-panel dashboard layout with one semantic HTML page. Include a visible Acorn Notes heading, one short product paragraph and one labelled signup action. No tabs or multi-page navigation. Register the actual website.html file and save a website-delivery task document with this reference. This applies only to the next eligible attempt; do not start another owner while the current execution remains active.\n`;
  const plan = await ctx.input.api.putSensitive<Entity>(`/api/issues/${task.id}/documents/plan`, { title: "Simpler Website direction", format: "markdown", body, baseRevisionId: null });
  if (!plan.id || !plan.latestRevisionId || !plan.latestRevisionNumber) throw new Error("The real human-authored simpler plan has no retained revision identity");
  const confirmation = await ctx.input.api.post<IssueThreadInteraction>(`/api/issues/${task.id}/interactions`, createIssueThreadInteractionSchema.parse({ kind: "request_confirmation",
    title: "Approve the saved simpler Website layout", resolverPolicy: "human_only", continuationPolicy: "wake_assignee",
    payload: { version: 1, prompt: "Use this saved simpler layout on the next eligible attempt?", supersedeOnUserComment: false,
      target: { type: "issue_document", issueId: task.id, documentId: plan.id, key: "plan", revisionId: plan.latestRevisionId, revisionNumber: plan.latestRevisionNumber } } }));
  await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
  const accept = ctx.input.page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/issues/${task.id}/interactions/${confirmation.id}/accept`);
  await clickInteractionAction(ctx.input.page, confirmation, "Approve");
  if ((await accept).status() !== 200) throw new Error("Actual human simpler-plan approval did not succeed");
  const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  const approved = (await ctx.input.api.get<IssueThreadInteraction[]>(`/api/issues/${task.id}/interactions`)).find(row => row.id === confirmation.id)!;
  const queue = await pollUntil({ label: "Real accepted plan response requires a fresh native turn but has not interrupted old work", deadlineAt: Date.now() + 20_000,
    load: () => ctx.input.api.get<IssueQueuedCommentQueue>(`/api/issues/${task.id}/queued-comments`),
    accept: q => q.entries.length === 1 && q.entries[0]?.source?.interactionId === confirmation.id && q.entries[0].source.requiresFreshSession === true && q.targetRunId === state.workerRunId });
  await expect(ctx.input.page.getByTestId(`task-chat-queued-interrupt-${confirmation.id}`)).toBeEnabled();
  if ((await ctx.allRuns()).length !== 1 || (await ctx.allRuns())[0]?.status !== "running") throw new Error("Saving approved new direction performed the target interruption or admitted another owner during setup");
  await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  return { ...state, marker, plan, planBody: body, approvedDirection: approved, directionQueue: queue, planApprovedByHuman: approved.status === "accepted" && approved.resolvedByUserId === session.user.id && !approved.resolvedByAgentId, interruptControlEnabled: true };
}, gradeInterruption, {
  oracleVersion: "paperclip.chat-catalog.runtime.interrupt-with-direction.v3", authentication: "human-session", expectedRunCount: 3, attemptTimeoutMs: 900_000,
  setupPolicy: runtimeQueueCases[0]!.setupPolicy, verifySetup: runtimeQueueCases[0]!.verifySetup,
  runPolicy: { kind: "terminal-counts", terminalStatusCounts: { cancelled: 1, succeeded: 2 } },
  sourceFiles: ["chat-catalog-domains/runtime-interruption.ts", "chat-catalog-domains/runtime-rendered-artifact.ts", "chat-catalog-domains/runtime-queue.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "registered-artifact.ts", "chat-scenarios/steering.yaml"],
  async act(ctx, state) {
    await pollUntil({ label: "Canonical interruption guidance before the actual human action", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.some(row => row.id === state.workerRunId && row.status === "running") && v.runs.some(row => row.agentId === ctx.input.fixtures.agent.id && row.status === "succeeded")) });
    state.queryReply = (await observeRuntime(ctx, state)).reply;
    const source = ctx.input.page.url(), task = state.task as Entity, confirmation = state.approvedDirection as Entity, endpoint = `/api/issues/${task.id}/queued-comments`;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    const interrupted = ctx.input.page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `${endpoint}/interrupt`);
    chatCatalogNativePhaseRemainingBudget(ctx)?.();
    await ctx.input.page.getByTestId(`task-chat-queued-interrupt-${confirmation.id}`).click(); state.humanInterrupted = true; state.interruptStatus = (await interrupted).status();
    const stopped = await pollUntil({ label: "Matching native cancellation ACK after actual supported Interrupt", deadlineAt: Date.now() + 90_000,
      load: () => ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${state.workerRunId}`),
      accept: run => run.status === "cancelled" && (run.resultJson?.nativeCancellation as { dispatchState?: string } | undefined)?.dispatchState === "acknowledged" });
    state.oldRunAfter = stopped;
    const cancellation = stopped.resultJson?.nativeCancellation as { runId?: string; issueId?: string; companyId?: string; dispatched?: boolean; dispatchState?: string } | undefined;
    state.nativeStopAcknowledged = cancellation?.runId === stopped.id && cancellation.issueId === task.id && cancellation.companyId === ctx.input.fixtures.company.id && cancellation.dispatched === true && cancellation.dispatchState === "acknowledged";
    // No gate value injects the simpler direction: it exists only in the
    // independently approved persisted plan and its actual queued response.
    await writeFile((state.gate as { gate: string }).gate, "The pending fixture tool has been released.", "utf8");
    let neverConcurrent = true;
    const delivered = await pollUntil({ label: "One fresh native continuation after old-owner cleanup delivers simpler Website", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 240_000),
      load: async () => { const runs = await ctx.allRuns(); neverConcurrent &&= runs.filter(row => row.agentId === (state.worker as Entity).id && ["running", "queued"].includes(row.status)).length <= 1;
        return { runs, task: await ctx.input.api.get<Entity>(`/api/issues/${task.id}`), queue: await ctx.input.api.get<IssueQueuedCommentQueue>(endpoint) }; },
      accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.runs.length === 3 && v.task.status === "done" && v.queue.entries.length === 0 && v.runs.filter(row => row.id !== state.workerRunId).every(row => row.status === "succeeded")),
      reject: v => v.runs.length > 3 || v.runs.some(row => row.id !== state.workerRunId && ["failed", "cancelled", "timed_out"].includes(row.status)) ? "Interruption failed or delivered more than one successor" : undefined });
    const successors = delivered.runs.filter(row => row.agentId === (state.worker as Entity).id && row.id !== state.workerRunId); state.successorCount = successors.length; state.neverConcurrentOwners = neverConcurrent;
    const next = successors[0] && await ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${successors[0].id}`); state.successor = next; state.successorRunId = next?.id;
    const context = next?.contextSnapshot as { interactionId?: string; forceFreshSession?: boolean; planReviewInteraction?: { target?: { revisionId?: string }; acceptedTargetRevision?: { revisionId?: string } } } | undefined;
    state.acceptedDirectionInputBound = context?.interactionId === confirmation.id && [context.planReviewInteraction?.target?.revisionId, context.planReviewInteraction?.acceptedTargetRevision?.revisionId].includes((state.plan as Entity).latestRevisionId);
    state.freshSessionBound = context?.forceFreshSession === true;
    state.queueEmptyAfterDelivery = delivered.queue.entries.length === 0;
    const events = await collectRunEvents<{ seq?: number; eventType?: string }>((afterSeq, limit) => ctx.input.api.get(`/api/heartbeat-runs/${state.workerRunId}/events?afterSeq=${afterSeq}&limit=${limit}`));
    state.oldEvidenceRetained = stopped.status === "cancelled" && events.length > 0;
    await ctx.input.capture("actual-native-interruption", "Stopped native attempt and one actual eligible fresh continuation retain accepted direction", "runtime-native-interruption.png");
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) { const o = await observeRuntime(ctx, state), task = state.task as Entity, plan = state.plan as Entity;
    const revisions = await ctx.input.api.get<Entity[]>(`/api/issues/${task.id}/documents/plan/revisions`); state.planRevisionRetained = revisions.some(row => row.id === plan.latestRevisionId && row.body === state.planBody);
    if (state.successorRunId) { const [artifact] = await readRegisteredArtifacts(ctx.input.api, task.id, String(state.successorRunId), ["website.html"]);
      state.actualSimplePage = artifact?.contentVerified === true && hasSimplerWebsite(await renderRuntimeArtifact(ctx, artifact.content));
      state.deliveryRevisionBound = o.revisions.some(row => row.createdByRunId === state.successorRunId && row.createdByAgentId === (state.worker as Entity).id && (row.body ?? "").includes(String(state.marker)) && o.documents.some(doc => doc.id === row.documentId && doc.latestRevisionId === row.id)); }
    return o; },
  async verifyResult(ctx, state) { const source = ctx.input.page.url(), task = state.task as Entity;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" }); await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("button", { name: "Change status (current: Done)", exact: true }).first()).toBeVisible(); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); },
  cleanup: async (_ctx, state) => releaseRuntimeWorker(state),
})];
