import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const port = vi.hoisted(() => ({ observation: {} as Record<string, unknown>, deadline: 0, afterLoadNow: null as number | null }));
vi.mock("./identity-support.js", async original => ({ ...await original<typeof import("./identity-support.js")>(), observeIdentity: async (_ctx: unknown, state: unknown) => ({ ...port.observation, state }) }));
vi.mock("../api.js", async original => ({ ...await original<typeof import("../api.js")>(), pollUntil: async (options: { deadlineAt: number; load(): Promise<unknown>; accept(value: unknown): boolean }) => {
  port.deadline = options.deadlineAt;
  const value = await options.load();
  if (port.afterLoadNow !== null) vi.spyOn(Date, "now").mockReturnValue(port.afterLoadNow);
  if (!options.accept(value)) throw new Error("CONTROL_SOURCE_NOT_SETTLED");
  throw new Error("CONTROL_AFTER_SOURCE_SETTLED");
} }));
import { planReviewIdentityCases } from "./identity-plan-review.js";
afterEach(() => { vi.restoreAllMocks(); port.afterLoadNow = null; });
function fixture(scenarioId: string, remaining = 600_000, inlineDraft = false) {
  const now = Date.now(), at = (offset: number) => new Date(now + offset).toISOString(), review = scenarioId.endsWith("review-plan");
  const query = review ? "I approve this plan; start the work." : "Do not publish it; just make a draft I can review.";
  const state = { sourceId: "chat", personId: "person", worker: { id: "morgan" }, scopeMarker: "Acorn research launch", plan: { id: "source-plan", latestRevisionId: "reviewed" }, original: { id: "proposal", kind: "request_confirmation", status: "pending", payload: { target: { revisionId: "reviewed" } } } };
  const task = { id: "task", companyId: "acorn", title: "Acorn research launch", description: "Acorn research launch", parentId: null, assigneeAgentId: "morgan", status: "done" };
  const runs = [
    { id: "initial", companyId: "acorn", agentId: "ceo", status: "succeeded", runtimeMode: "native", startedAt: at(-9000), contextSnapshot: { issueId: "chat", commentId: "human" } as Record<string, unknown> },
    { id: "worker", companyId: "acorn", agentId: "morgan", status: "succeeded", runtimeMode: "native", startedAt: at(-8000), contextSnapshot: { issueId: "task" } as Record<string, unknown> },
    { id: "completion", companyId: "acorn", agentId: "ceo", status: "succeeded", runtimeMode: "native", startedAt: at(-4000), contextSnapshot: { issueId: "chat", wakeReason: "chat_task_completed", wakeSource: "automation", chatCompletionDeliveryIds: ["delivery"], chatCompletionUpdates: [{ id: "task", status: "done", completedAt: at(-5000) }] } as Record<string, unknown> },
  ];
  const comments = [{ id: "human", authorAgentId: null as string | null, authorUserId: "person" as string | null, body: query, createdByRunId: null as string | null, createdAt: at(-10000) },
    { id: "source-reply", authorAgentId: "ceo", authorUserId: null, body: "The original requested work is saved for review.", createdByRunId: "completion", createdAt: at(-3000) }];
  const output = { id: "output", companyId: "acorn", issueId: "task", key: "plan", body: "# Acorn research launch — local draft and implementation checklist for review", latestRevisionId: "output-version" };
  const revision = { id: "output-version", documentId: "output", createdByRunId: "worker", createdByAgentId: "morgan" };
  const workerComments: Array<{ id: string; companyId: string; issueId: string; authorAgentId: string; createdByRunId: string; body: string }> = [];
  const interaction = { ...state.original, status: review ? "accepted" : "rejected", resolvedByAgentId: "ceo", result: { commentId: "human" } };
  const activity = [{ id: "created", entityId: "task", action: "issue.created", agentId: "ceo", details: {} },
    { id: "approved", entityId: "chat", action: review ? "issue.thread_interaction_accepted" : "issue.thread_interaction_rejected", agentId: "ceo", details: { interactionId: "proposal", responseCommentId: "human" } }];
  const observation = { scenarioId, origin: "http://fixture.invalid", companyId: "acorn", leadId: "ceo", company: { id: "acorn" }, companies: [], agents: [], interactions: [interaction], tasks: [task], projects: [], goals: [], comments: [], documents: [], revisions: [], activity, links: ["/ACO/issues/task"], humanQueries: [query], reply: "The local draft is ready for review.", runs };
  if (inlineDraft) {
    observation.tasks = []; runs.splice(1); output.issueId = "chat"; output.key = "draft";
    revision.createdByRunId = "initial"; revision.createdByAgentId = "ceo"; comments[1]!.createdByRunId = "initial";
    observation.links = ["#document-draft"];
  }
  port.observation = observation;
  const source = { id: "chat", companyId: "acorn", assigneeAgentId: "ceo", status: "in_review", conversationState: "waiting" };
  const get = vi.fn(async (path: string) => {
    if (path === "/api/auth/get-session") return { user: { id: "person" } };
    if (path === "/api/issues/chat/comments?order=asc") return comments;
    if (path === "/api/issues/task/comments?order=asc") return workerComments;
    if (path === "/api/issues/chat/documents/plan") return { id: "source-plan", key: "plan", latestRevisionId: "reviewed", body: "Original publication proposal" };
    if (path.endsWith("/work-products")) return [];
    if (path === "/api/issues/task/documents") return [{ key: "plan" }];
    if (path === "/api/issues/task/documents/plan") return output;
    if (path === "/api/issues/task/documents/plan/revisions") return [revision];
    if (path === "/api/issues/chat/documents") return inlineDraft ? [{ key: "draft" }] : [];
    if (path === "/api/issues/chat/documents/draft") return output;
    if (path === "/api/issues/chat/documents/draft/revisions") return [revision];
    throw new Error(`Unexpected owned read ${path}`);
  });
  const ctx = { observationDeadlineAt: now + remaining, input: { fixtures: { company: { id: "acorn" }, agent: { id: "ceo" } }, api: { get } }, scenario: { id: scenarioId, query }, issue: () => source, allRuns: async () => runs, refreshIssue: vi.fn(async () => {}) } as unknown as ChatCatalogContext;
  return { ctx, state, task, runs, comments, workerComments, output, revision, interaction, observation, source, get, now };
}
it("preserves start/handoff with one actual active linked worker and no claimed completion", async () => {
  const f = fixture("questions-and-approvals.review-plan"); f.runs.pop(); f.runs[1]!.status = "running"; f.task.status = "in_progress"; f.output.body = "";
  await expect(planReviewIdentityCases[0]!.act!(f.ctx, f.state)).rejects.toThrow("CONTROL_AFTER_SOURCE_SETTLED");
});
it.each(["pending approval", "missing scope", "wrong assignee", "no admitted worker"])("the original start path still rejects %s", async fault => {
  const f = fixture("questions-and-approvals.review-plan"); f.runs.pop(); f.runs[1]!.status = "running"; f.task.status = "in_progress"; f.output.body = "";
  if (fault === "pending approval") f.interaction.status = "pending";
  if (fault === "missing scope") { f.task.title = "Unrelated work"; f.task.description = "Unrelated work"; }
  if (fault === "wrong assignee") f.task.assigneeAgentId = "other";
  if (fault === "no admitted worker") f.runs.pop();
  await expect(planReviewIdentityCases[0]!.act!(f.ctx, f.state)).rejects.toThrow("CONTROL_SOURCE_NOT_SETTLED");
});
it("accepts59's actual local draft without inventing a worker or completion turn", async () => {
  const f = fixture("questions-and-approvals.reject-and-revise", 600_000, true);
  await expect(planReviewIdentityCases[1]!.act!(f.ctx, f.state)).rejects.toThrow("CONTROL_AFTER_SOURCE_SETTLED");
  expect(f.runs).toHaveLength(1);
});
it("accepts a completed125 task with its actual attributed saved comment instead of prescribing a document format", async () => {
  const f = fixture("questions-and-approvals.review-plan"); f.output.body = "";
  f.workerComments.push({ id: "work-comment", companyId: "acorn", issueId: "task", authorAgentId: "morgan", createdByRunId: "worker", body: "Saved the requested local implementation checklist for review." });
  await expect(planReviewIdentityCases[0]!.act!(f.ctx, f.state)).rejects.toThrow("CONTROL_AFTER_SOURCE_SETTLED");
});
it("does not substitute another run's comment for missing completed-work output", async () => {
  const f = fixture("questions-and-approvals.review-plan"); f.output.body = "";
  f.workerComments.push({ id: "work-comment", companyId: "acorn", issueId: "task", authorAgentId: "morgan", createdByRunId: "unrelated", body: "Some unrelated completed work." });
  await expect(planReviewIdentityCases[0]!.act!(f.ctx, f.state)).rejects.toThrow("CONTROL_SOURCE_NOT_SETTLED");
});
it.each(["missing draft", "pending decision", "accepted publication", "missing review link"])("59 still rejects %s even with its original source turn settled", async fault => {
  const f = fixture("questions-and-approvals.reject-and-revise", 600_000, true);
  if (fault === "missing draft") f.output.body = "";
  if (fault === "pending decision") f.interaction.status = "pending";
  if (fault === "accepted publication") f.interaction.status = "accepted";
  if (fault === "missing review link") f.observation.links = [];
  await expect(planReviewIdentityCases[1]!.act!(f.ctx, f.state)).rejects.toThrow("CONTROL_SOURCE_NOT_SETTLED");
});
it.each(["unrelated CEO", "missing delivery", "ambiguous delivery", "cancelled", "extra turn", "unfinished worker", "missing output", "foreign output", "wrong output run", "pending decision", "wrong revision", "wrong handoff", "missing source response", "wrong human", "wrong initial", "non-native", "duplicate id", "early completion", "source busy"])("actual completion path rejects %s", async fault => {
  const f = fixture("questions-and-approvals.review-plan"), context = f.runs[2]!.contextSnapshot;
  if (fault === "unrelated CEO") context.issueId = "other";
  if (fault === "missing delivery") delete context.chatCompletionDeliveryIds;
  if (fault === "ambiguous delivery") context.chatCompletionDeliveryIds = ["delivery", "other"];
  if (fault === "cancelled") f.runs[2]!.status = "cancelled";
  if (fault === "extra turn") f.runs.push({ ...f.runs[2]!, id: "extra" });
  if (fault === "unfinished worker") f.runs[1]!.status = "running";
  if (fault === "missing output") f.output.body = "";
  if (fault === "foreign output") f.output.issueId = "other";
  if (fault === "wrong output run") f.revision.createdByRunId = "other";
  if (fault === "pending decision") f.interaction.status = "pending";
  if (fault === "wrong revision") f.interaction.payload = { target: { revisionId: "unseen" } };
  if (fault === "wrong handoff") f.task.assigneeAgentId = "other";
  if (fault === "missing source response") f.comments.pop();
  if (fault === "wrong human") f.comments[0]!.authorUserId = "other";
  if (fault === "wrong initial") f.runs[0]!.contextSnapshot.commentId = "other";
  if (fault === "non-native") f.runs[1]!.runtimeMode = "process";
  if (fault === "duplicate id") f.runs[2]!.id = "initial";
  if (fault === "early completion") context.chatCompletionUpdates = [{ id: "task", status: "done", completedAt: new Date(f.now).toISOString() }];
  if (fault === "source busy") f.source.conversationState = "active";
  await expect(planReviewIdentityCases[0]!.act!(f.ctx, f.state)).rejects.toThrow(fault === "foreign output" ? "Plan document readback escaped" : "CONTROL_SOURCE_NOT_SETTLED");
  if (fault === "foreign output") expect(f.get.mock.calls.some(([path]) => path.includes("/issues/other/"))).toBe(false);
});
it("uses the original remaining case clock inside the unchanged180-second phase", async () => {
  const f = fixture("questions-and-approvals.review-plan", 1000); vi.spyOn(Date, "now").mockReturnValue(f.now);
  await expect(planReviewIdentityCases[0]!.act!(f.ctx, f.state)).rejects.toThrow("CONTROL_AFTER_SOURCE_SETTLED");
  expect(port.deadline).toBe(f.now + 1000);
});
it("retains the original180-second phase when the case has more time remaining", async () => {
  const f = fixture("questions-and-approvals.review-plan"); vi.spyOn(Date, "now").mockReturnValue(f.now);
  await expect(planReviewIdentityCases[0]!.act!(f.ctx, f.state)).rejects.toThrow("CONTROL_AFTER_SOURCE_SETTLED");
  expect(port.deadline).toBe(f.now + 180_000);
});
it.each(["missing", "invalid", "expired", "late await"])("rejects %s original deadline without resetting it", async fault => {
  const f = fixture("questions-and-approvals.review-plan", fault === "invalid" ? NaN : fault === "expired" ? -1 : 600_000);
  const ctx: ChatCatalogContext = fault === "missing" ? { ...f.ctx, observationDeadlineAt: undefined } : f.ctx;
  if (fault === "late await") port.afterLoadNow = f.now + 180_001;
  await expect(planReviewIdentityCases[0]!.act!(ctx, f.state)).rejects.toThrow(fault === "late await" ? "CONTROL_SOURCE_NOT_SETTLED" : "Original plan-review observation budget");
});
for (const scenarioId of ["questions-and-approvals.review-plan", "questions-and-approvals.reject-and-revise"]) {
  it(`${scenarioId}: actual owning poll accepts one genuine completed source notification within the original three-run maximum`, async () => {
    const f = fixture(scenarioId), definition = planReviewIdentityCases.find(row => row.scenarioId === scenarioId)!;
    await expect(definition.act!(f.ctx, f.state)).rejects.toThrow("CONTROL_AFTER_SOURCE_SETTLED");
  });
}
