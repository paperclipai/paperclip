import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import { CHAT_NATIVE_TIMEOUT_POLICY } from "../chat-native-timeout-policy.js";
import { expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { collectRunEvents } from "../run-observations.js";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { fixtureWorker, makeDefinition } from "./internal-definition.js";
import { startNativeRunBriefGate } from "./internal-native-run-brief.js";
import { checks, entity, goal, observation, observeInternal, project, sameTask, task, type Entity, type InternalObservation } from "./internal-support.js";
interface DefaultsObservation extends InternalObservation { futureContext: { project?: Entity; goal?: Entity }; futureComments: Entity[]; futureProjectReads?: { runId: string; projectId: string; callId: string }[] }
interface PreparedAgent extends Entity { lifecycleState?: string; adapterConfig?: { timeoutSec?: number } }
export function gradeProjectDefaultsSetup(value: { lead: PreparedAgent; future: PreparedAgent; held: PreparedAgent; task: Entity & { executionRunId?: string }; runs: Entity[]; activeRunId: string; gateCalls: { workerBound?: boolean; workerId?: string }[] }) {
  const c = checks();
  const ready = (agent: PreparedAgent) => agent.lifecycleState === "ready" && ["idle", "active"].includes(agent.status ?? "");
  c.add("lead-ready", ready(value.lead) && value.lead.adapterConfig?.timeoutSec === CHAT_NATIVE_TIMEOUT_POLICY.savedAgentTimeoutSec, "The canonical lead is independently ready under the production-default native timeout policy and unchanged finite scenario budget.");
  c.add("future-worker-ready", ready(value.future) && value.future.adapterConfig?.timeoutSec === CHAT_NATIVE_TIMEOUT_POLICY.savedAgentTimeoutSec, "The future-context worker is independently ready under the production-default native timeout policy and unchanged finite scenario budget.");
  c.add("existing-work-actively-owned", value.held.lifecycleState === "ready" && value.held.status === "running" && value.held.adapterConfig?.timeoutSec === CHAT_NATIVE_TIMEOUT_POLICY.savedAgentTimeoutSec
    && value.task.assigneeAgentId === value.held.id && value.task.executionRunId === value.activeRunId && value.runs.some(run => run.id === value.activeRunId && run.agentId === value.held.id && run.status === "running")
    && value.gateCalls.some(call => call.workerBound === true && call.workerId === value.held.id), "The prerequisite uses the same production native timeout policy; its brief read is bounded by the unchanged original observation clock, with exact live ownership and a worker-bound receipt.");
  return c.result();
}
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
/** Public native history intentionally redacts API bodies but retains exact input digests, call identity and HTTP status. */
export function projectReadCalls(events: unknown[], runId: string, projectId: string, expectedDescription?: string) {
  const digest = createHash("sha256").update(canonical({ operationId: "GET /api/projects/{id}", pathParams: { id: projectId } })).digest("hex");
  const inputs = new Set<string>(); const results = new Set<string>();
  const listInputs = new Set<string>(); const listResults = new Set<string>();
  // Codex emits these exact structured dynamic-tool events before/after the native
  // handler (codex-session-server-requests.ts). Never parse assistant prose as proof.
  for (const value of events) {
    if (!value || typeof value !== "object") continue;
    const row = value as { runId?: string; sourceEventId?: string; payload?: { prpEvent?: { schema?: string; runId?: string; sourceEventId?: string } } };
    const envelope = row.payload?.prpEvent;
    if (envelope && (envelope.schema !== "paperclip.prp.event.v1" || envelope.runId !== row.runId || envelope.sourceEventId !== row.sourceEventId)) continue;
    const event = (envelope ?? value) as { runId?: string; eventType?: string; itemId?: string; payload?: { kind?: string; item?: Record<string, unknown> } };
    if (event.runId !== runId || event.payload?.kind !== "dynamicToolCall") continue;
    const item = event.payload.item; if (!item || typeof item.id !== "string" || event.itemId !== item.id) continue;
    if (event.eventType === "item.started" && item.type === "tool_use" && item.name === "call_api") {
      const input = item.input as Record<string, unknown> | undefined;
      if (input?.apiPayloadRedacted === true && input.apiPayloadSha256 === digest) inputs.add(item.id);
    }
    if (event.eventType === "item.started" && ["tool_use", "tool_call"].includes(String(item.type)) && item.name === "list_projects") listInputs.add(item.id);
    if (event.eventType === "item.completed" && item.type === "tool_result" && item.tool_use_id === item.id && item.is_error !== true) {
      const result = item.result as Record<string, unknown> | undefined;
      if (result?.apiOperationId === "GET /api/projects/{id}" && result.status === 200 && result.ok === true) results.add(item.id);
      // A dedicated read is equally valid when it delivered the actual full
      // saved defaults. Summaries, stale/truncated text and assistant prose are
      // insufficient; retain exact run, envelope and tool-call correlation.
      if (expectedDescription && Array.isArray(result?.projects) && result.projects.some(project => {
        if (!project || typeof project !== "object") return false;
        const row = project as Record<string, unknown>;
        return row.id === projectId && row.description === expectedDescription && row.descriptionTruncated === false;
      })) listResults.add(item.id);
    }
  }
  return [...new Set([...inputs].filter(callId => results.has(callId)).concat([...listInputs].filter(callId => listResults.has(callId))))]
    .map(callId => ({ runId, projectId, callId }));
}
export function gradeProjectDefaults(value: unknown) {
  const c = checks(); const o = observation(value) as DefaultsObservation | undefined;
  c.add("real-future-task-context", !!o && !!o.futureContext && Array.isArray(o.futureComments) && !!o.state.futureTask, "Actual admitted future task, native result and public heartbeat context are required.");
  if (!o || !o.futureContext || !Array.isArray(o.futureComments) || !o.state.futureTask) return c.result();
  const p = o.projects.find(row => row.id === entity(o.state, "project").id); const g = entity(o.state, "goal");
  const checklist = (text: string) => /keyboard/i.test(text) && /contrast/i.test(text) && /(?:label|accessible name)/i.test(text);
  const savedChecklist = o.state.checklist as Entity | undefined;
  const containsDefault = (text: string) => checklist(text) || !!savedChecklist && [savedChecklist.id, savedChecklist.identifier, savedChecklist.title].filter(Boolean).some(reference => text.includes(reference!));
  const future = entity(o.state, "futureTask"); const worker = entity(o.state, "futureWorker");
  const run = o.runs.find(row => row.agentId === worker.id && (row.contextSnapshot?.issueId === future.id || row.contextSnapshot?.taskId === future.id));
  const reported = o.futureComments.filter(row => row.authorAgentId === worker.id && row.createdByRunId === run?.id).map(row => row.body ?? "").join("\n");
  c.add("saved-permitted-project-defaults", !!p && containsDefault(p.description ?? "") && (p.goalIds ?? [p.goalId]).includes(g.id)
    && o.activity.some(row => row.entityId === p.id && row.action === "project.updated" && row.agentId === o.leadId), "The CEO durably saves the actual accessibility checklist and growth association on Launch.");
  c.add("new-native-context-inherits-defaults", !!run && run.status === "succeeded" && o.tasks.some(row => row.id === future.id && row.status === "done" && row.projectId === p?.id)
    && (o.futureContext.project?.id === p?.id && containsDefault(o.futureContext.project?.description ?? "")
      && (o.futureContext.goal?.id === g.id || (o.futureContext.project?.goalIds ?? [o.futureContext.project?.goalId]).includes(g.id))
      || !!p && (o.futureProjectReads ?? []).some(read => read.projectId === p.id && read.runId === run.id))
    && checklist(reported) && (reported.includes(g.id) || reported.includes(g.title ?? g.id) || /\b1[,. ]?000\b[^.\n]*signups?/i.test(reported)), "A separate actual native task reports the saved checklist and goal from real project/task context, without copying the requested defaults into its task description.");
  const active = entity(o.state, "task"); const current = o.tasks.find(row => row.id === active.id) as (Entity & { executionRunId?: string }) | undefined;
  c.add("active-work-and-separate-gates-retained", sameTask(active, current) && current?.executionRunId === o.state.activeRunId
    && o.runs.some(row => row.id === o.state.activeRunId && row.status === "running" && row.agentId === active.assigneeAgentId)
    && JSON.stringify((p as Entity & { env?: unknown })?.env ?? null) === JSON.stringify(o.state.originalEnv)
    && !o.activity.some(row => row.agentId === worker.id && row.entityId === p?.id && row.action === "project.updated")
    && !o.activity.some(row => row.agentId === o.leadId && /budget\.|environment\./.test(row.action ?? "")), "The existing checkout/task and separately governed environment/budget are not rewritten by future defaults; the probe cannot create its own defaults.");
  const first = String(o.state.defaultsReply ?? "");
  c.add("future-defaults-distinguished-from-active-work", /\b(?:future|new|subsequent)\b/i.test(first) && /\b(?:existing|active|current|running)\b/i.test(first)
    && /\b(?:unchanged|not|does not|doesn't|won't|will not|only)\b/i.test(first), "The canonical reply distinguishes future task defaults from changes to already active work.");
  return c.result();
}
function defaults(): ChatCatalogCase {
  let gate: Awaited<ReturnType<typeof startNativeRunBriefGate>> | undefined;
  const base = makeDefinition("projects.project-defaults", async ctx => {
    const worker = await fixtureWorker(ctx); const futureWorker = await fixtureWorker(ctx); await ctx.input.api.patch(`/api/agents/${futureWorker.id}`, { name: "Riley" });
    const p = await project(ctx); const g = await goal(ctx, "Growth: reach 1,000 signups");
    const checklist = await task(ctx, "Accessibility checklist", p.id, { description: "All Launch work must support keyboard navigation, sufficient color contrast, and explicitly labeled controls." });
    const root = `/api/companies/${ctx.input.fixtures.company.id}`;
    for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, ...[worker, futureWorker].map(row => ({ scopeType: "agent", scopeId: row.id }))])
      await ctx.input.api.post(`${root}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
    const holdDeadlineAt = ctx.observationDeadlineAt!;
    gate = await startNativeRunBriefGate(worker.id, holdDeadlineAt, ctx.input.privateSecrets);
    try {
      const t = await task(ctx, "Active launch research", p.id, { status: "todo", assigneeAgentId: worker.id, description: `Read the pending Website Brief by running this native shell command with a ${Math.max(1, holdDeadlineAt - Date.now())} ms tool timeout. Wait for its actual result before proceeding. Do not change this brief or other tasks. Command: ${gate.command}` });
      const held = await pollUntil({ label: "Real prior active Launch checkout", deadlineAt: Date.now() + 150000,
        load: async () => ({ task: await ctx.input.api.get<Entity & { executionRunId?: string }>(`/api/issues/${t.id}`), runs: await ctx.allRuns() }),
        accept: row => gate!.calls.length > 0 && row.runs.length === 1 && row.runs[0]?.status === "running" && row.task.executionRunId === row.runs[0]?.id });
      await ctx.input.evidence("chat-catalog-project-defaults-prerequisite-timeout.json", { heldWorkerId: worker.id, heldWorkerTimeoutSec: CHAT_NATIVE_TIMEOUT_POLICY.savedAgentTimeoutSec, holdDeadlineAt, remainingHoldBudgetMs: Math.max(0, holdDeadlineAt - Date.now()), canonicalTimeoutSec: CHAT_NATIVE_TIMEOUT_POLICY.savedAgentTimeoutSec, futureWorkerTimeoutSec: CHAT_NATIVE_TIMEOUT_POLICY.savedAgentTimeoutSec, authoredLegacyCanonicalStageMs: 150000, authoredLegacyFutureProbeStageMs: 180000, attemptBoundMs: 660000 });
      return { project: p, goal: g, checklist, task: held.task, worker, futureWorker, activeRunId: held.runs[0]!.id, originalEnv: (p as Entity & { env?: unknown }).env ?? null };
    } catch (error) {
      // The flow has no state yet, so its ordinary case cleanup cannot run.
      try { await gate.close(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Native brief setup and cleanup failed"); }
      finally { gate = undefined; }
      throw error;
    }
  }, gradeProjectDefaults);
  return { ...base, oracleVersion: "paperclip.chat-catalog.project-defaults.v2", expectedRunCount: 3, minimumRunCount: 3, attemptTimeoutMs: 660000, runPolicy: { kind: "source-settled-with-active-work", maximumActiveWorkerRuns: 1 },
    setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["lead-ready", "future-worker-ready", "existing-work-actively-owned"] },
    async verifySetup(ctx, state) { const [lead, future, held, t, runs] = await Promise.all([
      ctx.input.api.get<PreparedAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`), ctx.input.api.get<PreparedAgent>(`/api/agents/${entity(state, "futureWorker").id}`), ctx.input.api.get<PreparedAgent>(`/api/agents/${entity(state, "worker").id}`),
      ctx.input.api.get<Entity & { executionRunId?: string }>(`/api/issues/${entity(state, "task").id}`), ctx.allRuns() ]);
      return gradeProjectDefaultsSetup({ lead, future, held, task: t, runs, activeRunId: String(state.activeRunId), gateCalls: gate?.calls ?? [] }); },
    sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-project-defaults.ts", "chat-catalog-domains/internal-native-run-brief.ts", "../e2e/fetch-allowed-port.ts", "run-observations.ts"],
    async act(ctx, state) {
      // This boundary depends only on the canonical run and conversation.
      // Rebuilding domain/DOM evidence on each wait poll adds unrelated load
      // and trace volume; retain the complete observation after settlement.
      await pollUntil({ label: "Canonical project-defaults turn settles", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150000),
        load: async () => { await ctx.refreshIssue(); return ctx.allRuns(); },
        accept: runs => chatCatalogNativePhaseIsTimely(ctx) && runs.some(row => row.agentId === ctx.input.fixtures.agent.id && row.status === "succeeded") && ctx.issue()?.conversationState === "waiting" });
      const settled = await observeInternal(ctx, state);
      state.defaultsReply = settled.reply;
      state.futureTask = await task(ctx, "Verify inherited Launch defaults", entity(state, "project").id, { status: "todo", assigneeAgentId: entity(state, "futureWorker").id,
        description: "Use the current saved project/task context to report which project checklist applies to this new work and the associated goal. Do not change project defaults or any other task. Complete after recording your factual findings, including if no defaults or goal are present." });
      await pollUntil({ label: "Actual new native task reads inherited project context", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 180000), load: () => ctx.allRuns(), accept: rows => chatCatalogNativePhaseIsTimely(ctx) && rows.length === 3 && rows.some(row => row.agentId === entity(state, "futureWorker").id && row.status === "succeeded") });
    },
    async observe(ctx, state): Promise<DefaultsObservation> { const o = await observeInternal(ctx, state); const run = state.futureTask ? o.runs.find(row => row.agentId === entity(state, "futureWorker").id && (row.contextSnapshot?.issueId === entity(state, "futureTask").id || row.contextSnapshot?.taskId === entity(state, "futureTask").id)) : undefined;
      const events = run ? await collectRunEvents((after, limit) => ctx.input.api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${after}&limit=${limit}`)) : [];
      return { ...o, futureProjectReads: run ? projectReadCalls(events, run.id, entity(state, "project").id, o.projects.find(project => project.id === entity(state, "project").id)?.description ?? undefined) : [],
      futureContext: state.futureTask ? await ctx.input.api.get(`/api/issues/${entity(state, "futureTask").id}/heartbeat-context`) : {},
      futureComments: state.futureTask ? await ctx.input.api.get(`/api/issues/${entity(state, "futureTask").id}/comments?order=asc`) : [] }; },
    async verifyResult(ctx, state) { const source = ctx.input.page.url(); try { await ctx.input.page.goto(new URL(`/${ctx.input.fixtures.company.issuePrefix}/projects/${entity(state, "project").id}`, ctx.input.api.baseURL).href); await expect(ctx.input.page.getByRole("heading", { name: "Launch", exact: true }).first()).toBeVisible(); } finally { await ctx.input.page.goto(source); await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); } },
    async cleanup() { await gate?.close(); gate = undefined; },
  };
}
export const projectDefaultsCases: readonly ChatCatalogCase[] = [defaults()];
