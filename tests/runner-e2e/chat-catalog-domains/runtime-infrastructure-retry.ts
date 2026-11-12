import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { expect, type Page } from "@playwright/test";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HeartbeatRun } from "../../../packages/shared/src/types/heartbeat.js";
import type { Issue, IssueRecoveryAction } from "../../../packages/shared/src/types/issue.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { checks, type Entity } from "./internal-support.js";
import { releaseRuntimeWorker, type RuntimeBriefGate } from "./runtime-busy-worker.js";
import { controllerReadRecovery, exhaustedNativeInfrastructure, isExhaustedNativeRecovery, linksSourceTask, runtimeInfrastructureCases } from "./runtime-infrastructure.js";
import type { NativeFaultRun } from "./runtime-native-fault.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, type RuntimeAgent } from "./runtime-support.js";
/** The person's Retry for the stopped task: the failed-run marker in the
 * thread, or the task's own Retry when automatic recovery has stopped and the
 * run is held for recovery (the thread then omits the marker's Retry). */
export function humanRetryControl(page: Page) {
  return page.getByTestId("task-chat-run-failed-try-again").or(page.getByTestId("task-execution-retry")).last();
}
/** Either supported Retry request for this task and its assignee. */
export function isHumanRetryRequest(request: { method(): string; url(): string }, taskId: string, workerId: string) {
  const path = new URL(request.url()).pathname;
  return request.method() === "POST" && (path === `/api/agents/${workerId}/wakeup` || path === `/api/issues/${taskId}/retry`);
}
/**
 * Whether a run is a Retry of the original run. A person's task Retry names its
 * source in the execution continuation (`task_retry` from the original run);
 * an automatic scheduled retry names it in `retryOfRunId`.
 */
export function retriesOriginalRun(run: Pick<HeartbeatRun, "retryOfRunId" | "contextSnapshot">, originalRunId: string) {
  if (run.retryOfRunId === originalRunId) return true;
  const context = (run.contextSnapshot ?? {}) as { previousRunId?: unknown; executionContinuation?: { trigger?: { reason?: unknown; sourceRunId?: unknown } } };
  const trigger = context.executionContinuation?.trigger;
  return context.previousRunId === originalRunId && trigger?.reason === "task_retry" && trigger.sourceRunId === originalRunId;
}
/**
 * The released Retry's own brief listener. A Retry can start in a fresh
 * isolated workspace, so read the directory from that run's saved execution
 * input, never from the task's earlier binding. It must be the worker's one
 * retry of the original run for this task, inside the owned attempt root, and
 * its script must already wait for the brief there.
 */
export async function releasedRetryListener(run: HeartbeatRun, expected: { companyId: string; workerId: string; taskId: string; originalRunId: string; gateName: string },
  root = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT) {
  const profile = (run as { runnerProfileJson?: { nativeExecutionInput?: { workspace?: { cwd?: unknown }; binding?: { executionWorkspaceId?: unknown } } } }).runnerProfileJson;
  const cwd = profile?.nativeExecutionInput?.workspace?.cwd, workspaceId = profile?.nativeExecutionInput?.binding?.executionWorkspaceId;
  if (!root || run.companyId !== expected.companyId || run.agentId !== expected.workerId || !retriesOriginalRun(run, expected.originalRunId)
    || ![run.contextSnapshot?.issueId, run.contextSnapshot?.taskId].includes(expected.taskId) || typeof cwd !== "string" || typeof workspaceId !== "string") return null;
  const real = await realpath(cwd).catch(() => null), ownedRoot = await realpath(root);
  if (!real || !real.startsWith(`${ownedRoot}${path.sep}`)) return null;
  const ready = await realpath(path.join(real, `${expected.gateName}.waiting`)).catch(() => null);
  if (!ready || path.dirname(ready) !== real || (await readFile(ready, "utf8")).trim() !== "waiting") return null;
  return { gate: path.join(real, expected.gateName), workspaceId };
}
export function gradeInfrastructureRetry(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("actual-exhausted-retry-and-current-gates", !!o, "The genuine exhausted native run, real human Retry controls and independently observed admission gates are required."); if (!o) return c.result();
  const s = o.state;
  c.add("actual-original-infrastructure-exhaustion", !!s.failure && isExhaustedNativeRecovery(s.recoveryBefore as IssueRecoveryAction, s.failure as NativeFaultRun, o.companyId, (s.task as Entity).id, (s.worker as Entity).id),
    "The original task really exposes the exhausted three-attempt native infrastructure action; an unavailable-model failure is insufficient.");
  // Reply wording is not graded: each declared phase is bound to its own
  // controller run, which must have read the task's saved recovery record or
  // runs before answering. A person reads the replies for meaning.
  c.add("ordinary-human-retry-guidance", s.queryRecoveryRead === true && s.retryVisible === true && linksSourceTask(o, s.task as Entity),
    "The canonical reply comes from a run that read the saved recovery record and links the original task, where the real human Retry control is visible.");
  c.add("actual-closed-gate-prevents-new-execution", s.budgetHeldBeforeRetry === true && [200, 202, 409].includes(Number(s.heldRetryStatus))
    && s.noAdmissionUnderBudget === true && s.failedRunVisibleWhileHeld === true && s.heldReplyAttributed === true && s.heldRecoveryRead === true,
  "The first real Retry cannot start under the independently saved budget hold, retains failure visibly, and its own subsequent chat run reads the task's actual runs before replying.");
  // The one accepted Retry is the held one: the product saves it and starts it
  // once the gate clears. No second Retry exists, and none is offered.
  c.add("one-accepted-eligible-retry-preserves-original-failure", s.budgetRestoredByHuman === true && Number(s.heldRetryStatus) === 202 && s.noDuplicateRetryWhileHeld === true
    && s.retryBoundToOriginal === true && s.retryRunCount === 1
    && s.retryAdmissionAfterGateClear === true && s.originalFailureRetained === true && s.actualRetryResult === true
    && o.tasks.length === 1 && o.tasks[0]?.id === (s.task as Entity).id && o.tasks[0]?.status === "done"
    && o.runs.length === 5 && o.runs.filter(row => row.status === "failed").length === 1 && o.runs.filter(row => row.status === "succeeded").length === 4,
  "Once the actual human restores the gate, exactly one eligible native retry uses the server-owned failed task context, retains that original failure and saves the real Website result.");
  c.add("own-final-phase-reports-actual-result", s.finalReplyAttributed === true && s.finalRecoveryRead === true,
    "A separately declared factual follow-up receives its own native reply from a run that read the task's actual runs.");
  return c.result();
}
export const runtimeInfrastructureRetryCases = [runtimeDefinition("recovery.retry-exhausted", exhaustedNativeInfrastructure, gradeInfrastructureRetry, {
  oracleVersion: "paperclip.chat-catalog.runtime.retry-exhausted.v5", authentication: "human-session", expectedHumanMessageCount: 3, expectedRunCount: 5, attemptTimeoutMs: 1_800_000,
  setupPolicy: runtimeInfrastructureCases[0]!.setupPolicy, verifySetup: runtimeInfrastructureCases[0]!.verifySetup,
  runPolicy: { kind: "terminal-counts", terminalStatusCounts: { failed: 1, succeeded: 4 } },
  sourceFiles: ["chat-catalog-domains/runtime-infrastructure-retry.ts", "chat-catalog-domains/runtime-infrastructure.ts", "chat-catalog-domains/api-read-receipts.ts", "chat-catalog-domains/runtime-native-fault.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "../../server/src/services/hot-restart.ts", "../../server/src/vendor/paperclip-runner/index.ts", "chat-scenarios/recovery.yaml"],
  async act(ctx, state) {
    const task = state.task as Issue, worker = state.worker as RuntimeAgent;
    const initial = await pollUntil({ label: "Canonical human Retry guidance after actual infrastructure exhaustion", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.some(row => row.id === state.workerRunId && row.status === "failed") && v.runs.some(row => row.agentId === ctx.input.fixtures.agent.id && row.status === "succeeded")) });
    state.queryReply = (await observeRuntime(ctx, state)).reply; const source = ctx.input.page.url(), root = `/api/companies/${ctx.input.fixtures.company.id}`;
    const taskURL = `/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`;
    await ctx.input.page.goto(taskURL, { waitUntil: "domcontentloaded" });
    const retry = humanRetryControl(ctx.input.page); await expect(retry).toBeVisible(); state.retryVisible = true;
    // A zero amount disables enforcement. Hold with a real cap and one explicit
    // synthetic accounting receipt over it, imported through the public path;
    // this is not model/provider spend. Restoring 500 cents later lifts it.
    await ctx.input.api.post(`${root}/budgets/policies`, { scopeType: "agent", scopeId: worker.id, amount: 100, isActive: true, hardStopEnabled: true, unpricedUsagePolicy: "allow" });
    const budgetReceipt = await ctx.input.api.post<{ id: string }>(`${root}/cost-events`, { agentId: worker.id, provider: "synthetic-eval-import", biller: "synthetic-eval-import",
      model: "imported-fixture-receipt", billingType: "metered_api", costStatus: "reported", costCents: 125, inputTokens: 0, outputTokens: 0,
      occurredAt: new Date().toISOString(), idempotencyKey: `retry-exhausted-held:${ctx.input.nonce}` });
    if (typeof budgetReceipt.id !== "string" || !budgetReceipt.id) throw new Error("Missing public synthetic accounting fixture receipt");
    await ctx.input.evidence("runtime-retry-imported-budget-context.json", { agentId: worker.id, receiptId: budgetReceipt.id, origin: "public-imported-synthetic-fixture",
      importedFixtureCostCents: 125, hardCapCents: 100, modelProviderUsage: "Not model/provider usage; explicit public synthetic accounting fixture" });
    const held = await pollUntil({ label: "Real current budget hold before first human Retry", deadlineAt: Date.now() + 45_000, load: () => ctx.input.api.get<RuntimeAgent>(`/api/agents/${worker.id}`), accept: row => row.lifecycleHolds?.includes("budget") === true });
    state.budgetHeldBeforeRetry = held.lifecycleHolds?.includes("budget") === true;
    const rejected = ctx.input.page.waitForResponse(r => isHumanRetryRequest(r.request(), task.id, worker.id));
    await retry.click(); state.heldRetryStatus = (await rejected).status();
    // The worker's runs other than the exhausted one. None may exist while held.
    const workerRetryRuns = async () => (await ctx.allRuns()).filter(row => row.agentId === worker.id && row.id !== state.workerRunId).length;
    const holdSamples = [await workerRetryRuns()];
    // Wait on the open page as a person would, without reloading: the task
    // keeps the failure and names the budget wait. The saved Retry starts by
    // itself later, so no second Retry control is offered.
    const waiting = ctx.input.page.getByTestId("task-execution-waiting");
    await expect(waiting).toBeVisible({ timeout: 60_000 });
    const waitingText = await waiting.textContent() ?? "";
    state.failedRunVisibleWhileHeld = waitingText.includes("Couldn’t finish this attempt") && /budget/i.test(waitingText);
    state.noDuplicateRetryWhileHeld = await humanRetryControl(ctx.input.page).count() === 0;
    holdSamples.push(await workerRetryRuns());
    await ctx.input.capture("actual-retry-gate-held", "Original native failure remains visible when current budget prevents Retry admission", "runtime-retry-budget-held.png");
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    const heldQuery = `I tried the supported Retry on Website ${task.identifier ?? task.id} while Morgan's actual budget is held. Did a new attempt start, and what current gate is stopping it?`;
    await sendChatMessage(ctx.input.page, heldQuery, chatCatalogNativePhaseRemainingBudget(ctx));
    const heldPhase = await pollUntil({ label: "Own chat phase reports actual non-admission under current budget", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; }, accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 3 && v.runs.filter(row => row.agentId === ctx.input.fixtures.agent.id).every(row => row.status === "succeeded")) });
    const phaseReply = async (query: string, runId: string) => {
      const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`), human = comments.filter(row => !row.authorAgentId && row.body === query), replies = comments.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id && row.createdByRunId === runId);
      const detail = await ctx.input.api.get<{ runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${runId}`);
      return { attributed: human.length === 1 && replies.length > 0 && detail.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(human[0]!.id) === true, body: replies.map(row => row.body).join("\n") };
    };
    const heldRun = heldPhase.runs.find(row => !initial.runs.some(prior => prior.id === row.id) && row.agentId === ctx.input.fixtures.agent.id);
    if (!heldRun) throw new Error("Held retry response lacks an actual subsequent native turn");
    const heldReply = await phaseReply(heldQuery, heldRun.id); state.heldReply = heldReply.body; state.heldReplyAttributed = heldReply.attributed;
    state.queryRecoveryRead = await controllerReadRecovery(ctx, initial.runs.find(row => row.agentId === ctx.input.fixtures.agent.id)?.id, task.id, String(state.workerRunId), task.identifier);
    state.heldRecoveryRead = await controllerReadRecovery(ctx, heldRun.id, task.id, String(state.workerRunId), task.identifier);
    // Sampled at the click, on the waiting page, and after the held chat phase.
    holdSamples.push(await workerRetryRuns()); state.heldWorkerRetryRunSamples = holdSamples;
    state.noAdmissionUnderBudget = holdSamples.every(count => count === 0);
    state.gatesClearedAt = Date.now();
    await ctx.input.api.post(`${root}/budgets/policies`, { scopeType: "agent", scopeId: worker.id, amount: 500, isActive: true, hardStopEnabled: true, unpricedUsagePolicy: "allow" });
    let restored = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${worker.id}`);
    if (restored.status === "error") { await ctx.input.api.post(`/api/agents/${worker.id}/clear-error`, {}); restored = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${worker.id}`); }
    state.budgetRestoredByHuman = !restored.lifecycleHolds?.includes("budget");
    // No second click: the held Retry is the one accepted Retry. A Retry may
    // start in a fresh isolated workspace when the task does not own its
    // directory, so bind the brief to the workspace the released run actually
    // uses: wait for its listener there, then supply the brief.
    const gateName = (state.gate as RuntimeBriefGate).gateName!;
    const released = await pollUntil({ label: "Released Retry listens for the brief in its own workspace", deadlineAt: Date.now() + 180_000,
      load: async () => {
        const retries = (await ctx.allRuns()).filter(row => row.agentId === worker.id && row.id !== state.workerRunId);
        const run = retries.length === 1 ? await ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${retries[0]!.id}`) : null;
        return { retries: retries.length, listener: run ? await releasedRetryListener(run, { companyId: ctx.input.fixtures.company.id, workerId: worker.id,
          taskId: task.id, originalRunId: String(state.workerRunId), gateName }) : null };
      },
      accept: v => v.retries === 1 && !!v.listener,
      reject: v => v.retries > 1 ? "The held Retry started more than once" : undefined });
    const brief = { gate: released.listener!.gate };
    state.retryWorkspaceId = released.listener!.workspaceId; state.retryWorkspaceFresh = released.listener!.workspaceId !== (state.gate as RuntimeBriefGate).boundWorkspaceId;
    await writeFile(brief.gate, `The authorized human has restored the execution gate. Use the preserved task context and save a non-plan website-delivery document with the exact reference Retry website ${ctx.input.nonce}, a semantic single-page Acorn website outline and an accessible signup action, then complete this original task normally. Do not create more tasks or external effects.`, "utf8");
    const completed = await pollUntil({ label: "The held Retry starts once, by itself, after actual gate restoration", deadlineAt: Date.now() + 240_000,
      load: async () => ({ task: await ctx.input.api.get<Issue>(`/api/issues/${task.id}`), runs: await ctx.allRuns() }),
      accept: v => v.task.status === "done" && v.runs.length === 4 && v.runs.filter(row => row.id !== state.workerRunId).every(row => row.status === "succeeded"),
      reject: v => v.runs.length > 4 || v.runs.some(row => row.id !== state.workerRunId && ["failed", "cancelled", "timed_out"].includes(row.status)) ? "Eligible Retry failed or duplicated native work" : undefined });
    const retried = completed.runs.filter(row => row.agentId === worker.id && row.id !== state.workerRunId); state.retryRunCount = retried.length;
    const full = retried[0] && await ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${retried[0].id}`); state.retryRunId = full?.id;
    state.retryBoundToOriginal = !!full && retriesOriginalRun(full, String(state.workerRunId)) && [full.contextSnapshot?.issueId, full.contextSnapshot?.taskId].includes(task.id);
    state.retryAdmissionAfterGateClear = !!full && Date.parse(String(full.createdAt)) >= Number(state.gatesClearedAt);
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    const finalQuery = `I restored Morgan's budget and used the supported Retry for Website ${task.identifier ?? task.id}. What is the actual result now, and is the earlier exhausted attempt still retained?`;
    await sendChatMessage(ctx.input.page, finalQuery, chatCatalogNativePhaseRemainingBudget(ctx));
    const final = await pollUntil({ label: "Own final source reply reports actual eligible Retry result", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; }, accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 5 && v.runs.filter(row => row.id !== state.workerRunId).every(row => row.status === "succeeded")) });
    const finalRun = final.runs.find(row => !completed.runs.some(prior => prior.id === row.id))!;
    const finalReply = await phaseReply(finalQuery, finalRun.id); state.finalReply = finalReply.body; state.finalReplyAttributed = finalReply.attributed;
    state.finalRecoveryRead = await controllerReadRecovery(ctx, finalRun.id, task.id, String(state.workerRunId), task.identifier);
  },
  async observe(ctx, state) { const o = await observeRuntime(ctx, state);
    const before = state.failure as HeartbeatRun, retained = await ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${state.workerRunId}`);
    state.originalFailureRetained = retained.id === before.id && retained.status === "failed" && retained.errorCode === before.errorCode && retained.finishedAt === before.finishedAt;
    state.actualRetryResult = o.revisions.some(row => row.createdByRunId === state.retryRunId && row.createdByAgentId === (state.worker as Entity).id && (row.body ?? "").includes(`Retry website ${ctx.input.nonce}`)
      && o.documents.some(doc => doc.id === row.documentId && doc.latestRevisionId === row.id)); return o; },
  async verifyResult(ctx, state) { const source = ctx.input.page.url(), task = state.task as Issue;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" }); await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("button", { name: "Change status (current: Done)", exact: true }).first()).toBeVisible(); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); },
  cleanup: async (_ctx, state) => releaseRuntimeWorker(state),
})];
