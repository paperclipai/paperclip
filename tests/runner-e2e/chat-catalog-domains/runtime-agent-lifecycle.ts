import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { pollUntil } from "../api.js";
import { checks } from "./internal-support.js";
import { probeAgentPermission } from "./identity-support.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, openRuntimeAgentProfile, type RuntimeAgent } from "./runtime-support.js";
import { busyRuntimeWorker, releaseRuntimeWorker } from "./runtime-busy-worker.js";
export function gradePauseAgent(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("actual-human-pause-evidence", !!o, "Actual active work, board control, saved pause and terminal cancellation are independently required."); if (!o) return c.result();
  const worker = o.state.worker as RuntimeAgent; const current = o.agents.find(row => row.id === worker.id);
  const stopped = o.runs.find(run => run.id === o.state.workerRunId);
  c.add("real-active-work-before-human-pause", o.state.workerWasReallyWaiting === true && o.state.beforeHumanStatus !== "paused"
    && o.state.agentPauseStatus === 403, "The agent's acknowledgement and bearer cannot complete the board-only pause while Morgan is really working.");
  c.add("human-pause-persisted-and-settled", o.state.humanPaused === true && current?.status === "paused"
    && current.lifecycleState === "paused" && stopped?.status === "cancelled",
    "The real profile Pause control persists suspension and confirms the original process stopped.");
  c.add("human-attribution", o.activity.some(row => row.action === "agent.paused" && row.entityId === worker.id
    && row.actorType === "user" && !row.agentId), "The pause audit belongs to the authorized human.");
  c.add("pending-human-step-honest", /profile|pause button|pause control|you can pause|you.*pause/i.test(o.reply)
    && /stop|settle|current|existing|running/i.test(o.reply) && !/I(?:'ve| have)? (?:now )?paused/i.test(o.reply),
    "The reply identifies the exact human step and explains how existing execution settles without falsely claiming the pause.");
  c.add("exact-agent-identity", !!current && current.companyId === o.companyId, "The actual human control affects the same saved Morgan identity.");
  return c.result();
}
export const runtimeLifecycleCases = [runtimeDefinition("agents.pause-agent", ctx => busyRuntimeWorker(ctx, { observationDeadlineAt: chatCatalogOriginalPhaseDeadline(ctx) }), gradePauseAgent, {
  sourceFiles: ["chat-catalog-domains/runtime-agent-lifecycle.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/agents.yaml"],
  expectedRunCount: 2, attemptTimeoutMs: 600_000,
  setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["lead-ready", "real-busy-worker", "worker-task-scope"] },
  async verifySetup(ctx, state) {
    const c = checks(); const worker = state.worker as RuntimeAgent;
    const lead = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`);
    const saved = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${worker.id}`);
    const runs = await ctx.allRuns(); const run = runs.find(row => row.id === state.workerRunId);
    c.add("lead-ready", lead.lifecycleState === "ready" && ["idle", "active"].includes(lead.status ?? ""), "The actual CEO is ready for the canonical query.");
    c.add("real-busy-worker", saved.lifecycleState === "ready" && ["running", "active"].includes(saved.status ?? "")
      && run?.status === "running" && state.workerWasReallyWaiting === true, "Morgan remains genuinely active rather than being forced idle by shared setup.");
    const task = state.task as { id: string };
    c.add("worker-task-scope", run?.agentId === worker.id && run.companyId === ctx.input.fixtures.company.id
      && [run.contextSnapshot?.issueId, (run as typeof run & { nativeIssueId?: string })?.nativeIssueId].includes(task.id), "The actual native worker run belongs to this exact company and Website task.");
    return c.result();
  },
  runPolicy: { kind: "terminal-counts", terminalStatusCounts: { succeeded: 1, cancelled: 1 } },
  async act(ctx, state) {
    await pollUntil({ label: "Chat guidance while Morgan is still working", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: value => chatCatalogNativePhaseIsTimely(ctx) && value.source?.conversationState === "waiting" && value.runs.some(run => run.agentId === ctx.input.fixtures.agent.id && run.status === "succeeded")
        && value.runs.find(run => run.id === state.workerRunId)?.status === "running" });
    const worker = state.worker as RuntimeAgent;
    state.beforeHumanStatus = (await ctx.input.api.get<RuntimeAgent>(`/api/agents/${worker.id}`)).status;
    state.agentPauseStatus = await probeAgentPermission(ctx, `/api/agents/${worker.id}/pause`, "POST", {});
    const o = await observeRuntime(ctx, state);
    const source = ctx.input.page.url();
    await openRuntimeAgentProfile(ctx, worker, o);
    await ctx.input.page.getByRole("button", { name: "Pause", exact: true }).click();
    await pollUntil({ label: "Morgan pause confirmed after native process cleanup", deadlineAt: Date.now() + 90_000,
      load: async () => ({ worker: await ctx.input.api.get<RuntimeAgent>(`/api/agents/${worker.id}`), runs: await ctx.allRuns() }),
      accept: value => value.worker.status === "paused" && value.worker.lifecycleState === "paused" && value.runs.find(run => run.id === state.workerRunId)?.status === "cancelled" });
    state.humanPaused = true;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
  },
  cleanup: async (_ctx, state) => releaseRuntimeWorker(state),
})];
