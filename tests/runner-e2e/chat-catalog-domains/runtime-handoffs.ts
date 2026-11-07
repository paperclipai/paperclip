import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { observeCompletionUpdate } from "../completion-update-flow.js";
import { completionDelivery } from "../completion-updates.js";
import { checks, hasLink, type Entity } from "./internal-support.js";
import { openStandingChat } from "./identity-support.js";
import { prepareRuntimeWorkerGate, readRuntimeTaskGate, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { runtimeDefinition, runtimeObservation, observeRuntime, type RuntimeAgent } from "./runtime-support.js";

export function gradeTrackDelegatedWork(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("native-conversation-handoff-evidence", !!o, "The prior genuine handoff, real busy worker, canonical reply and eventual source update must all be observed."); if (!o) return c.result();
  const task = o.state.task as Entity; const worker = o.state.worker as Entity;
  c.add("original-conversation-created-one-work-task", o.state.createdFromSource === true && o.state.workerWasReallyWaiting === true
    && o.tasks.length === 1 && o.tasks[0]?.id === task.id && o.tasks[0]?.assigneeAgentId === worker.id
    && o.state.originalSourceRetained === true,
  "A real prior source-chat native turn created exactly this task, with Morgan as its sole assignee; the standing chat remains the same conversation.");
  c.add("canonical-status-uses-current-execution", o.state.workerStatusAtQueryReply === "running"
    && /running|working|waiting|in progress|underway/i.test(String(o.state.queryReply))
    && !/(?:has|is) (?:already )?(?:finished|complete)|I (?:built|implemented|finished)/i.test(String(o.state.queryReply))
    && hasLink({ ...o, links: o.state.queryLinks as string[] }, "issues", task),
  "The canonical query's actual attributed answer links the existing task and describes its observed running state instead of claiming completion.");
  const delivery = o.state.delivery as ReturnType<typeof completionDelivery> | undefined;
  c.add("completion-returns-to-original-request", o.state.completionDelivered === true && !!delivery && delivery.checks.every(check => check.passed)
    && o.tasks[0]?.status === "done" && o.runs.find(run => run.id === o.state.workerRunId)?.status === "succeeded"
    && o.documents.some(doc => (doc.body ?? "").includes(String(o.state.marker)))
    && /done|complete|finished|ready/i.test(String(delivery.response?.body ?? ""))
    && !/published|deployed|emailed|sent.*email|pushed.*(?:GitHub|remote)/i.test(String(delivery.response?.body ?? "")),
  "Independent completed output and the unsolicited source-scoped completion delivery agree after the genuine worker finishes.");
  c.add("no-duplicate-or-parent-execution", o.runs.length === 4 && o.runs.filter(run => run.agentId === worker.id).length === 1
    && o.runs.every(run => run.status === "succeeded") && o.state.sourceAssigneePreserved === true,
  "The only native work is the prior handoff, one Morgan execution, the canonical status reply and one automatic source update.");
  return c.result();
}
export const runtimeHandoffCases = [runtimeDefinition("agent-chat.track-delegated-work", async ctx => {
  const prepared = await prepareRuntimeWorkerGate(ctx, { taskBound: true }); const source = await openStandingChat(ctx);
  const marker = `Tracked website delivery ${ctx.input.nonce}`;
  const instructions = `For the website assignment, first run ${prepared.gate.command} once and wait for the real human brief. Do not invent the brief or change the script. Once it returns, save a short website deliverable document with key website-delivery on the assigned task containing the supplied reference and complete that same task normally. Do not create other tasks or perform external actions.`;
  await ctx.input.api.saveAgentInstructions(prepared.worker.id, instructions);
  const prompt = `Create one task titled Website, assigned to Morgan, to draft our launch page. Morgan is waiting for the human brief, which will include the reference ${marker}. Let Morgan implement it on that separate work task. Track the result here and tell me here when the work is complete, with access to the actual result. You may begin that one handoff now; no additional task or project is needed.`;
  await sendChatMessage(ctx.input.page, prompt);
  const phase = await pollUntil({ label: "Actual conversation-created Morgan handoff", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000),
    load: async () => {
      await ctx.refreshIssue();
      const tasks = await ctx.input.api.get<Entity[]>(`${prepared.company}/issues?includeAgentCreatedTasks=true&limit=1000`);
      const candidates = tasks.filter(task => task.id !== source.id && task.assigneeAgentId === prepared.worker.id);
      return { source: ctx.issue(), tasks, runs: await ctx.allRuns(),
        waiting: candidates.length === 1 ? await readRuntimeTaskGate(ctx, prepared.gate, candidates[0]!.id, prepared.worker.id) : "" };
    },
    accept: value => chatCatalogNativePhaseIsTimely(ctx) && value.source?.conversationState === "waiting" && value.waiting === "waiting" && value.runs.length === 2
      && value.runs.some(run => run.agentId === prepared.worker.id && run.status === "running")
      && value.runs.some(run => run.agentId === ctx.input.fixtures.agent.id && run.status === "succeeded")
      && value.tasks.filter(task => task.id !== source.id).length === 1,
    reject: value => value.runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "Prior native handoff failed" : undefined });
  const task = phase.tasks.find(task => task.id !== source.id)!;
  const created = await ctx.input.api.get<Entity[]>(`${prepared.company}/issues?createdFromIssueId=${source.id}&includeAgentCreatedTasks=true&limit=1000`);
  if (task.assigneeAgentId !== prepared.worker.id || created.length !== 1 || created[0]?.id !== task.id) throw new Error("The saved work task is not the actual source conversation handoff");
  const workerRun = phase.runs.find(run => run.agentId === prepared.worker.id)!;
  if (![workerRun.contextSnapshot?.issueId, (workerRun as typeof workerRun & { nativeIssueId?: string }).nativeIssueId].includes(task.id)) throw new Error("Native worker attribution does not match the actual handoff task");
  return { worker: prepared.worker, gate: prepared.gate, task, marker, prompt, sourceBefore: source,
    sourceId: source.id, setupRunIds: phase.runs.map(run => run.id), workerRunId: workerRun.id, workerWasReallyWaiting: true, createdFromSource: true };
}, gradeTrackDelegatedWork, {
  sourceFiles: ["chat-catalog-domains/runtime-handoffs.ts", "chat-catalog-domains/runtime-busy-worker.ts", "chat-catalog-domains/runtime-support.ts", "completion-update-flow.ts", "completion-updates.ts", "chat-scenarios/agent-chat.yaml"],
  setupHumanMessageCount: 1, expectedHumanMessageCount: 2, expectedRunCount: 4, attemptTimeoutMs: 900_000,
  setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["lead-ready", "native-handoff-owner", "real-source-provenance"] },
  async verifySetup(ctx, state) {
    const c = checks(); const lead = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${ctx.input.fixtures.agent.id}`);
    const worker = await ctx.input.api.get<RuntimeAgent>(`/api/agents/${(state.worker as Entity).id}`);
    const run = (await ctx.allRuns()).find(row => row.id === state.workerRunId);
    c.add("lead-ready", lead.lifecycleState === "ready" && ["active", "idle"].includes(lead.status ?? ""), "The speaking agent is genuinely ready after its prior handoff.");
    c.add("native-handoff-owner", worker.lifecycleState === "ready" && ["active", "running"].includes(worker.status ?? "")
      && run?.status === "running" && run.agentId === worker.id && run.companyId === ctx.input.fixtures.company.id,
    "Morgan remains the genuine active native owner; no shared setup forces the worker idle.");
    const created = await ctx.input.api.get<Entity[]>(`/api/companies/${ctx.input.fixtures.company.id}/issues?createdFromIssueId=${state.sourceId}&includeAgentCreatedTasks=true&limit=1000`);
    c.add("real-source-provenance", created.length === 1 && created[0]?.id === (state.task as Entity).id,
    "The public source provenance filter independently confirms this conversation created the actual work task.");
    return c.result();
  },
  async act(ctx, state) {
    const phase = await pollUntil({ label: "Canonical handoff status response", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: value => chatCatalogNativePhaseIsTimely(ctx) && value.source?.conversationState === "waiting" && value.runs.length === 3
        && value.runs.find(run => run.id === state.workerRunId)?.status === "running"
        && value.runs.filter(run => run.agentId === ctx.input.fixtures.agent.id).every(run => run.status === "succeeded") });
    const queryIds = phase.runs.filter(run => !(state.setupRunIds as string[]).includes(run.id)).map(run => run.id);
    const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${state.sourceId}/comments?order=asc`);
    const replies = comments.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id && queryIds.includes(row.createdByRunId ?? ""));
    state.queryReply = replies.map(row => row.body ?? "").join("\n");
    const links: string[] = [];
    for (const reply of replies) links.push(...await ctx.input.page.locator(`[id=${JSON.stringify(`comment-${reply.id}`)}] a[href]`).evaluateAll(nodes => nodes.map(node => node.getAttribute("href")!)));
    state.queryLinks = links; state.workerStatusAtQueryReply = phase.runs.find(run => run.id === state.workerRunId)!.status;
    await writeFile((state.gate as { gate: string }).gate, `The real website brief: use a blue page with concise copy. Save a short task delivery document that includes exactly ${state.marker}, then complete this existing Website task.`, "utf8");
    const delivered = await observeCompletionUpdate({ page: ctx.input.page, api: ctx.input.api, sourceId: String(state.sourceId), workerId: (state.task as Entity).id,
      marker: String(state.marker), fixtureRequest: String(state.prompt), originalObservationDeadlineAt: chatCatalogOriginalPhaseDeadline(ctx), allRuns: () => ctx.allRuns(), evidence: ctx.input.evidence, capture: ctx.input.capture });
    const delivery = completionDelivery(delivered); state.delivery = delivery; state.completionDelivered = !!delivery.response;
  },
  async observe(ctx, state) {
    await ctx.refreshIssue(); const before = state.sourceBefore as { id: string; assigneeAgentId?: string | null };
    state.originalSourceRetained = ctx.issue()?.id === before.id;
    state.sourceAssigneePreserved = ctx.issue()?.assigneeAgentId === before.assigneeAgentId;
    return observeRuntime(ctx, state);
  },
  async verifyResult(ctx, state) {
    const source = ctx.input.page.url(); const task = state.task as Entity;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("heading", { name: task.title!, exact: true }).first()).toBeVisible();
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  cleanup: async (_ctx, state) => releaseRuntimeWorker(state),
})];
