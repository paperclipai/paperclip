import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { pollUntil } from "../api.js";
import { checks, sameTask, type Entity } from "./internal-support.js";
import { probeAgentPermission } from "./identity-support.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, openRuntimeAgentProfile, unchangedAgent, type RuntimeAgent } from "./runtime-support.js";
import { busyRuntimeWorker, releaseRuntimeWorker } from "./runtime-busy-worker.js";

export function gradeRetirement(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("independent-retirement-evidence", !!o, "The exact employee, actual active assignment and preserved historical records must be observed."); if (!o) return c.result();
  const worker = o.state.worker as RuntimeAgent; const retired = o.state.retiredWorker as RuntimeAgent | undefined;
  c.add("human-only-termination", o.state.agentTerminateStatus === 403 && o.state.humanRetired === true
    && retired?.status === "terminated" && retired.lifecycleState === "terminated"
    && o.activity.some(row => row.action === "agent.terminated" && row.entityId === worker.id && row.actorType === "user" && !row.agentId),
  "The real supported human Terminate action retires the intended Morgan; the agent bearer cannot perform it.");
  c.add("active-assignment-settles", o.state.workerWasReallyWaiting === true && o.runs.find(run => run.id === o.state.workerRunId)?.status === "cancelled"
    && o.runs.length === 2 && o.tasks.some(row => row.id === (o.state.task as Entity).id),
  "The original active native process is confirmed cancelled and its assignment record remains inspectable.");
  c.add("historical-work-and-attribution-retained", !!retired && unchangedAgent(worker, retired)
    && sameTask(o.state.historicalTask as Entity, o.tasks.find(row => row.id === (o.state.historicalTask as Entity).id))
    && o.state.historicalDocumentRetained === true && o.state.historicalAttributionRetained === true && o.tasks.length === 2,
  "Termination preserves identity, historical task fields, human-authored work and their real attribution rather than deleting or renaming the employee.");
  const reply = String(o.state.queryReply ?? "");
  c.add("honest-retirement-guidance", /Morgan/i.test(reply) && /terminate|retire/i.test(reply) && /profile|control|human|you/i.test(reply)
    && /task|assign|work|history/i.test(reply) && !/I(?:'ve| have)? (?:already )?(?:retired|terminated|deleted)/i.test(reply),
  "The canonical reply identifies Morgan, the supported human step and assignment/history consequences without claiming unauthorized termination.");
  return c.result();
}
export const runtimeRetirementCases = [runtimeDefinition("agents.retire-agent", async ctx => {
  const state = await busyRuntimeWorker(ctx, { observationDeadlineAt: chatCatalogOriginalPhaseDeadline(ctx) });
  // Truthful historical fixture: this was completed by the human and assigned
  // to Morgan for recordkeeping. It does not impersonate prior provider work.
  const historicalTask = await ctx.input.api.post<Entity>(`/api/companies/${ctx.input.fixtures.company.id}/issues`, {
    title: "Historical launch notes", status: "done", assigneeAgentId: state.worker.id,
    description: "Historical fixture authored and completed by the human; preserve its saved notes and attribution. No claim of prior model execution." });
  const historicalDocument = await ctx.input.api.putSensitive<Entity>(`/api/issues/${historicalTask.id}/documents/plan`, {
    title: "Retained launch notes", format: "markdown", body: `Human-authored launch notes ${ctx.input.nonce}`, baseRevisionId: null });
  const revisions = await ctx.input.api.get<Entity[]>(`/api/issues/${historicalTask.id}/documents/plan/revisions`);
  if (!revisions.length || revisions.some(row => row.createdByAgentId || row.createdByRunId)) throw new Error("Historical human fixture provenance is invalid");
  return { ...state, historicalTask, historicalDocument, historicalRevisions: revisions };
}, gradeRetirement, {
  sourceFiles: ["chat-catalog-domains/runtime-retirement.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/agents.yaml"],
  expectedRunCount: 2, attemptTimeoutMs: 600_000,
  runPolicy: { kind: "terminal-counts", terminalStatusCounts: { succeeded: 1, cancelled: 1 } },
  setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["lead-ready", "real-active-assignment", "truthful-historical-work"] },
  async verifySetup(ctx, state) {
    const c = checks(); const worker = state.worker as RuntimeAgent;
    const lead = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`);
    const current = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${worker.id}`); const run = (await ctx.allRuns()).find(row => row.id === state.workerRunId);
    c.add("lead-ready", lead.lifecycleState === "ready" && ["active", "idle"].includes(lead.status ?? ""), "The actual speaking agent is admitted normally.");
    c.add("real-active-assignment", current.lifecycleState === "ready" && ["running", "active"].includes(current.status ?? "")
      && run?.status === "running" && run.agentId === worker.id && run.companyId === ctx.input.fixtures.company.id
      && [run.contextSnapshot?.issueId, (run as typeof run & { nativeIssueId?: string })?.nativeIssueId].includes((state.task as Entity).id),
    "A genuine native process owns Morgan's exact current task in this company.");
    const historical = await ctx.input.api.get<Entity>(`/api/issues/${(state.historicalTask as Entity).id}`);
    c.add("truthful-historical-work", historical.status === "done" && historical.assigneeAgentId === worker.id
      && historical.companyId === ctx.input.fixtures.company.id && !historical.createdByAgentId && !historical.createdByRunId,
    "The independently read prior completed record has genuine human provenance, without forged model history.");
    return c.result();
  },
  async act(ctx, state) {
    await pollUntil({ label: "Canonical retirement guidance while Morgan works", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: value => chatCatalogNativePhaseIsTimely(ctx) && value.source?.conversationState === "waiting" && value.runs.length === 2
        && value.runs.some(run => run.agentId === ctx.input.fixtures.agent.id && run.status === "succeeded")
        && value.runs.find(run => run.id === state.workerRunId)?.status === "running" });
    const o = await observeRuntime(ctx, state); state.queryReply = o.reply;
    const worker = state.worker as RuntimeAgent;
    state.agentTerminateStatus = await probeAgentPermission(ctx, `/api/agents/${worker.id}/terminate`, "POST", {});
    const source = ctx.input.page.url(); await openRuntimeAgentProfile(ctx, worker, o);
    await ctx.input.page.getByRole("button", { name: "Open actions for Morgan", exact: true }).click();
    await ctx.input.page.getByRole("button", { name: "Terminate", exact: true }).click();
    const after = await pollUntil({ label: "Human retirement and original process cleanup", deadlineAt: Date.now() + 90_000,
      load: async () => ({ worker: await ctx.input.api.get<RuntimeAgent>(`/api/agents/${worker.id}`), runs: await ctx.allRuns() }),
      accept: value => value.worker.status === "terminated" && value.worker.lifecycleState === "terminated"
        && value.runs.find(run => run.id === state.workerRunId)?.status === "cancelled" });
    state.humanRetired = true; state.retiredWorker = after.worker;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) {
    const endpoint = `/api/issues/${(state.historicalTask as Entity).id}/documents/plan`;
    const current = await ctx.input.api.get<Entity>(endpoint); const before = state.historicalDocument as Entity;
    const revisions = await ctx.input.api.get<Entity[]>(`${endpoint}/revisions`);
    state.historicalDocumentRetained = current.id === before.id && current.body === before.body && current.latestRevisionId === before.latestRevisionId;
    state.historicalAttributionRetained = (state.historicalRevisions as Entity[]).every(prior => revisions.some(row => row.id === prior.id
      && row.body === prior.body && row.createdByAgentId === prior.createdByAgentId && row.createdByRunId === prior.createdByRunId));
    return observeRuntime(ctx, state);
  },
  async verifyResult(ctx, state) {
    const source = ctx.input.page.url(); const task = state.historicalTask as Entity;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("heading", { name: task.title!, exact: true }).first()).toBeVisible();
    await ctx.input.evidence("runtime-retired-historical-task-ui.json", { workerId: (state.worker as Entity).id, historicalTaskId: task.id, url: ctx.input.page.url() });
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  cleanup: async (_ctx, state) => releaseRuntimeWorker(state),
})];
