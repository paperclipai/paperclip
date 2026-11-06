import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { pollUntil } from "../api.js";
import { submitTaskReply } from "../user-actions.js";
import { readRegisteredArtifacts } from "../registered-artifact.js";
import { checks, type Entity } from "./internal-support.js";
import { probeAgentPermission } from "./identity-support.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, openRuntimeAgentProfile, unchangedAgent, type RuntimeAgent } from "./runtime-support.js";
import { savedTaskWorkspace } from "./runtime-workspaces.js";

export function gradeSessionReset(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("independent-session-reset-evidence", !!o, "Real prior native work, human reset and future execution must be independently observed."); if (!o) return c.result();
  const worker = o.state.worker as RuntimeAgent; const current = o.agents.find(row => row.id === worker.id);
  c.add("human-only-reset", o.state.agentResetStatus === 403 && o.state.sessionPresentBeforeHuman === true
    && o.state.humanReset === true && o.state.sessionsEmptyAfterHuman === true
    && o.activity.some(row => row.action === "agent.runtime_session_reset" && row.entityId === worker.id && row.actorType === "user" && !row.agentId),
  "Only the supported human control clears Morgan's actual stored runtime session.");
  c.add("future-execution-fresh", o.state.futureRunFresh === true && o.state.explicitContinuationSaved === true
    && o.runs.length === 3 && o.runs.filter(run => run.agentId === worker.id && run.status === "succeeded").length === 2,
  "One explicit task continuation starts without the prior session and succeeds with a distinct new session.");
  c.add("durable-history-and-artifact-preserved", o.state.historyRetained === true && o.state.documentsRetained === true
    && o.state.artifactRetained === true && o.state.fileRetained === true && !!current && unchangedAgent(worker, current)
    && o.tasks.length === 1 && o.tasks[0]?.id === (o.state.task as Entity).id,
  "Comments, document revisions, downloaded artifact bytes and the original saved file remain readable on the same task and agent.");
  const reply = String(o.state.queryReply ?? "");
  c.add("honest-runtime-versus-history-guidance", /session|runtime context/i.test(reply) && /history|comments|artifacts|files/i.test(reply)
    && /reset|profile|control/i.test(reply) && !/I(?:'ve| have)? (?:already )?(?:reset|cleared|deleted)/i.test(reply),
  "The canonical query's own attributed answer explains the human control and durable history without claiming a reset by the agent.");
  return c.result();
}

export const runtimeSessionCases = [runtimeDefinition("runs-adapters.reset-session", async ctx => {
  const state = await savedTaskWorkspace(ctx, { artifact: true });
  const sessions = await ctx.input.api.get<unknown[]>(`/api/agents/${state.worker.id}/task-sessions`);
  const initial = (await ctx.allRuns()).find(run => run.id === state.fixtureRunId);
  if (!sessions.length || !initial?.sessionIdAfter) throw new Error("Session reset prerequisite requires a real retained provider session");
  const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${state.task.id}/comments?order=asc`);
  const documents = await ctx.input.api.get<Entity[]>(`/api/issues/${state.task.id}/documents`);
  if (!comments.some(row => row.createdByRunId === initial.id) || !documents.length) throw new Error("Prior native task history is missing");
  const revisions: Entity[] = [];
  for (const doc of documents) revisions.push(...await ctx.input.api.get<Entity[]>(`/api/issues/${state.task.id}/documents/${encodeURIComponent(doc.key!)}/revisions`));
  return { ...state, priorComments: comments, priorDocuments: documents, priorRevisions: revisions };
}, gradeSessionReset, {
  sourceFiles: ["chat-catalog-domains/runtime-session.ts", "chat-catalog-domains/runtime-workspaces.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/runs-adapters.yaml", "../../ui/src/components/AgentActionButtons.tsx", "../../ui/src/pages/AgentDetail.tsx"],
  expectedRunCount: 3, attemptTimeoutMs: 720_000,
  async act(ctx, state) {
    await pollUntil({ label: "Canonical session guidance settled", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: value => chatCatalogNativePhaseIsTimely(ctx) && value.source?.conversationState === "waiting" && value.runs.length === 2 && value.runs.every(run => run.status === "succeeded") });
    const worker = state.worker as RuntimeAgent; const task = state.task as Entity;
    const query = await observeRuntime(ctx, state); state.queryReply = query.reply;
    state.agentResetStatus = await probeAgentPermission(ctx, `/api/agents/${worker.id}/runtime-state/reset-session`, "POST", {});
    state.sessionPresentBeforeHuman = (await ctx.input.api.get<unknown[]>(`/api/agents/${worker.id}/task-sessions`)).length > 0;
    const source = ctx.input.page.url(); await openRuntimeAgentProfile(ctx, worker, query);
    const profile = ctx.input.page.locator("#main-content");
    await expect(profile.getByRole("heading", { name: worker.name!, exact: true })).toBeVisible();
    await profile.getByRole("button", { name: `Open actions for ${worker.name}`, exact: true }).click();
    chatCatalogNativePhaseRemainingBudget(ctx)?.();
    await ctx.input.page.getByRole("button", { name: "Reset Sessions", exact: true }).click();
    await pollUntil({ label: "Human reset clears the real task session", deadlineAt: Date.now() + 30_000,
      load: () => ctx.input.api.get<unknown[]>(`/api/agents/${worker.id}/task-sessions`), accept: rows => rows.length === 0 });
    state.humanReset = true; state.sessionsEmptyAfterHuman = true;
    const beforeRuns = await ctx.allRuns();
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    const followup = "Please continue this same task using your fresh runtime session. Read the existing website-fixture.txt without changing its bytes, inspect our saved task history, and add a brief task comment confirming it is still readable. Keep existing documents and attachments unchanged, then finish this task. Do not create another task.";
    await submitTaskReply(ctx.input.page, followup, chatCatalogNativePhaseRemainingBudget(ctx));
    const future = await pollUntil({ label: "Actual fresh-session continuation", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000),
      load: async () => ({ runs: await ctx.allRuns(), task: await ctx.input.api.get<Entity>(`/api/issues/${task.id}`) }),
      accept: value => chatCatalogNativePhaseIsTimely(ctx) && value.task.status === "done" && value.runs.length === beforeRuns.length + 1
        && value.runs.filter(run => !beforeRuns.some(prior => prior.id === run.id)).every(run => run.status === "succeeded"),
      reject: value => value.runs.some(run => !beforeRuns.some(prior => prior.id === run.id) && ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Fresh-session continuation failed" : undefined });
    const next = future.runs.find(run => !beforeRuns.some(prior => prior.id === run.id))!;
    const initial = beforeRuns.find(run => run.id === state.fixtureRunId)!;
    state.futureRunFresh = next.agentId === worker.id && !next.sessionIdBefore && !!next.sessionIdAfter && next.sessionIdAfter !== initial.sessionIdAfter;
    const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${task.id}/comments?order=asc`);
    state.explicitContinuationSaved = comments.filter(row => row.body === followup && !row.authorAgentId).length === 1
      && comments.some(row => row.createdByRunId === next.id && row.authorAgentId === worker.id);
    state.historyRetained = (state.priorComments as Entity[]).every(prior => comments.some(row => row.id === prior.id && row.body === prior.body && row.createdByRunId === prior.createdByRunId));
    const documents = await ctx.input.api.get<Entity[]>(`/api/issues/${task.id}/documents`); const revisions: Entity[] = [];
    for (const doc of documents) revisions.push(...await ctx.input.api.get<Entity[]>(`/api/issues/${task.id}/documents/${encodeURIComponent(doc.key!)}/revisions`));
    state.documentsRetained = (state.priorDocuments as Entity[]).every(prior => documents.some(row => row.id === prior.id && row.latestRevisionId === prior.latestRevisionId))
      && (state.priorRevisions as Entity[]).every(prior => revisions.some(row => row.id === prior.id && row.body === prior.body));
    const [artifact] = await readRegisteredArtifacts(ctx.input.api, task.id, String(state.fixtureRunId), ["website-fixture.txt"]);
    state.artifactRetained = artifact?.sha256 === (state.artifact as { sha256: string }).sha256;
    const file = await ctx.input.api.get<{ content: { data: string } }>(`/api/issues/${task.id}/file-resources/content?workspace=execution&path=website-fixture.txt`);
    state.fileRetained = file.content.data === state.fileBefore;
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("heading", { name: task.title!, exact: true }).first()).toBeVisible();
    await ctx.input.evidence("runtime-fresh-session-task-ui.json", { taskId: task.id, workerId: worker.id, futureRunId: next.id, url: ctx.input.page.url() });
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
})];
