import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  pipelineAutomationExecutions,
  pipelineCaseBlockers,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineStages,
  pipelineTransitions,
  pipelines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineRoutes } from "../routes/pipelines.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pipeline aggregation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pipeline aggregation routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const noopHeartbeat = { wakeup: async () => null };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipelines-aggregation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(pipelineAutomationExecutions);
    await db.delete(pipelineCaseBlockers);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(pipelines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", pipelineRoutes(db, { heartbeat: noopHeartbeat }));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name = "Aggregation Co") {
    const [company] = await db.insert(companies).values({
      name,
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    return company!;
  }

  async function seedAgent(companyId: string, name = "Pipeline Agent") {
    const [agent] = await db.insert(agents).values({
      companyId,
      name,
      role: "engineer",
      adapterType: "codex_local",
    }).returning();
    return agent!;
  }

  const boardActor: Express.Request["actor"] = {
    type: "board",
    userId: "board-user",
    source: "local_implicit",
    isInstanceAdmin: true,
  };

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: randomUUID(),
      source: "agent_key",
    };
  }

  const reviewStages = [
    { key: "intake", name: "Intake", kind: "open", position: 100 },
    { key: "drafting", name: "Drafting", kind: "working", position: 200 },
    {
      key: "review_human",
      name: "Final review",
      kind: "review",
      position: 300,
      config: { approveToStageKey: "done", rejectToStageKey: "cancelled", requestChangesToStageKey: "drafting", requireRejectReason: true, reviewerKind: "human" },
    },
    {
      key: "review_any",
      name: "Open review",
      kind: "review",
      position: 400,
      config: { approveToStageKey: "done", rejectToStageKey: "cancelled", requireRejectReason: false, reviewerKind: "any" },
    },
    { key: "done", name: "Done", kind: "done", position: 900 },
    { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
  ];

  async function seedPipeline(http: ReturnType<typeof request>, companyId: string, key: string, name: string) {
    const created = await http
      .post(`/api/companies/${companyId}/pipelines`)
      .send({ key, name, stages: reviewStages })
      .expect(201);
    return created.body as { id: string; stages: Array<{ id: string; key: string }> };
  }

  it("groups attention into suggestions, reviews, and heads-up with approver filtering", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id, "Drafting Agent");
    const board = request(app(boardActor));
    const asAgent = request(app(agentActor(company.id, agent.id)));

    const pipeline = await seedPipeline(board, company.id, "content", "Content production");

    const suggested = await board
      .post(`/api/pipelines/${pipeline.id}/cases`)
      .send({ caseKey: "suggested", title: "Launch blog post" })
      .expect(201);
    await asAgent
      .post(`/api/cases/${suggested.body.case.id}/suggest-transition`)
      .send({ toStageKey: "review_human", rationale: "Draft is ready for review", confidence: 0.9 })
      .expect(200);

    const humanReview = await board
      .post(`/api/pipelines/${pipeline.id}/cases`)
      .send({ caseKey: "human-review", title: "Needs a human decision" })
      .expect(201);
    await board
      .post(`/api/cases/${humanReview.body.case.id}/transition`)
      .send({ toStageKey: "review_human", expectedVersion: 1 })
      .expect(200);

    const anyReview = await board
      .post(`/api/pipelines/${pipeline.id}/cases`)
      .send({ caseKey: "any-review", title: "Anyone can decide" })
      .expect(201);
    await board
      .post(`/api/cases/${anyReview.body.case.id}/transition`)
      .send({ toStageKey: "review_any", expectedVersion: 1 })
      .expect(200);

    const upstream = await board
      .post(`/api/pipelines/${pipeline.id}/cases`)
      .send({ caseKey: "upstream", title: "Release plan" })
      .expect(201);
    const dependent = await board
      .post(`/api/pipelines/${pipeline.id}/cases`)
      .send({ caseKey: "dependent", title: "Dependent draft", blockedByCaseIds: [upstream.body.case.id] })
      .expect(201);
    const [workIssue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Write dependent draft",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agent.id,
    }).returning();
    await board
      .post(`/api/cases/${dependent.body.case.id}/issue-links`)
      .send({ issueId: workIssue!.id, role: "work" })
      .expect(201);
    await board
      .patch(`/api/cases/${upstream.body.case.id}`)
      .send({ fields: { releaseNotes: "Scope changed" }, expectedVersion: 1 })
      .expect(200);

    const boardFeed = await board.get(`/api/companies/${company.id}/pipelines-attention`).expect(200);

    expect(boardFeed.body.counts).toEqual({ suggestions: 1, reviews: 2, headsUp: 1 });
    const suggestion = boardFeed.body.suggestions[0];
    expect(suggestion.case.id).toBe(suggested.body.case.id);
    expect(suggestion.case.pipeline.name).toBe("Content production");
    expect(suggestion.suggestion.toStageKey).toBe("review_human");
    expect(suggestion.suggestion.toStageName).toBe("Final review");
    expect(suggestion.suggestion.rationale).toBe("Draft is ready for review");
    expect(suggestion.suggestion.suggestedBy).toEqual({ agentId: agent.id, agentName: "Drafting Agent" });

    const reviewCaseIds = boardFeed.body.reviews.map((entry: { case: { id: string } }) => entry.case.id);
    expect(reviewCaseIds).toEqual(expect.arrayContaining([humanReview.body.case.id, anyReview.body.case.id]));
    const humanEntry = boardFeed.body.reviews.find((entry: { case: { id: string } }) => entry.case.id === humanReview.body.case.id);
    expect(humanEntry.review).toMatchObject({
      reviewerKind: "human",
      approveToStageKey: "done",
      rejectToStageKey: "cancelled",
      requestChangesToStageKey: "drafting",
      requireRejectReason: true,
      expectedVersion: 2,
    });

    const headsUp = boardFeed.body.headsUp[0];
    expect(headsUp.case.id).toBe(dependent.body.case.id);
    expect(headsUp.drift.upstream).toMatchObject({
      caseId: upstream.body.case.id,
      caseKey: "upstream",
      title: "Release plan",
      pipelineId: pipeline.id,
      pipelineName: "Content production",
    });
    expect(headsUp.drift.previousVersion).toBe(1);
    expect(headsUp.drift.version).toBe(2);
    expect(headsUp.workIssue).toMatchObject({ issueId: workIssue!.id, status: "in_progress" });
    expect(headsUp.activeWork).toMatchObject({ issueId: workIssue!.id, agentId: agent.id, agentName: "Drafting Agent" });

    // Agent callers only await review stages with reviewerKind "any".
    const agentFeed = await asAgent.get(`/api/companies/${company.id}/pipelines-attention`).expect(200);
    expect(agentFeed.body.reviews.map((entry: { case: { id: string } }) => entry.case.id)).toEqual([anyReview.body.case.id]);

    // Touching the dependent case does not resolve the drift notice; it must be acknowledged.
    await board
      .patch(`/api/cases/${dependent.body.case.id}`)
      .send({ title: "Dependent draft v2", expectedVersion: 1 })
      .expect(200);
    const stillDriftedFeed = await board.get(`/api/companies/${company.id}/pipelines-attention`).expect(200);
    expect(stillDriftedFeed.body.headsUp).toHaveLength(1);

    await board
      .post(`/api/cases/${dependent.body.case.id}/acknowledge-drift`)
      .send({ expectedVersion: 1 })
      .expect(200);
    const resolvedFeed = await board.get(`/api/companies/${company.id}/pipelines-attention`).expect(200);
    expect(resolvedFeed.body.headsUp).toEqual([]);

    // Terminal cases drop out of the suggestions group.
    await board
      .post(`/api/cases/${anyReview.body.case.id}/review`)
      .send({ decision: "approve", expectedVersion: 2 })
      .expect(200);
    const afterApprove = await board.get(`/api/companies/${company.id}/pipelines-attention`).expect(200);
    expect(afterApprove.body.reviews.map((entry: { case: { id: string } }) => entry.case.id)).toEqual([humanReview.body.case.id]);
  });

  it("serves the company-wide learnings feed with joins, filtering, and pagination", async () => {
    const company = await seedCompany();
    const board = request(app(boardActor));
    const pipeline = await seedPipeline(board, company.id, "content", "Content production");

    const first = await board
      .post(`/api/pipelines/${pipeline.id}/cases`)
      .send({ caseKey: "first", title: "First item" })
      .expect(201);
    await board
      .post(`/api/cases/${first.body.case.id}/transition`)
      .send({ toStageKey: "review_human", expectedVersion: 1 })
      .expect(200);
    await board
      .post(`/api/cases/${first.body.case.id}/review`)
      .send({ decision: "reject", reason: "Wrong audience", expectedVersion: 2 })
      .expect(200);

    const second = await board
      .post(`/api/pipelines/${pipeline.id}/cases`)
      .send({ caseKey: "second", title: "Second item" })
      .expect(201);
    await board
      .post(`/api/cases/${second.body.case.id}/transition`)
      .send({ toStageKey: "review_human", expectedVersion: 1 })
      .expect(200);
    await board
      .post(`/api/cases/${second.body.case.id}/review`)
      .send({ decision: "request_changes", reason: "Tighten the intro", expectedVersion: 2 })
      .expect(200);

    const feed = await board
      .get(`/api/companies/${company.id}/case-events?types=review_decided`)
      .expect(200);
    expect(feed.body.items).toHaveLength(2);
    expect(feed.body.items.every((item: { type: string }) => item.type === "review_decided")).toBe(true);
    // Newest first.
    expect(feed.body.items[0].case.caseKey).toBe("second");
    expect(feed.body.items[0].payload).toMatchObject({ decision: "request_changes", reason: "Tighten the intro" });
    expect(feed.body.items[0].pipeline).toMatchObject({ id: pipeline.id, name: "Content production" });
    expect(feed.body.items[0].fromStage).toMatchObject({ key: "review_human" });
    expect(feed.body.items[0].toStage).toMatchObject({ key: "drafting" });
    expect(feed.body.items[1].case.caseKey).toBe("first");
    expect(feed.body.items[1].payload).toMatchObject({ decision: "reject", reason: "Wrong audience" });

    const page = await board
      .get(`/api/companies/${company.id}/case-events?types=review_decided,transition_forced&limit=1`)
      .expect(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.pagination).toMatchObject({ limit: 1, offset: 0, nextOffset: 1, hasMore: true });
    const nextPage = await board
      .get(`/api/companies/${company.id}/case-events?types=review_decided&limit=1&offset=1`)
      .expect(200);
    expect(nextPage.body.items[0].case.caseKey).toBe("first");
    expect(nextPage.body.pagination.hasMore).toBe(false);

    await board.get(`/api/companies/${company.id}/case-events?types=Bad%20Type!`).expect(400);
    await board.get(`/api/companies/${company.id}/case-events?limit=0`).expect(400);
  });

  it("returns the recursive children tree with per-node rollups and a flat summary", async () => {
    const company = await seedCompany();
    const board = request(app(boardActor));
    const release = await seedPipeline(board, company.id, "release", "Release train");
    const content = await seedPipeline(board, company.id, "content", "Content production");

    const parent = await board
      .post(`/api/pipelines/${release.id}/cases`)
      .send({ caseKey: "launch", title: "Launch v2" })
      .expect(201);
    const doneChild = await board
      .post(`/api/pipelines/${content.id}/cases`)
      .send({ caseKey: "blog", title: "Blog post", parentCaseId: parent.body.case.id })
      .expect(201);
    await board
      .post(`/api/cases/${doneChild.body.case.id}/transition`)
      .send({ toStageKey: "done", expectedVersion: 1 })
      .expect(200);
    const openChild = await board
      .post(`/api/pipelines/${content.id}/cases`)
      .send({ caseKey: "video", title: "Video", parentCaseId: parent.body.case.id })
      .expect(201);
    const droppedGrandchild = await board
      .post(`/api/pipelines/${content.id}/cases`)
      .send({ caseKey: "short", title: "Short clip", parentCaseId: openChild.body.case.id })
      .expect(201);
    await board
      .post(`/api/cases/${droppedGrandchild.body.case.id}/transition`)
      .send({ toStageKey: "cancelled", expectedVersion: 1 })
      .expect(200);

    const tree = await board.get(`/api/cases/${parent.body.case.id}/children`).expect(200);
    expect(tree.body.rollup).toEqual({ total: 3, done: 1, dropped: 1, inMotion: 1 });
    expect(tree.body.truncated).toBe(false);
    expect(tree.body.totalNodes).toBe(4);
    expect(tree.body.case.pipeline).toMatchObject({ id: release.id, name: "Release train" });
    expect(tree.body.childGroups).toHaveLength(1);
    const group = tree.body.childGroups[0];
    expect(group.pipeline).toMatchObject({ id: content.id, name: "Content production" });
    expect(group.cases.map((node: { caseKey: string }) => node.caseKey)).toEqual(["blog", "video"]);
    const blogNode = group.cases[0];
    expect(blogNode.terminalKind).toBe("done");
    expect(blogNode.stage).toMatchObject({ key: "done", kind: "done" });
    expect(blogNode.rollup).toEqual({ total: 0, done: 0, dropped: 0, inMotion: 0 });
    const videoNode = group.cases[1];
    expect(videoNode.rollup).toEqual({ total: 1, done: 0, dropped: 1, inMotion: 0 });
    expect(videoNode.childGroups[0].cases[0]).toMatchObject({ caseKey: "short", terminalKind: "cancelled" });

    const detail = await board.get(`/api/cases/${parent.body.case.id}`).expect(200);
    expect(detail.body.childrenSummary).toMatchObject({ total: 2, done: 1, dropped: 0, inMotion: 1 });

    await board.get(`/api/cases/${randomUUID()}/children`).expect(404);
  });

  it("enriches case detail and pipeline case lists with activeWork", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id, "Working Agent");
    const board = request(app(boardActor));
    const pipeline = await seedPipeline(board, company.id, "content", "Content production");

    const idleCase = await board
      .post(`/api/pipelines/${pipeline.id}/cases`)
      .send({ caseKey: "idle", title: "Idle item" })
      .expect(201);
    const workedCase = await board
      .post(`/api/pipelines/${pipeline.id}/cases`)
      .send({ caseKey: "worked", title: "Worked item" })
      .expect(201);

    const [todoIssue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Not started yet",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agent.id,
    }).returning();
    const [activeIssue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Write the draft",
      identifier: "AGG-1",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agent.id,
      startedAt: new Date("2026-06-10T12:00:00Z"),
    }).returning();
    await board
      .post(`/api/cases/${workedCase.body.case.id}/issue-links`)
      .send({ issueId: todoIssue!.id, role: "work" })
      .expect(201);
    await board
      .post(`/api/cases/${workedCase.body.case.id}/issue-links`)
      .send({ issueId: activeIssue!.id, role: "work" })
      .expect(201);

    const detail = await board.get(`/api/cases/${workedCase.body.case.id}`).expect(200);
    expect(detail.body.activeWork).toMatchObject({
      issueId: activeIssue!.id,
      issueIdentifier: "AGG-1",
      issueTitle: "Write the draft",
      agentId: agent.id,
      agentName: "Working Agent",
    });
    expect(detail.body.activeWork.startedAt).toBeTruthy();

    const idleDetail = await board.get(`/api/cases/${idleCase.body.case.id}`).expect(200);
    expect(idleDetail.body.activeWork).toBeNull();

    const list = await board.get(`/api/pipelines/${pipeline.id}/cases`).expect(200);
    const listedWorked = list.body.find((row: { case: { id: string } }) => row.case.id === workedCase.body.case.id);
    const listedIdle = list.body.find((row: { case: { id: string } }) => row.case.id === idleCase.body.case.id);
    expect(listedWorked.activeWork).toMatchObject({ issueId: activeIssue!.id, agentName: "Working Agent" });
    expect(listedIdle.activeWork).toBeNull();
  });

  it("derives pipeline connections from observed cross-pipeline case parentage", async () => {
    const company = await seedCompany();
    const board = request(app(boardActor));
    const release = await seedPipeline(board, company.id, "release", "Release train");
    const content = await seedPipeline(board, company.id, "content", "Content production");
    const assets = await seedPipeline(board, company.id, "assets", "Asset production");
    const lonely = await seedPipeline(board, company.id, "lonely", "Unconnected");

    const releaseCase = await board
      .post(`/api/pipelines/${release.id}/cases`)
      .send({ caseKey: "launch", title: "Launch" })
      .expect(201);
    const contentCase = await board
      .post(`/api/pipelines/${content.id}/cases`)
      .send({ caseKey: "blog", title: "Blog", parentCaseId: releaseCase.body.case.id })
      .expect(201);
    await board
      .post(`/api/pipelines/${assets.id}/cases`)
      .send({ caseKey: "thumb", title: "Thumbnail", parentCaseId: contentCase.body.case.id })
      .expect(201);
    // Same-pipeline parentage must not create a self connection.
    await board
      .post(`/api/pipelines/${content.id}/cases`)
      .send({ caseKey: "blog-child", title: "Blog child", parentCaseId: contentCase.body.case.id })
      .expect(201);

    // Move one case into a working stage and one into a review stage so the
    // list response exposes board-facing activity counts.
    await board
      .post(`/api/cases/${releaseCase.body.case.id}/transition`)
      .send({ toStageKey: "drafting", expectedVersion: releaseCase.body.case.version })
      .expect(200);
    await board
      .post(`/api/cases/${contentCase.body.case.id}/transition`)
      .send({ toStageKey: "review_human", expectedVersion: contentCase.body.case.version })
      .expect(200);

    const listed = await board.get(`/api/companies/${company.id}/pipelines`).expect(200);
    const byId = new Map(listed.body.map((row: { id: string }) => [row.id, row]));
    expect(byId.get(release.id)).toMatchObject({ openCaseCount: 1, attentionCount: 0, inMotionCount: 1 });
    expect(byId.get(content.id)).toMatchObject({ openCaseCount: 2, attentionCount: 1, inMotionCount: 0 });
    expect(byId.get(assets.id)).toMatchObject({ openCaseCount: 1, attentionCount: 0, inMotionCount: 0 });
    expect(byId.get(lonely.id)).toMatchObject({ openCaseCount: 0, attentionCount: 0, inMotionCount: 0, lastActivityAt: null });
    expect((byId.get(content.id) as { lastActivityAt: unknown }).lastActivityAt).toBeTruthy();
    expect((byId.get(release.id) as { connections: unknown }).connections).toEqual({
      upstreamPipelineIds: [],
      downstreamPipelineIds: [content.id],
    });
    expect((byId.get(content.id) as { connections: unknown }).connections).toEqual({
      upstreamPipelineIds: [release.id],
      downstreamPipelineIds: [assets.id],
    });
    expect((byId.get(assets.id) as { connections: unknown }).connections).toEqual({
      upstreamPipelineIds: [content.id],
      downstreamPipelineIds: [],
    });
    expect((byId.get(lonely.id) as { connections: unknown }).connections).toEqual({
      upstreamPipelineIds: [],
      downstreamPipelineIds: [],
    });
  });
});
