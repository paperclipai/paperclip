import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import { expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { HeartbeatRun } from "../../../packages/shared/src/types/heartbeat.js";
import type { Issue } from "../../../packages/shared/src/types/issue.js";
import { pollUntil } from "../api.js";
import { checks, type Entity } from "./internal-support.js";
import { prepareRuntimeWorkerGate, releasedRetryListener, releaseRuntimeWorker, retriesOriginalRun, type RuntimeBriefGate } from "./runtime-busy-worker.js";
import { controllerReadRecovery, linksSourceTask, sourceRunRecovery, type SourceRecoveryActions } from "./runtime-infrastructure.js";
import { unavailableNativeModelFailure } from "./runtime-native-failure.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, type RuntimeAgent } from "./runtime-support.js";
export function humanRetryControl(page: Page) {
  return page.getByTestId("task-chat-run-failed-try-again").or(page.getByTestId("task-execution-retry")).last();
}
export function isHumanRetryRequest(request: { method(): string; url(): string }, taskId: string, workerId: string) {
  const path = new URL(request.url()).pathname;
  return request.method() === "POST" && (path === `/api/agents/${workerId}/wakeup` || path === `/api/issues/${taskId}/retry`);
}
export { releasedRetryListener, retriesOriginalRun };
export const PERSON_OWNED_RETRY_FAILURE_CODE = "native_provider_model_rejected";
export function isPersonOwnedRetryFailure(input: { run?: Pick<HeartbeatRun, "id" | "status" | "errorCode" | "companyId" | "agentId"> & { nativePhase?: string | null }; companyId: string; agentId: string;
  taskStatus?: string; freshContinuations: number; successorRuns: number }) {
  const run = input.run;
  return !!run && run.status === "failed" && run.errorCode === PERSON_OWNED_RETRY_FAILURE_CODE && run.companyId === input.companyId && run.agentId === input.agentId
    && input.taskStatus === "blocked" && input.freshContinuations === 0 && input.successorRuns === 0;
}
export async function personOwnedNativeFailure(ctx: ChatCatalogContext) {
  const { worker, gate, company } = await prepareRuntimeWorkerGate(ctx, { taskBound: true });
  let task: Entity | undefined;
  const failure = await unavailableNativeModelFailure(ctx, worker, async () => {
    task = await ctx.input.api.post<Entity>(`${company}/issues`, { title: "Website task", status: "todo", assigneeAgentId: worker.id, allowDuplicate: true,
      description: `The website brief is being supplied by the human. Run ${gate.command} once and wait for its real output. Do not invent a brief, replace the script, or mark work complete before it returns. Once the brief arrives, save it as a task document and finish normally.` });
    return { issueId: task.id };
  });
  if (!task || failure.failedIssueId !== task.id) throw new Error("Person-owned failure did not stop the fixture's own Website task");
  const workingModel = String(failure.originalConfiguration.adapterConfig?.model ?? "");
  const kept = await ctx.input.api.patch<RuntimeAgent>(`/api/agents/${worker.id}`, { adapterConfig: { ...failure.originalConfiguration.adapterConfig, model: failure.failedModel } });
  if (kept.adapterConfig?.model !== failure.failedModel || !workingModel) throw new Error("The rejected model is not the agent's selected model before Retry");
  const companyId = ctx.input.fixtures.company.id, failedRunId = failure.failedRun.id, websiteId = task.id;
  const load = async () => {
    const [current, run, recovery, runs] = await Promise.all([ctx.input.api.get<Issue>(`/api/issues/${websiteId}`), ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${failedRunId}`),
      sourceRunRecovery(ctx, websiteId, failedRunId), ctx.allRuns()]);
    return { current, run, recovery, freshContinuations: (recovery.actions ?? []).filter(action => !!(action.evidence as Record<string, unknown>).freshContinuation).length,
      successorRuns: runs.filter(row => row.agentId === worker.id && row.id !== failedRunId).length };
  };
  const accepted = (v: Awaited<ReturnType<typeof load>>) => isPersonOwnedRetryFailure({ run: v.run, companyId, agentId: worker.id, taskStatus: v.current.status,
    freshContinuations: v.freshContinuations, successorRuns: v.successorRuns });
  await pollUntil({ label: "The person-owned failure waits for the person's Retry", deadlineAt: Date.now() + 90_000, load, accept: accepted,
    reject: v => v.successorRuns > 0 || v.freshContinuations > 0 ? "A person-owned failure was continued without the person" : undefined });
  const settled = await pollUntil({ label: "No automatic continuation follows the person-owned failure", deadlineAt: Date.now() + 60_000, load,
    accept: v => accepted(v) && Date.now() - Date.parse(String(v.run.finishedAt)) >= 45_000,
    reject: v => accepted(v) ? undefined : "A person-owned failure was continued without the person" });
  const before = await ctx.input.api.get<SourceRecoveryActions>(`/api/issues/${websiteId}/recovery-actions`);
  await ctx.input.evidence("runtime-person-owned-failure.json", { runId: failedRunId, errorCode: settled.run.errorCode, taskStatus: settled.current.status,
    activeRecovery: before.active ? { id: before.active.id, ownerType: before.active.ownerType, cause: before.active.cause, status: before.active.status } : null,
    freshContinuations: settled.freshContinuations, successorRuns: settled.successorRuns });
  return { worker, gate, task: settled.current, workerRunId: failedRunId, failure: settled.run, recoveryBefore: before.active ?? null,
    freshContinuationsBefore: settled.freshContinuations, successorRunsBefore: settled.successorRuns, failureKind: failure.failureKind,
    rejectedModel: failure.failedModel, workingModel, originalAdapterConfig: failure.originalConfiguration.adapterConfig };
}
export const MODEL_STILL_UNAVAILABLE_CODE = "native_provider_model_still_unavailable";
const MODEL_SETTINGS_PATH = /\/agents\/[^/]+\/runtime$/;
export function gradeInfrastructureRetry(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("actual-person-owned-failure-retry-and-model-recheck", !!o, "The genuine person-owned native failure, the real human Try again control and the independently observed model recheck are required."); if (!o) return c.result();
  const s = o.state;
  c.add("actual-person-owned-failure-awaits-retry", isPersonOwnedRetryFailure({ run: s.failure as HeartbeatRun, companyId: o.companyId, agentId: (s.worker as Entity)?.id,
    taskStatus: (s.task as Issue)?.status, freshContinuations: Number(s.freshContinuationsBefore), successorRuns: Number(s.successorRunsBefore) }),
    "The original task stopped because the provider rejected its selected model, stays blocked for the person, and the system starts no continuation of its own.");
  c.add("ordinary-human-retry-guidance", s.queryRecoveryRead === true && s.retryVisible === true && linksSourceTask(o, s.task as Entity),
    "The canonical reply comes from a run that read the saved recovery record and links the original task, where the real Try again control is visible on the model failure.");
  c.add("retry-rechecks-the-still-rejected-model", Number(s.refusedRetryStatus) === 409 && s.refusalCode === MODEL_STILL_UNAVAILABLE_CODE
    && s.refusalNamedRejectedModel === true && s.refusalLinksModelSetting === true && s.noRunWhileModelUnavailable === true && s.taskBlockedAfterRefusal === true,
  "Try again while the rejected model is still selected starts no run, keeps the task blocked and tells the person which setting to change, with a working link to it.");
  c.add("one-retry-after-model-fixed-completes", s.modelFixedByHuman === true && Number(s.fixedRetryStatus) === 202 && s.retryRunCount === 1
    && s.retryBoundToOriginal === true && s.retryAdmissionAfterFix === true && s.retryUsedFixedModel === true
    && s.originalFailureRetained === true && s.actualRetryResult === true
    && o.tasks.length === 1 && o.tasks[0]?.id === (s.task as Entity).id && o.tasks[0]?.status === "done"
    && o.runs.length === 3 && o.runs.filter(row => row.status === "failed").length === 1 && o.runs.filter(row => row.status === "succeeded").length === 2,
  "After the person selects a working model, one Try again starts exactly one retry of the original run with that model, retains the original failure and saves the real Website result.");
  return c.result();
}
export const runtimeInfrastructureRetryCases = [runtimeDefinition("recovery.retry-exhausted", personOwnedNativeFailure, gradeInfrastructureRetry, {
  oracleVersion: "paperclip.chat-catalog.runtime.retry-exhausted.v7", authentication: "human-session", expectedHumanMessageCount: 1, expectedRunCount: 3, attemptTimeoutMs: 1_200_000,
  setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["lead-ready", "person-owned-failure-awaits-retry"] },
  async verifySetup(ctx, state) { const c = checks(), lead = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`), task = state.task as Issue, worker = state.worker as Entity;
    const [current, run, recovery, runs] = await Promise.all([ctx.input.api.get<Issue>(`/api/issues/${task.id}`), ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${state.workerRunId}`),
      sourceRunRecovery(ctx, task.id, String(state.workerRunId)), ctx.allRuns()]);
    c.add("lead-ready", lead.lifecycleState === "ready" && ["active", "idle"].includes(lead.status ?? ""), "The actual controller remains independently admitted.");
    c.add("person-owned-failure-awaits-retry", isPersonOwnedRetryFailure({ run, companyId: ctx.input.fixtures.company.id, agentId: worker.id, taskStatus: current.status,
      freshContinuations: (recovery.actions ?? []).filter(action => !!(action.evidence as Record<string, unknown>).freshContinuation).length,
      successorRuns: runs.filter(row => row.agentId === worker.id && row.id !== run.id).length }), "The original task waits for the person's Retry after a failure only the person can resolve."); return c.result(); },
  runPolicy: { kind: "terminal-counts", terminalStatusCounts: { failed: 1, succeeded: 2 } },
  sourceFiles: ["chat-catalog-domains/runtime-infrastructure-retry.ts", "chat-catalog-domains/runtime-infrastructure.ts", "chat-catalog-domains/api-read-receipts.ts", "chat-catalog-domains/runtime-native-fault.ts", "chat-catalog-domains/runtime-native-failure.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "../../server/src/services/hot-restart.ts", "../../server/src/vendor/paperclip-runner/index.ts", "chat-scenarios/recovery.yaml"],
  async act(ctx, state) {
    const task = state.task as Issue, worker = state.worker as RuntimeAgent;
    const initial = await pollUntil({ label: "Canonical human Retry guidance after the person-owned failure", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.some(row => row.id === state.workerRunId && row.status === "failed") && v.runs.some(row => row.agentId === ctx.input.fixtures.agent.id && row.status === "succeeded")) });
    state.queryReply = (await observeRuntime(ctx, state)).reply; const source = ctx.input.page.url();
    state.queryRecoveryRead = await controllerReadRecovery(ctx, initial.runs.find(row => row.agentId === ctx.input.fixtures.agent.id)?.id, task.id, String(state.workerRunId), task.identifier);
    const taskURL = `/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`;
    await ctx.input.page.goto(taskURL, { waitUntil: "domcontentloaded" });
    const retry = humanRetryControl(ctx.input.page); await expect(retry).toBeVisible(); state.retryVisible = true;
    const workerRetryRuns = async () => (await ctx.allRuns()).filter(row => row.agentId === worker.id && row.id !== state.workerRunId).length;
    const refused = ctx.input.page.waitForResponse(r => isHumanRetryRequest(r.request(), task.id, worker.id));
    await retry.click(); const refusal = await refused; state.refusedRetryStatus = refusal.status();
    const refusalBody = await refusal.json().catch(() => null) as { error?: unknown; details?: { code?: unknown; rejectedModel?: unknown } } | null;
    state.refusalCode = refusalBody?.details?.code ?? null;
    const notice = ctx.input.page.getByRole("listitem").filter({ hasText: "Model still unavailable" }).first();
    await expect(notice).toBeVisible({ timeout: 10_000 });
    state.refusalNamedRejectedModel = (await notice.textContent() ?? "").includes(String(state.rejectedModel));
    const settingsLink = notice.getByRole("link").first();
    const linked = await settingsLink.count() === 1;
    await ctx.input.capture("model-still-unavailable-refusal", "Try again names the model setting while the rejected model is still selected", "runtime-retry-model-refused.png");
    const refusalSamples = [await workerRetryRuns()];
    if (linked) {
      await settingsLink.click();
      await ctx.input.page.waitForURL(url => MODEL_SETTINGS_PATH.test(url.pathname), { timeout: 15_000 }).catch(() => undefined);
    }
    state.refusalLinksModelSetting = linked && MODEL_SETTINGS_PATH.test(new URL(ctx.input.page.url()).pathname)
      && new URL(ctx.input.page.url()).pathname.includes(`/agents/${worker.urlKey ?? worker.id}/`);
    await ctx.input.page.waitForTimeout(20_000);
    refusalSamples.push(await workerRetryRuns()); state.refusalRunSamples = refusalSamples;
    state.noRunWhileModelUnavailable = refusalSamples.every(count => count === 0);
    state.taskBlockedAfterRefusal = (await ctx.input.api.get<Issue>(`/api/issues/${task.id}`)).status === "blocked";
    const fixed = await ctx.input.api.patch<RuntimeAgent>(`/api/agents/${worker.id}`, { adapterConfig: { ...(state.originalAdapterConfig as Record<string, unknown>), model: state.workingModel } });
    state.modelFixedByHuman = fixed.adapterConfig?.model === state.workingModel && fixed.adapterConfig?.model !== state.rejectedModel;
    state.modelFixedAt = Date.now();
    await ctx.input.page.goto(taskURL, { waitUntil: "domcontentloaded" });
    const again = humanRetryControl(ctx.input.page); await expect(again).toBeVisible();
    const accepted = ctx.input.page.waitForResponse(r => isHumanRetryRequest(r.request(), task.id, worker.id));
    await again.click(); state.fixedRetryStatus = (await accepted).status();
    const gateName = (state.gate as RuntimeBriefGate).gateName!;
    const released = await pollUntil({ label: "The Retry after the model fix listens for the brief in its own workspace", deadlineAt: Date.now() + 180_000,
      load: async () => {
        const retries = (await ctx.allRuns()).filter(row => row.agentId === worker.id && row.id !== state.workerRunId);
        const run = retries.length === 1 ? await ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${retries[0]!.id}`) : null;
        return { retries: retries.length, run, listener: run ? await releasedRetryListener(run, { companyId: ctx.input.fixtures.company.id, workerId: worker.id,
          taskId: task.id, originalRunId: String(state.workerRunId), gateName }) : null };
      },
      accept: v => v.retries === 1 && !!v.listener,
      reject: v => v.retries > 1 ? "Try again started more than one run" : v.run && ["failed", "cancelled", "timed_out"].includes(v.run.status) ? "The retry after the model fix stopped" : undefined });
    state.retryWorkspaceId = released.listener!.workspaceId;
    await writeFile(released.listener!.gate, `The authorized human fixed the model. Use the preserved task context and save a non-plan website-delivery document with the exact reference Retry website ${ctx.input.nonce}, a semantic single-page Acorn website outline and an accessible signup action, then complete this original task normally. Do not create more tasks or external effects.`, "utf8");
    const completed = await pollUntil({ label: "The one Retry after the model fix completes the original task", deadlineAt: Date.now() + 240_000,
      load: async () => ({ task: await ctx.input.api.get<Issue>(`/api/issues/${task.id}`), runs: await ctx.allRuns() }),
      accept: v => v.task.status === "done" && v.runs.length === 3 && v.runs.filter(row => row.id !== state.workerRunId).every(row => row.status === "succeeded"),
      reject: v => v.runs.length > 3 || v.runs.some(row => row.id !== state.workerRunId && ["failed", "cancelled", "timed_out"].includes(row.status)) ? "The retry failed or duplicated native work" : undefined });
    const retried = completed.runs.filter(row => row.agentId === worker.id && row.id !== state.workerRunId); state.retryRunCount = retried.length;
    const full = retried[0] && await ctx.input.api.get<HeartbeatRun & { runnerProfileJson?: { nativeExecutionInput?: { provider?: { model?: string | null } } } }>(`/api/heartbeat-runs/${retried[0].id}`); state.retryRunId = full?.id;
    state.retryBoundToOriginal = !!full && retriesOriginalRun(full, String(state.workerRunId)) && [full.contextSnapshot?.issueId, full.contextSnapshot?.taskId].includes(task.id);
    state.retryAdmissionAfterFix = !!full && Date.parse(String(full.createdAt)) >= Number(state.modelFixedAt);
    state.retryUsedFixedModel = full?.runnerProfileJson?.nativeExecutionInput?.provider?.model === state.workingModel;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
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
