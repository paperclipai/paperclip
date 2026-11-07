import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import type { IssueTreeHold } from "../../../packages/shared/src/types/issue-tree-control.js";
import { pollUntil } from "../api.js";
import { checks, type Entity } from "./internal-support.js";
import { probeAgentPermission, cleanupIdentityProbes } from "./identity-support.js";
import { busyRuntimeWorker, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, runtimeWorker, type RuntimeAgent } from "./runtime-support.js";
type State = Record<string, unknown>;
type TreeState = { activePauseHold: { holdId: string; rootIssueId: string; issueId: string; isRoot: boolean } | null };
export function gradeTreePause(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("actual-owned-launch-tree-evidence", !!o, "The saved Launch tree, real active children, human pause and independent child gates must be observed."); if (!o) return c.result();
  const s = o.state, parent = s.parent as Entity, held = s.pausedHold as IssueTreeHold, released = s.releasedHold as IssueTreeHold;
  const childIds = [String((s.task as Entity).id), String(((s.second as State).task as Entity).id), String((s.manualChild as Entity).id)];
  c.add("human-only-exact-launch-subtree-control", s.agentPauseStatus === 403 && s.parentUnpausedBeforeHuman === true && !!held && held.companyId === o.companyId
    && held.rootIssueId === parent.id && held.mode === "pause" && held.status === "active" && held.createdByActorType === "user"
    && held.createdByUserId === s.humanId && held.members?.length === 4 && held.members.filter(member => !member.skipped).length === 3
    && [parent.id, ...childIds].every(id => held.members?.some(member => member.issueId === id && member.companyId === o.companyId))
    && held.members.some(member => member.issueId === (s.manualChild as Entity).id && member.skipped && member.skipReason === "already_held"),
  "The agent cannot use the board-only operation; the actual human pauses precisely the parent and all three descendants.");
  c.add("honest-parent-and-persistent-pause-guidance", /Launch/i.test(String(s.queryReply)) && /pause/i.test(String(s.queryReply))
    && /subtree|tree|all.*work/i.test(String(s.queryReply)) && /you|human|board|control|menu/i.test(String(s.queryReply))
    && !/I(?:'ve| have)? (?:already )?paused|stopp?ed.*(?:alone|by itself).*(?:prevents|blocks).*future/i.test(String(s.queryReply)),
  "The canonical reply identifies the correct parent and authorized persistent task-tree control without claiming a mere stopped turn prevents later work.");
  c.add("both-active-executions-confirmed-stopped", s.bothActuallyRunning === true && s.pauseVisible === true && s.confirmedNativeStops === true
    && [s.workerRunId, (s.second as State).workerRunId].every(id => o.runs.some(row => row.id === id && row.status === "cancelled"))
    && s.pausePreventsNewAdmission === true && o.runs.length === 3,
  "Both genuine active native owners settle with durable acknowledgements and the persistent hold prevents another admission.");
  c.add("explicit-later-resume-preserves-independent-child-gates", !!released && released.id === held?.id && released.status === "released"
    && released.releasedByActorType === "user" && released.releasedByUserId === s.humanId && s.parentUnpausedAfterResume === true
    && s.independentChildHoldRetained === true && s.independentBudgetRetained === true && s.manualAgentStillPaused === true && s.resumeWakeDisabled === true,
  "A supported explicit later human resume releases only the parent hold; the child's manual pause and agent budget hold remain independently effective.");
  if (o.scenarioId === "steering.stop-versus-pause") c.add("no-invented-tomorrow-schedule", /resume|tomorrow|later|schedule/i.test(String(s.queryReply))
    && !/automatically (?:resume|restart).*tomorrow|scheduled.*(?:resume|restart).*tomorrow|will (?:resume|restart).*tomorrow/i.test(String(s.queryReply)),
  "The answer requires a supported future schedule or explicit later action and never invents a timer from a run cancellation.");
  return c.result();
}
async function setupTree(ctx: Parameters<typeof busyRuntimeWorker>[0]): Promise<State> {
  const parent = await ctx.input.api.post<Entity>(`/api/companies/${ctx.input.fixtures.company.id}/issues`, { title: "Launch", status: "backlog", assigneeAgentId: ctx.input.fixtures.agent.id });
  const manualWorker = await runtimeWorker(ctx, "Jamie");
  if (manualWorker.companyId !== ctx.input.fixtures.company.id || manualWorker.id === ctx.input.fixtures.agent.id) throw new Error("Independent tree budget fixture requires a distinct same-company worker");
  const manualChild = await ctx.input.api.post<Entity>(`/api/companies/${ctx.input.fixtures.company.id}/issues`, { title: "Launch copy", status: "backlog", parentId: parent.id, assigneeAgentId: manualWorker.id });
  await ctx.input.api.post(`/api/agents/${manualWorker.id}/pause`, {});
  await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/budgets/policies`, { scopeType: "agent", scopeId: manualWorker.id,
    amount: 100, isActive: true, hardStopEnabled: true, unpricedUsagePolicy: "allow" });
  // A zero amount disables enforcement. Seed an explicit synthetic accounting
  // fixture through the public import path; this is not model/provider spend.
  const budgetReceipt = await ctx.input.api.post<{ id: string }>(`/api/companies/${ctx.input.fixtures.company.id}/cost-events`, {
    agentId: manualWorker.id, provider: "synthetic-eval-import", biller: "synthetic-eval-import", model: "imported-fixture-receipt",
    billingType: "metered_api", costStatus: "reported", costCents: 125, inputTokens: 0, outputTokens: 0,
    occurredAt: new Date().toISOString(), idempotencyKey: `tree-held-prerequisite:${ctx.input.nonce}` });
  if (typeof budgetReceipt.id !== "string" || !budgetReceipt.id) throw new Error("Missing public synthetic accounting fixture receipt");
  await ctx.input.evidence("runtime-tree-imported-budget-context.json", { agentId: manualWorker.id, receiptId: budgetReceipt.id,
    origin: "public-imported-synthetic-fixture", importedFixtureCostCents: 125, hardCapCents: 100,
    modelProviderUsage: "Not model/provider usage; explicit public synthetic accounting fixture" });
  await pollUntil({ label: "Real independent budget hold on the manually paused child owner", deadlineAt: Date.now() + 45_000,
    load: () => ctx.input.api.get<RuntimeAgent>(`/api/agents/${manualWorker.id}`), accept: row => row.status === "paused" && row.lifecycleHolds?.includes("budget") === true });
  const manual = await ctx.input.api.post<{ hold: IssueTreeHold }>(`/api/issues/${manualChild.id}/tree-holds`, { mode: "pause", reason: "Independent human copy pause", releasePolicy: { strategy: "manual" } });
  const first = await busyRuntimeWorker(ctx), riley = await runtimeWorker(ctx, "Riley"), second = await busyRuntimeWorker(ctx, { worker: riley });
  for (const state of [first, second]) await ctx.input.api.patch(`/api/issues/${state.task.id}`, { parentId: parent.id });
  const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
  return { ...first, second, parent, manualWorker, manualChild, manualHold: manual.hold, humanId: session.user.id, syntheticBudgetReceiptId: budgetReceipt.id, syntheticAccountingCostCents: 125, syntheticAccountingOrigin: "public-imported-synthetic-fixture" };
}
export const runtimeTreeCases = ["task-coordination.pause-tree", "steering.stop-versus-pause"].map(id => runtimeDefinition(id, setupTree, gradeTreePause, {
  authentication: "human-session", expectedRunCount: 3, runPolicy: { kind: "terminal-counts", terminalStatusCounts: { succeeded: 1, cancelled: 2 } }, attemptTimeoutMs: 900_000,
  sourceFiles: ["chat-catalog-domains/runtime-tree.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "chat-catalog-domains/identity-support.ts", `chat-scenarios/${id.split(".")[0]}.yaml`],
  setupPolicy: { readiness: "preserve-scenario", funding: "preserve-scenario", invariantCheckIds: ["lead-ready", "two-real-native-workers", "independent-child-pause-budget", "active-branches-funded"] },
  async verifySetup(ctx, state) {
    const c = checks(), lead = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`), runs = await ctx.allRuns();
    c.add("lead-ready", lead.lifecycleState === "ready" && ["idle", "active"].includes(lead.status ?? ""), "The actual CEO is ready to answer the canonical query.");
    c.add("two-real-native-workers", [state, state.second as State].every(s => s.workerWasReallyWaiting === true && runs.some(row => row.id === s.workerRunId
      && row.agentId === (s.worker as Entity).id && row.status === "running" && row.companyId === ctx.input.fixtures.company.id)), "Two actual native workers are independently active before chat.");
    const funding = await ctx.input.api.get<{ policies: Array<{ scopeType: string; scopeId: string; amount: number; isActive: boolean; hardStopEnabled: boolean; unpricedUsagePolicy: string }> }>(`/api/companies/${ctx.input.fixtures.company.id}/budgets/overview`);
    const activeScopes = [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, ...[ctx.input.fixtures.agent.id, (state.worker as Entity).id, ((state.second as State).worker as Entity).id].map(scopeId => ({ scopeType: "agent", scopeId }))];
    c.add("active-branches-funded", activeScopes.every(scope => funding.policies.some(policy => policy.scopeType === scope.scopeType && policy.scopeId === scope.scopeId && policy.amount === 500 && policy.isActive && policy.hardStopEnabled && policy.unpricedUsagePolicy === "allow")), "The real company, CEO and both active branches keep their positive execution budgets while the independent branch remains held.");
    const manual = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${(state.manualWorker as Entity).id}`);
    const hold = await ctx.input.api.get<TreeState>(`/api/issues/${(state.manualChild as Entity).id}/tree-control/state`);
    c.add("independent-child-pause-budget", manual.status === "paused" && manual.lifecycleHolds?.includes("budget") === true && funding.policies.some(policy => policy.scopeType === "agent" && policy.scopeId === manual.id && policy.amount === 100 && policy.isActive && policy.hardStopEnabled) && hold.activePauseHold?.holdId === (state.manualHold as IssueTreeHold).id,
      "The independent manual leaf pause and effective budget hold are genuine saved prerequisites."); return c.result();
  },
  async act(ctx, state) {
    await pollUntil({ label: "Actual canonical tree-pause guidance before the human acts", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: v => chatCatalogNativePhaseIsTimely(ctx) && (v.source?.conversationState === "waiting" && v.runs.length === 3 && v.runs.filter(row => row.agentId === ctx.input.fixtures.agent.id).every(row => row.status === "succeeded")) });
    const before = await observeRuntime(ctx, state); state.queryReply = before.reply;
    state.bothActuallyRunning = [state.workerRunId, (state.second as State).workerRunId].every(id => before.runs.some(row => row.id === id && row.status === "running"));
    const root = `/api/issues/${(state.parent as Entity).id}`, source = ctx.input.page.url();
    state.agentPauseStatus = await probeAgentPermission(ctx, `${root}/tree-holds`, "POST", { mode: "pause", releasePolicy: { strategy: "manual" } });
    state.parentUnpausedBeforeHuman = (await ctx.input.api.get<TreeState>(`${root}/tree-control/state`)).activePauseHold === null;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${(state.parent as Entity).identifier ?? (state.parent as Entity).id}`, { waitUntil: "domcontentloaded" });
    await ctx.input.page.getByRole("button", { name: "More task actions", exact: true }).click();
    await ctx.input.page.getByRole("button", { name: "Pause subtree", exact: true }).click();
    const stopped = await pollUntil({ label: "Real parent pause and both native stop acknowledgements", deadlineAt: Date.now() + 90_000,
      load: async () => ({ holds: await ctx.input.api.get<IssueTreeHold[]>(`${root}/tree-holds?status=active&includeMembers=true`), runs: await ctx.allRuns() }),
      accept: v => v.holds.some(h => h.rootIssueId === (state.parent as Entity).id && h.mode === "pause")
        && [state.workerRunId, (state.second as State).workerRunId].every(id => v.runs.some(row => row.id === id && row.status === "cancelled")) });
    state.pausedHold = stopped.holds.find(h => h.rootIssueId === (state.parent as Entity).id && h.mode === "pause");
    const detail = await Promise.all([state.workerRunId, (state.second as State).workerRunId].map(id => ctx.input.api.get<{ resultJson?: { nativeCancellation?: { runId?: string; dispatchState?: string; dispatched?: boolean } } }>(`/api/heartbeat-runs/${id}`)));
    state.confirmedNativeStops = detail.every((row, i) => row.resultJson?.nativeCancellation?.dispatchState === "acknowledged" && row.resultJson.nativeCancellation.dispatched === true
      && row.resultJson.nativeCancellation.runId === [state.workerRunId, (state.second as State).workerRunId][i]);
    await expect(ctx.input.page.getByText("Subtree is paused.", { exact: true })).toBeVisible(); state.pauseVisible = true;
    await ctx.input.capture("actual-launch-subtree-paused", "Persistent Launch hold after two confirmed native stops", "runtime-tree-pause.png");
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    const holdIds = await Promise.all([state, state.second as State].map(s => ctx.input.api.get<TreeState>(`/api/issues/${(s.task as Entity).id}/tree-control/state`)));
    state.pausePreventsNewAdmission = holdIds.every(s => s.activePauseHold?.rootIssueId === (state.parent as Entity).id) && (await ctx.allRuns()).length === 3;
    await ctx.input.page.getByRole("button", { name: "Resume subtree", exact: true }).first().click();
    const dialog = ctx.input.page.getByRole("dialog", { name: "Resume subtree", exact: true });
    await dialog.getByRole("checkbox", { name: /Wake affected agents/ }).uncheck(); state.resumeWakeDisabled = true;
    await dialog.getByRole("button", { name: "Resume subtree", exact: true }).click();
    await pollUntil({ label: "Explicit human release of only the Launch hold", deadlineAt: Date.now() + 20_000,
      load: () => ctx.input.api.get<TreeState>(`${root}/tree-control/state`), accept: s => s.activePauseHold === null });
    state.parentUnpausedAfterResume = true;
    state.releasedHold = await ctx.input.api.get<IssueTreeHold>(`${root}/tree-holds/${(state.pausedHold as IssueTreeHold).id}`);
    const child = await ctx.input.api.get<TreeState>(`/api/issues/${(state.manualChild as Entity).id}/tree-control/state`), manual = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${(state.manualWorker as Entity).id}`);
    state.independentChildHoldRetained = child.activePauseHold?.holdId === (state.manualHold as IssueTreeHold).id;
    state.manualAgentStillPaused = manual.status === "paused"; state.independentBudgetRetained = manual.lifecycleHolds?.includes("budget") === true;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async cleanup(ctx, state) { try { await cleanupIdentityProbes(ctx); } finally { await releaseRuntimeWorker(state); if (state.second) await releaseRuntimeWorker(state.second as State); } },
}) );
