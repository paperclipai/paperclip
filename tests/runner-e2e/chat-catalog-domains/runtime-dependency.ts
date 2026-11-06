import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { expect, type Page } from "@playwright/test";
import type { Issue } from "../../../packages/shared/src/types/issue.js";
import type { HeartbeatRun } from "../../../packages/shared/src/types/heartbeat.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { checks, type Entity } from "./internal-support.js";
import { runtimeDefinition, runtimeWorker, runtimeObservation, observeRuntime } from "./runtime-support.js";
async function chooseStatus(page: Page, status: "Todo" | "Done") {
  await page.getByRole("button", { name: /^Change status \(current:/ }).first().click();
  await page.getByRole("button", { name: status, exact: true }).click();
}
export function gradeDesignDependency(value: unknown) {
  const c = checks(), o = runtimeObservation(value);
  c.add("actual-dependency-and-native-admission-evidence", !!o, "The saved dependency, real unfinished prerequisite and later eligible native result must be independently read."); if (!o) return c.result();
  const s = o.state, task = s.task as Entity, design = s.design as Entity, waiting = s.waitingTask as Issue, finished = o.tasks.find(row => row.id === task.id);
  c.add("actual-first-class-blocker-saved", waiting?.id === task.id && waiting.companyId === o.companyId && waiting.assigneeAgentId === (s.worker as Entity).id
    && waiting.blockedBy?.length === 1 && waiting.blockedBy[0]?.id === design.id && s.designUnfinishedAtWait === true
    && o.activity.some(row => row.action === "issue.blockers_updated" && row.entityId === task.id && row.agentId === o.leadId
      && (row.details?.addedBlockedByIssueIds as string[] | undefined)?.includes(design.id)),
  "The CEO actually installs the Design edge on the intended Website task; a comment alone is insufficient.");
  c.add("blocked-ordinary-admission-and-usable-ui", s.blockerVisible === true && s.noWorkerBeforeApproval === true && s.attemptedBeforeApproval === true
    && [200, 422, 409].includes(Number(s.beforeApprovalStatus)) && /Design/i.test(String(s.queryReply)) && /wait|block|depend|approv|before/i.test(String(s.queryReply)),
  "Ordinary human start is attempted while Design is unfinished, but no Website native run is admitted; the task UI exposes the exact blocker.");
  c.add("one-eligible-worker-after-real-human-approval", s.humanApprovedDesign === true && s.workerAdmissionAfterApproval === true && finished?.status === "done"
    && finished.assigneeAgentId === (s.worker as Entity).id && o.tasks.length === 2 && s.actualWebsiteResult === true
    && o.runs.length === 3 && o.runs.every(row => row.status === "succeeded") && o.runs.filter(row => row.agentId === (s.worker as Entity).id).length === 1,
  "After actual human Design completion clears the prerequisite, ordinary admission runs Morgan once and produces the genuine saved Website result.");
  c.add("later-own-phase-reports-actual-result", s.finalReplyAttributed === true && /website/i.test(String(s.finalReply)) && /done|complete|finish|delivered/i.test(String(s.finalReply))
    && !/still (?:blocked|waiting)|could not start/i.test(String(s.finalReply)),
  "A declared factual human follow-up receives its own native reply reporting the actual result rather than borrowing a pre-approval response.");
  return c.result();
}
export const runtimeDependencyCases = [runtimeDefinition("task-coordination.block-on-design", async ctx => {
  const worker = await runtimeWorker(ctx), root = `/api/companies/${ctx.input.fixtures.company.id}`, marker = `Approved website ${ctx.input.nonce}`;
  for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, { scopeType: "agent", scopeId: worker.id }])
    await ctx.input.api.post(`${root}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
  const design = await ctx.input.api.post<Entity>(`${root}/issues`, { title: "Design", status: "backlog", description: `A semantic HTML website with accessible labels. Await the actual human approval; reference ${marker}.` });
  const task = await ctx.input.api.post<Entity>(`${root}/issues`, { title: "Website", status: "backlog", assigneeAgentId: worker.id,
    description: `Implement the approved Design as a small website plan. Once eligible, read the actual Design task and save a task document with the exact reference ${marker}, accessible labels and a clear primary action, then finish normally. Do not deploy, create other tasks or invent approval.` });
  return { worker, task, design, marker };
}, gradeDesignDependency, {
  expectedHumanMessageCount: 2, expectedRunCount: 3, attemptTimeoutMs: 720_000,
  sourceFiles: ["chat-catalog-domains/runtime-dependency.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/task-coordination.yaml"],
  async act(ctx, state) {
    await pollUntil({ label: "Saved dependency and canonical reply before human approval", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: v => chatCatalogNativePhaseIsTimely(ctx) && v.source?.conversationState === "waiting" && v.runs.length === 1 && v.runs[0]?.status === "succeeded" });
    state.queryReply = (await observeRuntime(ctx, state)).reply;
    const source = ctx.input.page.url(), task = state.task as Entity, design = state.design as Entity, websiteRoot = `/api/issues/${task.id}`;
    state.waitingTask = await ctx.input.api.get<Issue>(websiteRoot);
    state.designUnfinishedAtWait = (await ctx.input.api.get<Issue>(`/api/issues/${design.id}`)).status !== "done";
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("link", { name: /Design/ }).first()).toBeVisible(); state.blockerVisible = true;
    const pending = ctx.input.page.waitForResponse(row => row.request().method() === "PATCH" && new URL(row.url()).pathname === websiteRoot);
    await chooseStatus(ctx.input.page, "Todo"); state.beforeApprovalStatus = (await pending).status(); state.attemptedBeforeApproval = true;
    // Reload and independent reads observe the real admission gate, rather
    // than setting a run's blocked status or pretending the worker executed.
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    state.noWorkerBeforeApproval = (await ctx.allRuns()).every(row => row.agentId !== (state.worker as Entity).id);
    await ctx.input.capture("actual-design-dependency-wait", "Website retains its actual Design blocker before human approval", "runtime-design-blocker.png");
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${design.identifier ?? design.id}`, { waitUntil: "domcontentloaded" });
    await chooseStatus(ctx.input.page, "Done");
    const approved = await pollUntil({ label: "Real human Design completion", deadlineAt: Date.now() + 20_000,
      load: () => ctx.input.api.get<Issue>(`/api/issues/${design.id}`), accept: row => row.status === "done" });
    state.humanApprovedDesign = approved.status === "done"; state.designApprovedAt = Date.now();
    const website = await ctx.input.api.get<Issue>(websiteRoot);
    if (website.status === "backlog") {
      await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
      await chooseStatus(ctx.input.page, "Todo");
    }
    const result = await pollUntil({ label: "One ordinary Website admission after Design approval", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 240_000),
      load: async () => ({ runs: await ctx.allRuns(), task: await ctx.input.api.get<Issue>(websiteRoot) }),
      accept: v => chatCatalogNativePhaseIsTimely(ctx) && v.runs.length === 2 && v.runs.every(row => row.status === "succeeded") && v.task.status === "done",
      reject: v => v.runs.length > 2 || v.runs.some(row => ["failed", "cancelled", "timed_out"].includes(row.status)) ? "Eligible Website admission failed or duplicated native work" : undefined });
    const worker = result.runs.find(row => row.agentId === (state.worker as Entity).id)!;
    const designActivity = await ctx.input.api.get<Entity[]>(`/api/issues/${design.id}/activity`);
    const approval = designActivity.find(row => row.action === "issue.updated" && row.actorType === "user" && row.details?.status === "done");
    const workerDetail = await ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${worker.id}`);
    state.workerAdmissionAfterApproval = !!approval && Date.parse(String(workerDetail.createdAt)) >= Date.parse(approval.createdAt ?? ""); state.websiteRunId = worker.id;
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    const followup = `I approved Design ${design.identifier ?? design.id}. What is the actual result of Website ${task.identifier ?? task.id} now?`;
    await sendChatMessage(ctx.input.page, followup, chatCatalogNativePhaseRemainingBudget(ctx));
    const final = await pollUntil({ label: "Own native reply reporting actual post-approval Website outcome", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: v => chatCatalogNativePhaseIsTimely(ctx) && v.source?.conversationState === "waiting" && v.runs.length === 3 && v.runs.every(row => row.status === "succeeded") });
    const run = final.runs.find(row => !result.runs.some(prior => prior.id === row.id))!, comments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
    const human = comments.filter(row => !row.authorAgentId && row.body === followup), replies = comments.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id && row.createdByRunId === run.id);
    const detail = await ctx.input.api.get<{ runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${run.id}`);
    state.finalReplyAttributed = human.length === 1 && replies.length > 0 && detail.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(human[0]!.id) === true;
    state.finalReply = replies.map(row => row.body).join("\n");
  },
  async observe(ctx, state) {
    const o = await observeRuntime(ctx, state);
    state.actualWebsiteResult = o.revisions.some(row => row.createdByRunId === state.websiteRunId && row.createdByAgentId === (state.worker as Entity).id
      && (row.body ?? "").includes(String(state.marker)) && o.documents.some(doc => doc.id === row.documentId && doc.latestRevisionId === row.id));
    return o;
  },
  async verifyResult(ctx, state) {
    const source = ctx.input.page.url(), task = state.task as Entity;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByRole("heading", { name: "Website", exact: true }).first()).toBeVisible();
    await expect(ctx.input.page.getByRole("button", { name: "Change status (current: Done)", exact: true }).first()).toBeVisible();
    await ctx.input.capture("actual-approved-website-result", "The same Website task completed after its real Design prerequisite", "runtime-approved-website.png");
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
})];
