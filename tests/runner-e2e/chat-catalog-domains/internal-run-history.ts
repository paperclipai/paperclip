import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { fixtureWorker, makeDefinition } from "./internal-definition.js";
import { startRunBriefGate } from "./internal-run-brief.js";
import { checks, entity, hasLink, observation, observeInternal, project, task, type Entity, type InternalObservation } from "./internal-support.js";
interface OwnedTask extends Entity { checkoutRunId?: string | null; executionRunId?: string | null }
interface RunHistory extends InternalObservation { currentTask: OwnedTask; agentRunReadStatuses: number[] }
function runHref(o: InternalObservation, agentId: string, runId: string) {
  return o.links.find(href => { try { const u = new URL(href, o.origin); return u.origin === o.origin && u.pathname.endsWith(`/agents/${agentId}/runs/${runId}`); } catch { return false; } });
}
export function gradeRunHistory(value: unknown) {
  const c = checks(); const o = observation(value) as RunHistory | undefined;
  c.add("actual-interrupted-task-history", !!o && !!o.currentTask && Array.isArray(o.state.gateCalls), "Native task-bound runs, actual interrupted checkout evidence and continuation readback are required.");
  if (!o || !o.currentTask || !Array.isArray(o.state.gateCalls)) return c.result();
  const worker = o.state.worker as Entity; const t = o.state.task as Entity; const first = o.state.interruptedRun as Entity; const later = o.state.continuationRun as Entity;
  const history = o.runs.filter(run => run.agentId === worker?.id && (run.contextSnapshot?.issueId === t?.id || run.contextSnapshot?.taskId === t?.id));
  c.add("both-real-attempts-retained", history.length === 2 && !!first && !!later && first.id !== later.id
    && history.some(run => run.id === first.id && run.status === "cancelled") && history.some(run => run.id === later.id && run.status === "succeeded")
    && (o.state.gateCalls as Array<{ authorized?: boolean; operation?: string }>).some(call => call.authorized && call.operation === "read_website_brief")
    && (o.state.interruptedTask as OwnedTask | undefined)?.executionRunId === first.id,
    "A real operator cancellation while Morgan owns the checkout remains alongside the actual successful retry; no synthetic run rows are used.");
  c.add("independent-agent-execution-read-authority", Array.isArray(o.agentRunReadStatuses) && o.agentRunReadStatuses.length === 2 && o.agentRunReadStatuses.every(status => status === 200), "The actual acting agent can read both exact run details under its own bearer; task access alone is not assumed to grant run access.");
  c.add("exact-task-and-agent-run-links", !!t && hasLink(o, "issues", t) && !!worker && !!first && !!later && !!runHref(o, worker.id, first.id) && !!runHref(o, worker.id, later.id),
    "Each relevant execution links to the actual Morgan run detail and the originating website task.");
  const runPart = (id: string) => o.reply.split(/\n/).filter(part => part.includes(id)).join(" ");
  c.add("interrupted-and-continuation-states-explained", !!first && !!later && /\b(?:cancelled|canceled|interrupted|stopped)\b/i.test(runPart(first.id))
    && /\b(?:succeeded|successful|completed|finished)\b/i.test(runPart(later.id)) && /\bMorgan\b/.test(o.reply),
    "Run-attributed reply rows distinguish the cancelled attempt from the successful continuation and identify the actual executing agent.");
  c.add("no-history-rewrite-or-extra-owner", o.currentTask.id === t?.id && o.currentTask.assigneeAgentId === worker?.id && o.currentTask.status === "done"
    && history.every(run => [first?.id, later?.id].includes(run.id))
    && !o.activity.some(row => row.entityId === t?.id && row.agentId === o.leadId && /issue\.(?:updated|deleted)/.test(row.action ?? "")),
    "A history request leaves the completed task, execution ownership and both durable attempts unchanged.");
  return c.result();
}
function findRuns(): ChatCatalogCase {
  let gate: Awaited<ReturnType<typeof startRunBriefGate>> | undefined; let key: { id: string; token: string } | undefined;
  const base = makeDefinition("activity.find-runs", async ctx => {
    const worker = await fixtureWorker(ctx); const p = await project(ctx); const root = `/api/companies/${ctx.input.fixtures.company.id}`;
    for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, { scopeType: "agent", scopeId: worker.id }])
      await ctx.input.api.post(`${root}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
    gate = await startRunBriefGate(ctx, worker.id);
    try {
    const t = await task(ctx, "Website task", p.id, { status: "todo", assigneeAgentId: worker.id,
      description: "Read the authorized Website Brief app's read_website_brief tool before doing any work. The source read may be pending; do not invent its contents or start work without its real response. After it returns, follow that short prerequisite brief and record your note, then finish the task. Do not create other tasks." });
    const first = await pollUntil({ label: "Actual Morgan checkout waiting on authorized brief", deadlineAt: Date.now() + 150_000,
      load: async () => ({ task: await ctx.input.api.get<OwnedTask>(`/api/issues/${t.id}`), runs: await ctx.allRuns() }),
      accept: value => gate!.calls.length > 0 && value.runs.length === 1 && value.runs[0]?.agentId === worker.id && value.runs[0]?.status === "running" && value.task.executionRunId === value.runs[0]?.id,
      reject: value => value.runs.some(run => ["failed", "cancelled", "succeeded", "timed_out"].includes(run.status)) ? "First prerequisite attempt ended before the real interruption boundary" : undefined });
    const interruptedRun = first.runs[0]!; const gateCalls = structuredClone(gate.calls);
    await ctx.input.api.post(`/api/heartbeat-runs/${interruptedRun.id}/cancel`, { cancellationRequestId: randomUUID() });
    const cancelledRun = await pollUntil({ label: "Durable real operator cancellation", deadlineAt: Date.now() + 60_000,
      load: () => ctx.input.api.get<Entity>(`/api/heartbeat-runs/${interruptedRun.id}`), accept: run => run.status === "cancelled" });
    gate.release();
    const receipt = await ctx.input.api.post<{ accepted: boolean; sourceRunId?: string }>(`/api/issues/${t.id}/retry`, { idempotencyKey: randomUUID(), observedRunId: interruptedRun.id });
    if (!receipt.accepted) throw new Error("Public retry did not accept the actual cancelled prerequisite attempt");
    const continuation = await pollUntil({ label: "Actual task continuation completes after the brief is available", deadlineAt: Date.now() + 180_000,
      load: async () => ({ task: await ctx.input.api.get<OwnedTask>(`/api/issues/${t.id}`), runs: await ctx.allRuns() }),
      accept: value => value.runs.length === 2 && value.runs.some(run => run.id === interruptedRun.id && run.status === "cancelled")
        && value.runs.some(run => run.id !== interruptedRun.id && run.agentId === worker.id && run.status === "succeeded") && value.task.status === "done",
      reject: value => value.runs.some(run => run.id !== interruptedRun.id && ["failed", "cancelled", "timed_out"].includes(run.status)) ? "The actual continuation did not finish" : undefined });
    const continuationRun = continuation.runs.find(run => run.id !== interruptedRun.id)!;
    if (!ctx.input.privateSecrets) throw new Error("Execution read controls require private credential redaction");
    key = await ctx.input.api.postSensitive(`/api/agents/${ctx.input.fixtures.agent.id}/keys`, { name: `run-history-read-${ctx.input.nonce}` }); ctx.input.privateSecrets.push(key!.token);
    const state = { project: p, task: continuation.task, worker, interruptedTask: first.task, interruptedRun: cancelledRun, continuationRun, gateCalls, retryReceipt: receipt };
    await ctx.input.evidence("chat-catalog-real-interrupted-continuation.json", state); return state;
    } catch (error) { await gate.close(); gate = undefined; throw error; }
  }, gradeRunHistory);
  return { ...base, expectedRunCount: 3, minimumRunCount: 3, attemptTimeoutMs: 660_000,
    runPolicy: { kind: "terminal-counts", terminalStatusCounts: { cancelled: 1, succeeded: 2 } },
    sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-run-history.ts", "chat-catalog-domains/internal-run-brief.ts", "../e2e/fetch-allowed-port.ts"],
    async observe(ctx, state): Promise<RunHistory> {
      if (!key) throw new Error("Run read probe was not created during setup"); const o = await observeInternal(ctx, state);
      const agentRunReadStatuses = await Promise.all(["interruptedRun", "continuationRun"].map(async name => {
        const url = new URL(`/api/heartbeat-runs/${entity(state, name).id}`, ctx.input.api.baseURL);
        const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${key!.token}` } }); await response.body?.cancel(); return response.status;
      }));
      return { ...o, agentRunReadStatuses, currentTask: await ctx.input.api.get<OwnedTask>(`/api/issues/${entity(state, "task").id}`) };
    },
    async verifyResult(ctx, state, value) {
      const o = value as RunHistory; await base.verifyResult(ctx, state, value); const source = ctx.input.page.url(); const worker = entity(state, "worker");
      try {
        for (const key of ["interruptedRun", "continuationRun"]) { const run = entity(state, key); const href = runHref(o, worker.id, run.id); if (!href) throw new Error("Missing exact native execution link");
          await ctx.input.page.goto(new URL(href, o.origin).href, { waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByText(new RegExp(run.status === "cancelled" ? "cancelled|canceled" : "succeeded|successful", "i")).first()).toBeVisible();
          await ctx.input.evidence(`chat-catalog-${key}-opened.json`, { runId: run.id, agentId: worker.id, taskId: entity(state, "task").id, url: ctx.input.page.url() }); }
      } finally { await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); }
    },
    async cleanup(ctx) { try { if (key) { await ctx.input.api.delete(`/api/agents/${ctx.input.fixtures.agent.id}/keys/${key.id}`, { allowNotFound: true }); key = undefined; } } finally { await gate?.close(); gate = undefined; } },
  };
}
export const runHistoryCases: readonly ChatCatalogCase[] = [findRuns()];
