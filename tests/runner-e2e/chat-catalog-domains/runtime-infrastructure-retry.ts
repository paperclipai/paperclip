import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { HeartbeatRun } from "../../../packages/shared/src/types/heartbeat.js";
import type { Issue, IssueRecoveryAction } from "../../../packages/shared/src/types/issue.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { checks, type Entity } from "./internal-support.js";
import { releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { exhaustedNativeInfrastructure, isExhaustedNativeRecovery, runtimeInfrastructureCases } from "./runtime-infrastructure.js";
import type { NativeFaultRun } from "./runtime-native-fault.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, type RuntimeAgent } from "./runtime-support.js";
export function gradeInfrastructureRetry(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("actual-exhausted-retry-and-current-gates", !!o, "The genuine exhausted native run, real human Retry controls and independently observed admission gates are required."); if (!o) return c.result();
  const s = o.state;
  c.add("actual-original-infrastructure-exhaustion", !!s.failure && isExhaustedNativeRecovery(s.recoveryBefore as IssueRecoveryAction, s.failure as NativeFaultRun, o.companyId, (s.task as Entity).id, (s.worker as Entity).id),
    "The original task really exposes the exhausted three-attempt native infrastructure action; an unavailable-model failure is insufficient.");
  c.add("ordinary-human-retry-guidance", /retry|try again/i.test(String(s.queryReply)) && /human|board|operator|you|button|control/i.test(String(s.queryReply))
    && !/certify|attest|confirm.{0,30}(?:infrastructure|runner|cleanup).{0,30}(?:healthy|safe|stopped)/i.test(String(s.queryReply)) && s.retryVisible === true,
  "The canonical reply presents ordinary human Retry, without requiring the person to certify internal infrastructure facts.");
  c.add("actual-closed-gate-prevents-new-execution", s.budgetHeldBeforeRetry === true && [202, 409].includes(Number(s.heldRetryStatus))
    && s.noAdmissionUnderBudget === true && s.failedRunVisibleWhileHeld === true && s.heldReplyAttributed === true
    && /budget|spend|cap|limit/i.test(String(s.heldReply)) && !/successfully retried|website (?:is|has been) (?:now )?(?:done|complete)|retry (?:has )?succeeded/i.test(String(s.heldReply)),
  "The first real Retry cannot start under the independently saved budget hold, retains failure visibly, and its own subsequent chat reply reports that actual gate.");
  c.add("one-accepted-eligible-retry-preserves-original-failure", s.budgetRestoredByHuman === true && s.eligibleRetryStatus === 202 && s.retryBoundToOriginal === true && s.retryRunCount === 1
    && s.retryAdmissionAfterGateClear === true && s.originalFailureRetained === true && s.actualRetryResult === true
    && o.tasks.length === 1 && o.tasks[0]?.id === (s.task as Entity).id && o.tasks[0]?.status === "done"
    && o.runs.length === 5 && o.runs.filter(row => row.status === "failed").length === 1 && o.runs.filter(row => row.status === "succeeded").length === 4,
  "Once the actual human restores the gate, exactly one eligible native retry uses the server-owned failed task context, retains that original failure and saves the real Website result.");
  c.add("own-final-phase-reports-actual-result", s.finalReplyAttributed === true && /website/i.test(String(s.finalReply)) && /done|complete|finish|ready|delivered/i.test(String(s.finalReply))
    && !/still (?:blocked|waiting)|not yet (?:done|finished)/i.test(String(s.finalReply)),
  "A separately declared factual follow-up receives its own native reply describing the actual completed retry result.");
  return c.result();
}
export const runtimeInfrastructureRetryCases = [runtimeDefinition("recovery.retry-exhausted", exhaustedNativeInfrastructure, gradeInfrastructureRetry, {
  authentication: "human-session", expectedHumanMessageCount: 3, expectedRunCount: 5, attemptTimeoutMs: 1_800_000,
  setupPolicy: runtimeInfrastructureCases[0]!.setupPolicy, verifySetup: runtimeInfrastructureCases[0]!.verifySetup,
  runPolicy: { kind: "terminal-counts", terminalStatusCounts: { failed: 1, succeeded: 4 } },
  sourceFiles: ["chat-catalog-domains/runtime-infrastructure-retry.ts", "chat-catalog-domains/runtime-infrastructure.ts", "chat-catalog-domains/runtime-native-fault.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "../../server/src/services/hot-restart.ts", "../../server/src/vendor/paperclip-runner/index.ts", "chat-scenarios/recovery.yaml"],
  async act(ctx, state) {
    const task = state.task as Issue, worker = state.worker as RuntimeAgent;
    const initial = await pollUntil({ label: "Canonical human Retry guidance after actual infrastructure exhaustion", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.some(row => row.id === state.workerRunId && row.status === "failed") && v.runs.some(row => row.agentId === ctx.input.fixtures.agent.id && row.status === "succeeded")) });
    state.queryReply = (await observeRuntime(ctx, state)).reply; const source = ctx.input.page.url(), root = `/api/companies/${ctx.input.fixtures.company.id}`;
    const taskURL = `/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`;
    await ctx.input.page.goto(taskURL, { waitUntil: "domcontentloaded" });
    const retry = ctx.input.page.getByTestId("task-chat-run-failed-try-again").last(); await expect(retry).toBeVisible(); state.retryVisible = true;
    await ctx.input.api.post(`${root}/budgets/policies`, { scopeType: "agent", scopeId: worker.id, amount: 0, isActive: true, hardStopEnabled: true, unpricedUsagePolicy: "block" });
    const held = await pollUntil({ label: "Real current budget hold before first human Retry", deadlineAt: Date.now() + 45_000, load: () => ctx.input.api.get<RuntimeAgent>(`/api/agents/${worker.id}`), accept: row => row.lifecycleHolds?.includes("budget") === true });
    state.budgetHeldBeforeRetry = held.lifecycleHolds?.includes("budget") === true;
    const rejected = ctx.input.page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/agents/${worker.id}/wakeup`);
    await retry.click(); state.heldRetryStatus = (await rejected).status();
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByTestId("task-chat-run-failed-try-again").last()).toBeVisible(); state.failedRunVisibleWhileHeld = true;
    state.noAdmissionUnderBudget = (await ctx.allRuns()).length === 2;
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
    await ctx.input.api.post(`${root}/budgets/policies`, { scopeType: "agent", scopeId: worker.id, amount: 500, isActive: true, hardStopEnabled: true, unpricedUsagePolicy: "allow" });
    let restored = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${worker.id}`);
    if (restored.status === "error") { await ctx.input.api.post(`/api/agents/${worker.id}/clear-error`, {}); restored = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${worker.id}`); }
    state.budgetRestoredByHuman = !restored.lifecycleHolds?.includes("budget"); state.gatesClearedAt = Date.now();
    await writeFile((state.gate as { gate: string }).gate, `The authorized human has restored the execution gate. Use the preserved task context and save a non-plan website-delivery document with the exact reference Retry website ${ctx.input.nonce}, a semantic single-page Acorn website outline and an accessible signup action, then complete this original task normally. Do not create more tasks or external effects.`, "utf8");
    await ctx.input.page.goto(taskURL, { waitUntil: "domcontentloaded" }); await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    const accepted = ctx.input.page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/agents/${worker.id}/wakeup`);
    await ctx.input.page.getByTestId("task-chat-run-failed-try-again").last().click(); const acceptedResponse = await accepted; state.eligibleRetryStatus = acceptedResponse.status();
    const completed = await pollUntil({ label: "One eligible ordinary native Retry after actual gate restoration", deadlineAt: Date.now() + 240_000,
      load: async () => ({ task: await ctx.input.api.get<Issue>(`/api/issues/${task.id}`), runs: await ctx.allRuns() }),
      accept: v => v.task.status === "done" && v.runs.length === 4 && v.runs.filter(row => row.id !== state.workerRunId).every(row => row.status === "succeeded"),
      reject: v => v.runs.length > 4 || v.runs.some(row => row.id !== state.workerRunId && ["failed", "cancelled", "timed_out"].includes(row.status)) ? "Eligible Retry failed or duplicated native work" : undefined });
    const retried = completed.runs.filter(row => row.agentId === worker.id && row.id !== state.workerRunId); state.retryRunCount = retried.length;
    const full = retried[0] && await ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${retried[0].id}`); state.retryRunId = full?.id;
    state.retryBoundToOriginal = full?.retryOfRunId === state.workerRunId && [full.contextSnapshot?.issueId, full.contextSnapshot?.taskId].includes(task.id);
    state.retryAdmissionAfterGateClear = !!full && Date.parse(String(full.createdAt)) >= Number(state.gatesClearedAt);
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    const finalQuery = `I restored Morgan's budget and used the supported Retry for Website ${task.identifier ?? task.id}. What is the actual result now, and is the earlier exhausted attempt still retained?`;
    await sendChatMessage(ctx.input.page, finalQuery, chatCatalogNativePhaseRemainingBudget(ctx));
    const final = await pollUntil({ label: "Own final source reply reports actual eligible Retry result", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; }, accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 5 && v.runs.filter(row => row.id !== state.workerRunId).every(row => row.status === "succeeded")) });
    const finalRun = final.runs.find(row => !completed.runs.some(prior => prior.id === row.id))!;
    const finalReply = await phaseReply(finalQuery, finalRun.id); state.finalReply = finalReply.body; state.finalReplyAttributed = finalReply.attributed;
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
