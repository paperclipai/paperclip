import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  activityLog,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecrets,
  createDb,
  documents,
  documentRevisions,
  heartbeatRuns,
  issueComments,
  issues,
  pipelineAutomationExecutions,
  pipelineCaseBlockers,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineDocuments,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  principalPermissionGrants,
  routineRevisions,
  routineRuns,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { pipelineRoutes } from "../routes/pipelines.js";
import {
  PIPELINE_CASE_EVENTS_MAX_LIMIT,
  PIPELINE_CONTEXT_PACK_EVENT_LIMIT,
} from "../services/pipelines.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pipeline route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pipeline routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const noopHeartbeat = { wakeup: async () => null };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipelines-routes-");
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
    await db.delete(pipelineDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(routineRuns);
    await db.delete(routineRevisions);
    await db.delete(companySecretBindings);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(pipelines);
    await db.delete(routines);
    await db.delete(companySecrets);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
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
    instance.use("/api", issueRoutes(db, {} as any));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name = "Pipeline Co") {
    const [company] = await db.insert(companies).values({
      name,
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    return company!;
  }

  async function grantAgentPipelineWrite(
    companyId: string,
    agentId: string,
    scope: Record<string, unknown> | null = null,
  ) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
    }).onConflictDoNothing();
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey: "pipelines:write",
      scope,
      grantedByUserId: null,
    }).onConflictDoNothing();
  }

  const boardActor: Express.Request["actor"] = {
    type: "board",
    userId: "board-user",
    source: "local_implicit",
    isInstanceAdmin: true,
  };

  it("exposes the pipeline and case route surface", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));

    const createdPipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "content",
        name: "Content",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          {
            key: "review",
            name: "Review",
            kind: "review",
            position: 200,
            config: { approveToStageKey: "done", rejectToStageKey: "cancelled", requireRejectReason: true },
          },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const pipelineId = createdPipeline.body.id;
    const stageId = createdPipeline.body.stages[0].id;
    expect(createdPipeline.body.stages[0].kind).toBe("working");

    await http.get(`/api/companies/${company.id}/pipelines`).expect(200);
    await http.get(`/api/pipelines/${pipelineId}`).expect(200);
    await http.patch(`/api/pipelines/${pipelineId}`).send({ name: "Content Ops", enforceTransitions: true }).expect(200);
    const qaStage = await http
      .post(`/api/pipelines/${pipelineId}/stages`)
      .send({ key: "qa", name: "QA", kind: "working", position: 300 })
      .expect(201);
    await http.patch(`/api/pipelines/${pipelineId}/stages/${qaStage.body.id}`).send({ name: "QA pass" }).expect(200);
    const legacyAliasStage = await http
      .post(`/api/pipelines/${pipelineId}/stages`)
      .send({ key: "legacy_alias", name: "Legacy alias", kind: "open", position: 350 })
      .expect(201);
    expect(legacyAliasStage.body.kind).toBe("working");
    await http
      .put(`/api/pipelines/${pipelineId}/transitions`)
      .send({ enforceTransitions: false, transitions: [{ fromStageKey: "intake", toStageKey: "review" }] })
      .expect(200);
    await http.put(`/api/pipelines/${pipelineId}/documents/guidance`).send({ body: "Use the rubric." }).expect(200);
    await http.get(`/api/pipelines/${pipelineId}/documents/guidance`).expect(200);

    const ingested = await http
      .post(`/api/pipelines/${pipelineId}/cases`)
      .send({ caseKey: "case-1", title: "Case 1", fields: { channel: "blog" } })
      .expect(201);
    const caseId = ingested.body.case.id;
    const batchIngest = await http
      .post(`/api/pipelines/${pipelineId}/cases/batch`)
      .send({ items: [{ caseKey: "case-2", title: "Case 2", blockedByCaseKeys: ["case-3"] }, { caseKey: "case-3", title: "Case 3" }] })
      .expect(200);
    expect(batchIngest.body[0].ok).toBe(true);
    const routeBlockers = await db
      .select()
      .from(pipelineCaseBlockers)
      .where(eq(pipelineCaseBlockers.caseId, batchIngest.body[0].case.id));
    expect(routeBlockers.map((row) => row.blockedByCaseId)).toEqual([batchIngest.body[1].case.id]);
    await http.get(`/api/pipelines/${pipelineId}/cases`).expect(200);
    await http.get(`/api/cases/${caseId}`).expect(200);
    await http.patch(`/api/cases/${caseId}`).send({ title: "Case 1 updated", expectedVersion: 1 }).expect(200);
    const claimed = await http.post(`/api/cases/${caseId}/claim`).send({ leaseSeconds: 60 }).expect(200);
    await http.post(`/api/cases/${caseId}/release`).send({ leaseToken: claimed.body.leaseToken }).expect(200);
    const suggestion = await http
      .post(`/api/cases/${caseId}/suggest-transition`)
      .send({ toStageKey: "review", rationale: "Ready for review" })
      .expect(200);
    await http
      .post(`/api/cases/${caseId}/resolve-suggestion`)
      .send({ suggestionId: suggestion.body.suggestion.id, resolution: "accept", expectedVersion: 1 })
      .expect(200);
    await http.get(`/api/cases/${caseId}/events`).expect(200);
    await http.get(`/api/companies/${company.id}/review-cases`).expect(200);
    await http.post(`/api/cases/${caseId}/review`).send({ decision: "approve", expectedVersion: 2 }).expect(200);

    const reviewCase = await http
      .post(`/api/pipelines/${pipelineId}/cases`)
      .send({ caseKey: "case-review", title: "Bulk review" })
      .expect(201);
    await http
      .post(`/api/cases/${reviewCase.body.case.id}/transition`)
      .send({ toStageKey: "review", expectedVersion: 1 })
      .expect(200);
    await http
      .post(`/api/companies/${company.id}/review-cases/bulk`)
      .send({ items: [{ caseId: reviewCase.body.case.id, decision: "reject", reason: "Not useful", expectedVersion: 2 }] })
      .expect(200);

    const blocker = await http.post(`/api/pipelines/${pipelineId}/cases`).send({ caseKey: "blocker", title: "Blocker" }).expect(201);
    const blocked = await http.post(`/api/pipelines/${pipelineId}/cases`).send({ caseKey: "blocked", title: "Blocked" }).expect(201);
    await http
      .put(`/api/cases/${blocked.body.case.id}/blockers`)
      .send({ blockedByCaseIds: [blocker.body.case.id] })
      .expect(200);
    await http.get(`/api/cases/${blocked.body.case.id}/rollup`).expect(200);
    await http.get(`/api/cases/${blocked.body.case.id}/context-pack`).expect(200);
    const conversation = await http.post(`/api/cases/${blocked.body.case.id}/open-conversation`).expect(201);
    expect(conversation.body.created).toBe(true);
    expect(conversation.body.issue.title).toBe("Discuss: Blocked");
    expect(conversation.body.issue.title).not.toMatch(/\bcase\b/i);
    expect(conversation.body.issue.description).toContain("Pipeline Item Context");
    const sameConversation = await http.post(`/api/cases/${blocked.body.case.id}/open-conversation`).expect(200);
    expect(sameConversation.body.created).toBe(false);
    expect(sameConversation.body.issue.id).toBe(conversation.body.issue.id);

    const linkedIssue = await http.post(`/api/cases/${blocked.body.case.id}/issue-links`)
      .send({ issueId: ingested.body.case.id, role: "work" });
    expect(linkedIssue.status).toBe(404);
    const manualIssue = await db.insert(issues).values({
      companyId: company.id,
      title: "Manual work issue",
      status: "todo",
      priority: "medium",
    }).returning();
    const workLink = await http.post(`/api/cases/${blocked.body.case.id}/issue-links`)
      .send({ issueId: manualIssue[0]!.id, role: "work" })
      .expect(201);
    await http.get(`/api/cases/${blocked.body.case.id}/issue-links`).expect(200);
    const issueDetail = await http.get(`/api/issues/${manualIssue[0]!.id}`).expect(200);
    expect(issueDetail.body.linkedCases).toHaveLength(1);
    expect(issueDetail.body.linkedCases[0].id).toBe(blocked.body.case.id);
    await http.delete(`/api/cases/${blocked.body.case.id}/issue-links/${workLink.body.id}`).expect(200);

    const [routine] = await db.insert(routines).values({ companyId: company.id, title: "Routine" }).returning();
    await db.insert(pipelineAutomationExecutions).values({
      companyId: company.id,
      caseId: blocked.body.case.id,
      automationId: "retry-me",
      triggeringEventId: randomUUID(),
      routineId: routine!.id,
      status: "failed",
      error: "boom",
    });
    await http.post(`/api/cases/${blocked.body.case.id}/automations/retry-me/retry`).expect(200);

    await http.delete(`/api/pipelines/${pipelineId}/stages/${stageId}?moveCasesToStageId=${qaStage.body.id}`).expect(200);
  });

  it.each([
    ["require-children", { requireChildrenTerminal: true }],
    ["auto-advance", { autoAdvanceOnChildrenTerminal: "done" }],
  ])("classifies child-gated non-breakdown cases with unfinished children as waiting (%s)", async (suffix, config) => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: `child-gate-${suffix}`,
        name: `Child gate ${suffix}`,
        stages: [
          { key: "waiting", name: "Waiting", kind: "working", position: 100, config },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const parent = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: `parent-${suffix}`, title: "Parent" })
      .expect(201);
    await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: `child-${suffix}`, title: "Child", parentCaseId: parent.body.case.id })
      .expect(201);

    const detail = await http.get(`/api/cases/${parent.body.case.id}`).expect(200);

    expect(detail.body.childrenSummary).toMatchObject({ childCount: 1, terminalChildCount: 0 });
    expect(detail.body.liveness).toMatchObject({
      state: "waiting",
      reason: "children_waiting",
      message: "Pipeline item is waiting for child items to finish.",
    });
  });

  it("returns origin-run producer issue as the case conversation source", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Producer Agent",
      role: "engineer",
      status: "idle",
    }).returning();
    const [producerIssue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Produced the item",
      status: "done",
      priority: "medium",
      completedAt: new Date(),
    }).returning();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company.id,
      agentId: agent!.id,
      status: "succeeded",
      contextSnapshot: { issueId: producerIssue!.id },
    });
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "producer-origin", name: "Producer origin" })
      .expect(201);
    const created = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "origin", title: "Origin-produced item" })
      .expect(201);
    await db
      .update(pipelineCases)
      .set({ originRunId: runId })
      .where(eq(pipelineCases.id, created.body.case.id));

    const detail = await http.get(`/api/cases/${created.body.case.id}`).expect(200);

    expect(detail.body.conversationSource).toMatchObject({
      reason: "producer_create",
      sourceRunId: runId,
      linkRole: null,
      issue: { id: producerIssue!.id, title: "Produced the item" },
    });
  });

  it("prefers the latest material agent update run over creation provenance", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Producer Agent",
      role: "engineer",
      status: "idle",
    }).returning();
    const [creationIssue, updateIssue] = await db.insert(issues).values([
      {
        companyId: company.id,
        title: "Created the item",
        status: "done",
        priority: "medium",
        completedAt: new Date(),
      },
      {
        companyId: company.id,
        title: "Updated the item materially",
        status: "done",
        priority: "medium",
        completedAt: new Date(),
      },
    ]).returning();
    const creationRunId = randomUUID();
    const updateRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: creationRunId,
        companyId: company.id,
        agentId: agent!.id,
        status: "succeeded",
        contextSnapshot: { issueId: creationIssue!.id },
      },
      {
        id: updateRunId,
        companyId: company.id,
        agentId: agent!.id,
        status: "succeeded",
        contextSnapshot: { issueId: updateIssue!.id },
      },
    ]);
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "producer-update", name: "Producer update" })
      .expect(201);
    const created = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "update", title: "Update-produced item" })
      .expect(201);
    await db
      .update(pipelineCases)
      .set({ originRunId: creationRunId })
      .where(eq(pipelineCases.id, created.body.case.id));
    await db.insert(pipelineCaseEvents).values({
      companyId: company.id,
      caseId: created.body.case.id,
      type: "updated",
      actorType: "agent",
      actorAgentId: agent!.id,
      runId: updateRunId,
      payload: { materialChanged: true },
      createdAt: new Date(Date.now() + 1_000),
    });

    const detail = await http.get(`/api/cases/${created.body.case.id}`).expect(200);

    expect(detail.body.conversationSource).toMatchObject({
      reason: "producer_update",
      sourceRunId: updateRunId,
      issue: { id: updateIssue!.id, title: "Updated the item materially" },
    });
  });

  it("prefers automation links over conversation and work link fallbacks", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "producer-links", name: "Producer links" })
      .expect(201);
    const created = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "links", title: "Link-produced item" })
      .expect(201);
    const [workIssue, conversationIssue, automationIssue] = await db.insert(issues).values([
      { companyId: company.id, title: "Legacy work", status: "todo", priority: "medium" },
      { companyId: company.id, title: "Manual discussion", status: "todo", priority: "medium" },
      { companyId: company.id, title: "Automation producer", status: "todo", priority: "medium" },
    ]).returning();
    await db.insert(pipelineCaseIssueLinks).values([
      { companyId: company.id, caseId: created.body.case.id, issueId: workIssue!.id, role: "work" },
      { companyId: company.id, caseId: created.body.case.id, issueId: conversationIssue!.id, role: "conversation" },
      { companyId: company.id, caseId: created.body.case.id, issueId: automationIssue!.id, role: "automation" },
    ]);

    const detail = await http.get(`/api/cases/${created.body.case.id}`).expect(200);

    expect(detail.body.conversationSource).toMatchObject({
      reason: "automation_link",
      linkRole: "automation",
      issue: { id: automationIssue!.id, title: "Automation producer" },
    });
  });

  it("does not create a duplicate discussion issue when a producer source exists", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Producer Agent",
      role: "engineer",
      status: "idle",
    }).returning();
    const [producerIssue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Producer thread",
      status: "done",
      priority: "medium",
      completedAt: new Date(),
    }).returning();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company.id,
      agentId: agent!.id,
      status: "succeeded",
      contextSnapshot: { issueId: producerIssue!.id },
    });
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "producer-open", name: "Producer open" })
      .expect(201);
    const created = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "open", title: "Open conversation item" })
      .expect(201);
    await db
      .update(pipelineCases)
      .set({ originRunId: runId })
      .where(eq(pipelineCases.id, created.body.case.id));
    const beforeIssues = await db.select().from(issues).where(eq(issues.companyId, company.id));

    const opened = await http.post(`/api/cases/${created.body.case.id}/open-conversation`).expect(200);

    expect(opened.body).toMatchObject({
      created: false,
      issue: { id: producerIssue!.id, title: "Producer thread" },
    });
    const afterIssues = await db.select().from(issues).where(eq(issues.companyId, company.id));
    expect(afterIssues).toHaveLength(beforeIssues.length);
  });

  it("allows same-company agents to create pipelines without an explicit pipelines:write grant", async () => {
    const company = await seedCompany();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Pipeline Builder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
    }).returning();
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent!.id,
      status: "active",
      membershipRole: "member",
    });
    const runId = randomUUID();
    const agentActor: Express.Request["actor"] = {
      type: "agent",
      agentId: agent!.id,
      companyId: company.id,
      runId,
      source: "agent_key",
    };

    const res = await request(app(agentActor))
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "agent-created",
        name: "Agent Created",
      })
      .expect(201);

    expect(res.body).toMatchObject({
      key: "agent-created",
      createdByAgentId: agent!.id,
    });
    await request(app(agentActor))
      .patch(`/api/pipelines/${res.body.id}`)
      .send({ name: "Agent Created Updated" })
      .expect(200);
    await request(app(agentActor))
      .post(`/api/pipelines/${res.body.id}/cases`)
      .send({ caseKey: "agent-created-case", title: "Agent created case" })
      .expect(201);
    const grants = await db
      .select()
      .from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, agent!.id));
    expect(grants).toHaveLength(0);
  });

  it("lists a case's children across pipeline boundaries via /cases/:caseId/children", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));

    const releasePipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "releases", name: "Releases" })
      .expect(201);
    const featurePipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "features", name: "Features" })
      .expect(201);

    const release = await http
      .post(`/api/pipelines/${releasePipeline.body.id}/cases`)
      .send({ caseKey: "v1", title: "Release v1" })
      .expect(201);
    const releaseCaseId = release.body.case.id as string;

    // Children live in a *different* pipeline than their parent — the release -> feature tree.
    const featureA = await http
      .post(`/api/pipelines/${featurePipeline.body.id}/cases`)
      .send({ caseKey: "feat-a", title: "Feature A", parentCaseId: releaseCaseId })
      .expect(201);
    const featureB = await http
      .post(`/api/pipelines/${featurePipeline.body.id}/cases`)
      .send({ caseKey: "feat-b", title: "Feature B", parentCaseId: releaseCaseId })
      .expect(201);

    // The pipeline-scoped list filters by the release's own pipeline and so finds nothing.
    const samePipelineList = await http
      .get(`/api/pipelines/${releasePipeline.body.id}/cases?parentCaseId=${releaseCaseId}`)
      .expect(200);
    expect(samePipelineList.body).toHaveLength(0);

    // The case-scoped endpoint returns the cross-pipeline children, matching childCount.
    const children = await http.get(`/api/cases/${releaseCaseId}/children`).expect(200);
    const childIds = children.body.map((row: { case: { id: string } }) => row.case.id).sort();
    expect(childIds).toEqual([featureA.body.case.id, featureB.body.case.id].sort());
    for (const row of children.body) {
      expect(row.case.pipelineId).toBe(featurePipeline.body.id);
    }

    const detail = await http.get(`/api/cases/${releaseCaseId}`).expect(200);
    expect(detail.body.childrenSummary.childCount).toBe(2);

    const tree = await http.get(`/api/cases/${releaseCaseId}/children/tree`).expect(200);
    expect(tree.body.case.id).toBe(releaseCaseId);
    expect(tree.body.childGroups.flatMap((group: { cases: Array<{ id: string }> }) => group.cases.map((item) => item.id)).sort())
      .toEqual([featureA.body.case.id, featureB.body.case.id].sort());
  });

  it("exposes active descendant state for pipeline lists and direct child rows", async () => {
    const company = await seedCompany();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Live Builder",
      role: "engineer",
      status: "idle",
    }).returning();
    const http = request(app(boardActor));

    const releasePipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "live-releases", name: "Live releases" })
      .expect(201);
    const featurePipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "live-features", name: "Live features" })
      .expect(201);

    const release = await http
      .post(`/api/pipelines/${releasePipeline.body.id}/cases`)
      .send({ caseKey: "launch", title: "Launch" })
      .expect(201);
    const child = await http
      .post(`/api/pipelines/${featurePipeline.body.id}/cases`)
      .send({ caseKey: "child", title: "Child work", parentCaseId: release.body.case.id })
      .expect(201);
    const grandchild = await http
      .post(`/api/pipelines/${featurePipeline.body.id}/cases`)
      .send({ caseKey: "grandchild", title: "Grandchild work", parentCaseId: child.body.case.id })
      .expect(201);

    const [childIssue, grandchildIssue] = await db.insert(issues).values([
      {
        companyId: company.id,
        title: "Build child work",
        identifier: "LIVE-CHILD",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agent!.id,
        startedAt: new Date("2026-06-16T10:00:00Z"),
      },
      {
        companyId: company.id,
        title: "Build grandchild work",
        identifier: "LIVE-GRANDCHILD",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agent!.id,
        startedAt: new Date("2026-06-16T10:05:00Z"),
      },
    ]).returning();
    await http
      .post(`/api/cases/${child.body.case.id}/issue-links`)
      .send({ issueId: childIssue!.id, role: "work" })
      .expect(201);
    await http
      .post(`/api/cases/${grandchild.body.case.id}/issue-links`)
      .send({ issueId: grandchildIssue!.id, role: "automation" })
      .expect(201);

    const pipelinesList = await http.get(`/api/companies/${company.id}/pipelines`).expect(200);
    const releaseRow = pipelinesList.body.find((row: { id: string }) => row.id === releasePipeline.body.id);
    const featureRow = pipelinesList.body.find((row: { id: string }) => row.id === featurePipeline.body.id);
    expect(releaseRow).toMatchObject({
      descendantActiveWorkCount: 2,
    });
    expect(featureRow).toMatchObject({
      descendantActiveWorkCount: 1,
    });

    const releaseDetail = await http.get(`/api/cases/${release.body.case.id}`).expect(200);
    expect(releaseDetail.body.childrenSummary.descendantActiveWorkCount).toBe(2);

    const children = await http.get(`/api/cases/${release.body.case.id}/children`).expect(200);
    expect(Array.isArray(children.body)).toBe(true);
    expect(children.body).toHaveLength(1);
    expect(children.body[0]).toMatchObject({
      case: { id: child.body.case.id },
      activeWork: {
        issueId: childIssue!.id,
        issueIdentifier: "LIVE-CHILD",
        issueTitle: "Build child work",
        issueRole: "work",
        agentId: agent!.id,
        agentName: "Live Builder",
      },
      descendantActiveWorkCount: 1,
    });

    const grandchildDetail = await http.get(`/api/cases/${grandchild.body.case.id}`).expect(200);
    expect(grandchildDetail.body.activeWork).toMatchObject({
      issueId: grandchildIssue!.id,
      issueIdentifier: "LIVE-GRANDCHILD",
      issueTitle: "Build grandchild work",
      issueRole: "automation",
      agentId: agent!.id,
      agentName: "Live Builder",
    });
  });

  it("lists, guards, and restores pipeline document revisions", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "docs", name: "Docs" })
      .expect(201);
    const pipelineId = pipeline.body.id as string;

    const first = await http
      .put(`/api/pipelines/${pipelineId}/documents/guidance`)
      .send({ title: "Guidance", body: "Version one" })
      .expect(200);
    expect(first.body.revision).toMatchObject({ revisionNumber: 1, body: "Version one" });

    const second = await http
      .put(`/api/pipelines/${pipelineId}/documents/guidance`)
      .send({ title: "Guidance", body: "Version two", baseRevisionId: first.body.revision.id })
      .expect(200);
    expect(second.body.revision).toMatchObject({ revisionNumber: 2, body: "Version two" });

    const listed = await http
      .get(`/api/pipelines/${pipelineId}/documents/guidance/revisions`)
      .expect(200);
    expect(listed.body.map((revision: { revisionNumber: number; body: string }) => ({
      revisionNumber: revision.revisionNumber,
      body: revision.body,
    }))).toEqual([
      { revisionNumber: 2, body: "Version two" },
      { revisionNumber: 1, body: "Version one" },
    ]);

    const stale = await http
      .put(`/api/pipelines/${pipelineId}/documents/guidance`)
      .send({ title: "Guidance", body: "Stale edit", baseRevisionId: first.body.revision.id })
      .expect(409);
    expect(stale.body).toMatchObject({
      code: "stale_base_revision",
      details: {
        latestRevisionId: second.body.revision.id,
        latestRevisionNumber: 2,
        latestRevision: {
          id: second.body.revision.id,
          revisionNumber: 2,
        },
      },
    });

    const noBaseUpdate = await http
      .put(`/api/pipelines/${pipelineId}/documents/guidance`)
      .send({ title: "Guidance", body: "Version three" })
      .expect(200);
    expect(noBaseUpdate.body.revision).toMatchObject({ revisionNumber: 3, body: "Version three" });

    const restored = await http
      .post(`/api/pipelines/${pipelineId}/documents/guidance/revisions/${first.body.revision.id}/restore`)
      .send({})
      .expect(200);
    expect(restored.body).toMatchObject({
      restoredFromRevisionId: first.body.revision.id,
      restoredFromRevisionNumber: 1,
      revision: {
        revisionNumber: 4,
        body: "Version one",
        changeSummary: "Restored from revision 1",
      },
      document: {
        latestBody: "Version one",
        latestRevisionNumber: 4,
      },
    });

    const latest = await http
      .get(`/api/pipelines/${pipelineId}/documents/guidance`)
      .expect(200);
    expect(latest.body.document.latestBody).toBe("Version one");
    expect(latest.body.revision.id).toBe(restored.body.revision.id);
  });

  it("exposes first-stage add form fields and returns row failures for missing required values", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "add-form",
        name: "Add form",
        stages: [
          {
            key: "drafting",
            name: "Drafting",
            kind: "open",
            position: 100,
            config: {
              variables: [
                {
                  key: "type",
                  label: "Type",
                  type: "select",
                  options: ["Blog post", "Launch tweet"],
                  required: true,
                  showInAddForm: true,
                },
                {
                  key: "internalOnly",
                  label: "Internal only",
                  type: "text",
                  required: true,
                  showInAddForm: false,
                },
              ],
            },
          },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);

    const form = await http.get(`/api/pipelines/${pipeline.body.id}/intake-form`).expect(200);
    expect(form.body).toMatchObject({
      pipelineId: pipeline.body.id,
      stageId: pipeline.body.stages[0].id,
      stageName: "Drafting",
      fields: [
        { key: "title", label: "Name", type: "text", required: true },
        { key: "type", label: "Type", type: "select", required: true, options: ["Blog post", "Launch tweet"] },
      ],
    });

    const batch = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases/batch`)
      .send({
        items: [
          { title: "Launch blog post", fields: { type: "Blog post" } },
          { title: "Launch tweet", fields: {} },
        ],
      })
      .expect(200);

    expect(batch.body[0].ok).toBe(true);
    expect(batch.body[1]).toMatchObject({
      ok: false,
      error: {
        status: 422,
        details: { code: "required_field", fieldKey: "type", label: "Type" },
      },
    });
  });

  it("derives intake-form fields from routine-shaped stage variables", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "routine-vars",
        name: "Routine vars",
        stages: [
          {
            key: "drafting",
            name: "Drafting",
            kind: "open",
            position: 100,
            config: {
              // Routine variable shape — synced from `{{name}}` body placeholders,
              // no `showInAddForm`: every variable becomes an Add-item field.
              variables: [
                { name: "topic", label: "Topic", type: "text", required: true, options: [], defaultValue: null },
                { name: "channel", label: "Channel", type: "select", required: false, options: ["Blog", "Email"], defaultValue: null },
                { name: "brief", label: null, type: "textarea", required: false, options: [], defaultValue: null },
              ],
            },
          },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);

    const form = await http.get(`/api/pipelines/${pipeline.body.id}/intake-form`).expect(200);
    expect(form.body.fields).toEqual([
      { key: "title", label: "Name", type: "text", required: true, options: [] },
      { key: "topic", label: "Topic", type: "text", required: true, options: [] },
      { key: "channel", label: "Channel", type: "select", required: false, options: ["Blog", "Email"] },
      // textarea maps to multiline; missing label falls back to the variable name.
      { key: "brief", label: "brief", type: "multiline", required: false, options: [] },
    ]);
  });

  it("breaks a case into pieces and exposes child outcomes in the parent context pack", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const target = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "route-pieces",
        name: "Route Pieces",
        stages: [
          {
            key: "intake",
            name: "Intake",
            kind: "open",
            position: 100,
            config: {
              variables: [
                { name: "risk", label: "Risk", type: "select", options: ["low", "high"], required: true },
              ],
            },
          },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const source = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "route-source",
        name: "Route Source",
        stages: [
          {
            key: "planning",
            name: "Planning",
            kind: "open",
            position: 100,
            config: {
              breakdown: {
                targetPipelineId: target.body.id,
                targetStageKey: "intake",
                pieceNoun: "piece",
                inheritFields: ["release"],
                advanceTo: "waiting",
                waitForPieces: false,
                whenFinishedMoveTo: "done",
              },
            },
          },
          { key: "waiting", name: "Waiting", kind: "working", position: 200, config: { requireChildrenTerminal: true, autoAdvanceOnChildrenTerminal: "done" } },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const parent = await http
      .post(`/api/pipelines/${source.body.id}/cases`)
      .send({ caseKey: "rel", title: "Release", fields: { release: "1.0" } })
      .expect(201);

    const breakdown = await http
      .post(`/api/cases/${parent.body.case.id}/breakdown`)
      .send({ items: [{ key: "docs", title: "Docs", fields: { risk: "low" } }] })
      .expect(200);
    expect(breakdown.body.items[0]).toMatchObject({ ok: true, created: true });
    const childId = breakdown.body.items[0].case.id;
    expect(breakdown.body.items[0].case).toMatchObject({
      parentCaseId: parent.body.case.id,
      requestKey: "piece:docs",
      fields: { release: "1.0", risk: "low" },
    });

    await http.post(`/api/cases/${childId}/transition`).send({ toStageKey: "cancelled", expectedVersion: 1 }).expect(200);

    const pack = await http.get(`/api/cases/${parent.body.case.id}/context-pack`).expect(200);
    expect(pack.body.stage).toMatchObject({ key: "done", kind: "done" });
    expect(pack.body.childOutcomes).toHaveLength(1);
    expect(pack.body.childOutcomes[0]).toMatchObject({
      id: childId,
      title: "Docs",
      status: "terminal",
      terminalKind: "cancelled",
      rejected: true,
    });
  });

  it("stamps and clears pipeline automation routine origins when stage wiring changes", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipeline = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "origin", name: "Origin" }).expect(201);
    const [routine] = await db.insert(routines).values({ companyId: company.id, title: "Pipeline backing routine" }).returning();

    const intakeStage = pipeline.body.stages.find((stage: { key: string }) => stage.key === "intake");
    await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${intakeStage.id}`)
      .send({ config: { onEnter: { type: "run_routine", routineId: routine!.id } } })
      .expect(200);

    let [routineRow] = await db
      .select({ originKind: routines.originKind, originId: routines.originId })
      .from(routines)
      .where(eq(routines.id, routine!.id));
    expect(routineRow).toMatchObject({
      originKind: "pipeline_automation",
      originId: pipeline.body.id,
    });

    const qaStage = await http
      .post(`/api/pipelines/${pipeline.body.id}/stages`)
      .send({
        key: "qa",
        name: "QA",
        kind: "working",
        position: 250,
        config: { onEnter: { type: "run_routine", routineId: routine!.id } },
      })
      .expect(201);

    await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${intakeStage.id}`)
      .send({ config: {} })
      .expect(200);

    [routineRow] = await db
      .select({ originKind: routines.originKind, originId: routines.originId })
      .from(routines)
      .where(eq(routines.id, routine!.id));
    expect(routineRow).toMatchObject({
      originKind: "pipeline_automation",
      originId: pipeline.body.id,
    });

    const secondPipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "origin-two", name: "Origin two" })
      .expect(201);
    const secondIntakeStage = secondPipeline.body.stages.find((stage: { key: string }) => stage.key === "intake");
    await http
      .patch(`/api/pipelines/${secondPipeline.body.id}/stages/${secondIntakeStage.id}`)
      .send({ config: { onEnter: { type: "run_routine", routineId: routine!.id } } })
      .expect(200);

    await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${qaStage.body.id}`)
      .send({ config: {} })
      .expect(200);

    [routineRow] = await db
      .select({ originKind: routines.originKind, originId: routines.originId })
      .from(routines)
      .where(eq(routines.id, routine!.id));
    expect(routineRow).toMatchObject({
      originKind: "pipeline_automation",
      originId: pipeline.body.id,
    });

    await http
      .patch(`/api/pipelines/${secondPipeline.body.id}/stages/${secondIntakeStage.id}`)
      .send({ config: {} })
      .expect(200);

    [routineRow] = await db
      .select({ originKind: routines.originKind, originId: routines.originId })
      .from(routines)
      .where(eq(routines.id, routine!.id));
    expect(routineRow).toMatchObject({
      originKind: "manual",
      originId: null,
    });

    const [handCuratedRoutine] = await db.insert(routines).values({
      companyId: company.id,
      title: "Hand curated",
      originKind: "plugin:example",
      originId: "plugin-routine",
    }).returning();
    await http
      .post(`/api/pipelines/${pipeline.body.id}/stages`)
      .send({
        key: "custom",
        name: "Custom",
        kind: "working",
        position: 275,
        config: { onEnter: { type: "run_routine", routineId: handCuratedRoutine!.id } },
      })
      .expect(201);

    const [handCuratedRow] = await db
      .select({ originKind: routines.originKind, originId: routines.originId })
      .from(routines)
      .where(eq(routines.id, handCuratedRoutine!.id));
    expect(handCuratedRow).toMatchObject({
      originKind: "plugin:example",
      originId: "plugin-routine",
    });

    const actions = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId })
      .from(activityLog)
      .where(eq(activityLog.companyId, company.id));
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "routine.origin_stamped", entityId: routine!.id }),
      expect.objectContaining({ action: "routine.origin_cleared", entityId: routine!.id }),
    ]));
  });

  it("materializes, syncs, and unwires stage automation routines from stage settings", async () => {
    const company = await seedCompany();
    const [firstAgent, secondAgent] = await db.insert(agents).values([
      { companyId: company.id, name: "Draft Agent", role: "writer", status: "idle" },
      { companyId: company.id, name: "QA Agent", role: "reviewer", status: "idle" },
    ]).returning();
    const http = request(app(boardActor));
    const pipeline = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "automation", name: "Automation" }).expect(201);
    const stage = pipeline.body.stages.find((item: { key: string }) => item.key === "in_progress");

    const created = await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${stage.id}`)
      .send({
        config: {
          assigneeAgentId: firstAgent!.id,
          automation: {
            assigneeAgentId: firstAgent!.id,
            instructionsBody: "Draft the item.",
          },
        },
      })
      .expect(200);

    expect(created.body.config).toMatchObject({
      onEnter: { type: "run_routine", routineId: expect.any(String) },
    });
    expect(created.body.config).not.toHaveProperty("automation");
    expect(created.body.config).not.toHaveProperty("assigneeAgentId");
    const routineId = created.body.config.onEnter.routineId;

    let [routine] = await db.select().from(routines).where(eq(routines.id, routineId));
    expect(routine).toMatchObject({
      companyId: company.id,
      assigneeAgentId: firstAgent!.id,
      description: "Draft the item.",
      originKind: "pipeline_automation",
      originId: pipeline.body.id,
      latestRevisionNumber: 1,
    });
    let [revision] = await db.select().from(routineRevisions).where(eq(routineRevisions.routineId, routineId));
    expect(revision!.snapshot).toMatchObject({
      routine: {
        assigneeAgentId: firstAgent!.id,
        description: "Draft the item.",
      },
    });

    const detail = await http.get(`/api/pipelines/${pipeline.body.id}`).expect(200);
    const detailStage = detail.body.stages.find((item: { id: string }) => item.id === stage.id);
    expect(detailStage.config.automation).toMatchObject({
      routineId,
      assigneeAgentId: firstAgent!.id,
      instructionsBody: "Draft the item.",
      env: null,
      latestRoutineRevisionId: routine!.latestRevisionId,
      latestRoutineRevisionNumber: 1,
    });

    const synced = await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${stage.id}`)
      .send({
        config: {
          ...detailStage.config,
          automation: {
            assigneeAgentId: secondAgent!.id,
            instructionsBody: "Review the item.",
          },
        },
      })
      .expect(200);
    expect(synced.body.config.onEnter.routineId).toBe(routineId);
    [routine] = await db.select().from(routines).where(eq(routines.id, routineId));
    expect(routine).toMatchObject({
      assigneeAgentId: secondAgent!.id,
      description: "Review the item.",
      latestRevisionNumber: 2,
    });

    const reconciled = await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${stage.id}`)
      .send({
        config: {
          ...synced.body.config,
          variables: [
            {
              name: "old_topic",
              label: "Topic",
              type: "select",
              defaultValue: "urgent",
              required: false,
              options: ["urgent", "later"],
            },
            {
              name: "ne",
              label: "Intermediate",
              type: "text",
              defaultValue: null,
              required: true,
              options: [],
            },
            {
              name: "customer",
              label: "Customer",
              type: "text",
              defaultValue: null,
              required: true,
              options: [],
              source: "manual",
            },
          ],
          automation: {
            assigneeAgentId: secondAgent!.id,
            instructionsBody: "Review {{new_topic}}.",
          },
        },
      })
      .expect(200);
    expect(reconciled.body.config.variables.map((variable: { name: string }) => variable.name)).toEqual([
      "new_topic",
      "customer",
    ]);
    expect(JSON.stringify(reconciled.body.config.variables)).not.toContain("source");

    const [stageAfterReconcile] = await db.select().from(pipelineStages).where(eq(pipelineStages.id, stage.id));
    expect((stageAfterReconcile!.config as { variables: Array<{ name: string }> }).variables.map((variable) => variable.name)).toEqual([
      "new_topic",
      "customer",
    ]);
    [routine] = await db.select().from(routines).where(eq(routines.id, routineId));
    expect(routine!.variables.map((variable) => variable.name)).toEqual(["new_topic"]);

    const unwired = await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${stage.id}`)
      .send({
        config: {
          ...synced.body.config,
          automation: {
            assigneeAgentId: null,
            instructionsBody: "Review the item.",
          },
        },
      })
      .expect(200);
    expect(unwired.body.config).not.toHaveProperty("onEnter");
    expect(unwired.body.config).not.toHaveProperty("automation");
    [routine] = await db.select().from(routines).where(eq(routines.id, routineId));
    expect(routine).toMatchObject({
      originKind: "manual",
      originId: null,
    });
  });

  it("saves stage automation env on the backing routine and syncs secret bindings", async () => {
    const company = await seedCompany();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Stage Agent",
      role: "worker",
      status: "idle",
    }).returning();
    const [secret] = await db.insert(companySecrets).values({
      companyId: company.id,
      key: "github_token",
      name: "GitHub token",
    }).returning();
    const http = request(app(boardActor));
    const pipeline = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "stage-env", name: "Stage env" }).expect(201);
    const stage = pipeline.body.stages.find((item: { key: string }) => item.key === "in_progress");
    const created = await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${stage.id}`)
      .send({
        config: {
          automation: {
            assigneeAgentId: agent!.id,
            instructionsBody: "Use the env.",
          },
        },
      })
      .expect(200);
    const routineId = created.body.config.onEnter.routineId;
    const [before] = await db.select().from(routines).where(eq(routines.id, routineId));

    const saved = await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${stage.id}/automation-env`)
      .send({
        baseRoutineRevisionId: before!.latestRevisionId,
        env: {
          GH_TOKEN: { type: "secret_ref", secretId: secret!.id, version: "latest" },
          NODE_ENV: { type: "plain", value: "production" },
        },
      })
      .expect(200);

    expect(saved.body).toMatchObject({
      routineId,
      assigneeAgentId: agent!.id,
      instructionsBody: "Use the env.",
      env: {
        GH_TOKEN: { type: "secret_ref", secretId: secret!.id, version: "latest" },
        NODE_ENV: { type: "plain", value: "production" },
      },
      latestRoutineRevisionNumber: 2,
    });
    expect(saved.body.latestRoutineRevisionId).not.toBe(before!.latestRevisionId);

    const [routine] = await db.select().from(routines).where(eq(routines.id, routineId));
    expect(routine!.env).toEqual(saved.body.env);
    expect(routine!.latestRevisionNumber).toBe(2);
    const revisions = await db.select().from(routineRevisions).where(eq(routineRevisions.routineId, routineId));
    expect(revisions).toHaveLength(2);
    expect(revisions.find((revision) => revision.id === routine!.latestRevisionId)!.snapshot).toMatchObject({
      routine: { env: saved.body.env },
    });
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, routineId));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      companyId: company.id,
      secretId: secret!.id,
      targetType: "routine",
      configPath: "env.GH_TOKEN",
      versionSelector: "latest",
    });
    const [stageAfter] = await db.select().from(pipelineStages).where(eq(pipelineStages.id, stage.id));
    expect(stageAfter!.config).toMatchObject({ onEnter: { type: "run_routine", routineId } });
    expect(stageAfter!.config).not.toHaveProperty("automation");
    expect(JSON.stringify(stageAfter!.config)).not.toContain(secret!.id);

    const detail = await http.get(`/api/pipelines/${pipeline.body.id}`).expect(200);
    const detailStage = detail.body.stages.find((item: { id: string }) => item.id === stage.id);
    expect(detailStage.config.automation).toMatchObject(saved.body);

    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, stage.id));
    const event = events.find((item) => item.action === "pipeline.stage_automation_env_updated");
    expect(event!.details).toMatchObject({
      envKeys: ["GH_TOKEN", "NODE_ENV"],
      bindingRefKeys: ["GH_TOKEN"],
      bindingRefIds: [secret!.id],
      bindingRefCount: 1,
    });
    expect(JSON.stringify(event!.details)).not.toContain("production");
  });

  it("rejects stale stage automation env saves", async () => {
    const company = await seedCompany();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Stage Agent",
      role: "worker",
      status: "idle",
    }).returning();
    const http = request(app(boardActor));
    const pipeline = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "stale-env", name: "Stale env" }).expect(201);
    const stage = pipeline.body.stages.find((item: { key: string }) => item.key === "in_progress");
    await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${stage.id}`)
      .send({ config: { automation: { assigneeAgentId: agent!.id, instructionsBody: "Use env." } } })
      .expect(200);

    await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${stage.id}/automation-env`)
      .send({
        baseRoutineRevisionId: randomUUID(),
        env: { SAFE_VALUE: { type: "plain", value: "ok" } },
      })
      .expect(409);
  });

  it("requires stage automation and an assignee before saving stage automation env", async () => {
    const company = await seedCompany();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Stage Agent",
      role: "worker",
      status: "idle",
    }).returning();
    const http = request(app(boardActor));
    const pipeline = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "needs-automation", name: "Needs automation" }).expect(201);
    const stage = pipeline.body.stages.find((item: { key: string }) => item.key === "in_progress");

    await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${stage.id}/automation-env`)
      .send({ env: { SAFE_VALUE: { type: "plain", value: "ok" } } })
      .expect(422);

    const created = await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${stage.id}`)
      .send({ config: { automation: { assigneeAgentId: agent!.id, instructionsBody: "Use env." } } })
      .expect(200);
    const routineId = created.body.config.onEnter.routineId;
    await db.update(routines).set({ assigneeAgentId: null }).where(eq(routines.id, routineId));

    await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${stage.id}/automation-env`)
      .send({ env: { SAFE_VALUE: { type: "plain", value: "ok" } } })
      .expect(422);
  });

  it("applies strict-mode env validation to stage automation env saves", async () => {
    const previous = process.env.PAPERCLIP_SECRETS_STRICT_MODE;
    process.env.PAPERCLIP_SECRETS_STRICT_MODE = "true";
    try {
      const company = await seedCompany();
      const [agent] = await db.insert(agents).values({
        companyId: company.id,
        name: "Stage Agent",
        role: "worker",
        status: "idle",
      }).returning();
      const http = request(app(boardActor));
      const pipeline = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "strict-env", name: "Strict env" }).expect(201);
      const stage = pipeline.body.stages.find((item: { key: string }) => item.key === "in_progress");
      await http
        .patch(`/api/pipelines/${pipeline.body.id}/stages/${stage.id}`)
        .send({ config: { automation: { assigneeAgentId: agent!.id, instructionsBody: "Use env." } } })
        .expect(200);

      await http
        .patch(`/api/pipelines/${pipeline.body.id}/stages/${stage.id}/automation-env`)
        .send({ env: { ACCESS_TOKEN: { type: "plain", value: "not-secret-backed" } } })
        .expect(422);
    } finally {
      if (previous === undefined) {
        delete process.env.PAPERCLIP_SECRETS_STRICT_MODE;
      } else {
        process.env.PAPERCLIP_SECRETS_STRICT_MODE = previous;
      }
    }
  });

  it("rejects reserved Paperclip env keys during stage automation env saves", async () => {
    const company = await seedCompany();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Stage Agent",
      role: "worker",
      status: "idle",
    }).returning();
    const http = request(app(boardActor));
    const pipeline = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "reserved-env", name: "Reserved env" }).expect(201);
    const stage = pipeline.body.stages.find((item: { key: string }) => item.key === "in_progress");
    const configured = await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${stage.id}`)
      .send({ config: { automation: { assigneeAgentId: agent!.id, instructionsBody: "Use env." } } })
      .expect(200);
    const routineId = configured.body.config.onEnter.routineId as string;

    await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${stage.id}/automation-env`)
      .send({ env: { SAFE_VALUE: { type: "plain", value: "ok" } } })
      .expect(200);

    const rejected = await http
      .patch(`/api/pipelines/${pipeline.body.id}/stages/${stage.id}/automation-env`)
      .send({
        env: {
          PAPERCLIP_API_KEY: { type: "plain", value: "should-not-persist" },
          SAFE_VALUE: { type: "plain", value: "updated" },
        },
      })
      .expect(422);

    expect(rejected.body.error).toContain("PAPERCLIP_API_KEY");
    expect(rejected.body).toMatchObject({
      code: "reserved_env_key",
      details: { key: "PAPERCLIP_API_KEY" },
    });

    const [routine] = await db
      .select({ env: routines.env })
      .from(routines)
      .where(eq(routines.id, routineId));
    expect(routine?.env).toEqual({ SAFE_VALUE: { type: "plain", value: "ok" } });
    expect(JSON.stringify(routine?.env)).not.toContain("PAPERCLIP_API_KEY");
    expect(JSON.stringify(routine?.env)).not.toContain("should-not-persist");

    const detail = await http.get(`/api/pipelines/${pipeline.body.id}`).expect(200);
    const detailStage = detail.body.stages.find((item: { id: string }) => item.id === stage.id);
    expect(detailStage.config.automation.env).toEqual({ SAFE_VALUE: { type: "plain", value: "ok" } });
    expect(JSON.stringify(detailStage.config.automation.env)).not.toContain("PAPERCLIP_API_KEY");
    expect(JSON.stringify(detailStage.config.automation.env)).not.toContain("should-not-persist");
  });

  it("writes an audit event when an agent removes a case issue link", async () => {
    const company = await seedCompany();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Pipeline Agent",
      role: "engineer",
      adapterType: "codex_local",
    }).returning();
    await grantAgentPipelineWrite(company.id, agent!.id);
    const runId = randomUUID();
    const agentActor: Express.Request["actor"] = {
      type: "agent",
      agentId: agent!.id,
      companyId: company.id,
      runId,
      source: "agent_key",
    };
    const http = request(app(agentActor));
    const pipeline = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "unlink", name: "Unlink audit" }).expect(201);
    const created = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "unlink", title: "Unlink audit" })
      .expect(201);
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Linked work",
      status: "todo",
      priority: "medium",
    }).returning();

    const link = await http
      .post(`/api/cases/${created.body.case.id}/issue-links`)
      .send({ issueId: issue!.id, role: "work" })
      .expect(201);
    await http.delete(`/api/cases/${created.body.case.id}/issue-links/${link.body.id}`).expect(200);

    const events = await http.get(`/api/cases/${created.body.case.id}/events`).expect(200);
    const linkEvents = events.body.items.filter((event: { type: string }) => event.type === "issue_linked" || event.type === "issue_unlinked");
    expect(linkEvents.map((event: { type: string }) => event.type)).toEqual(["issue_linked", "issue_unlinked"]);
    expect(linkEvents[1]).toMatchObject({
      actorType: "agent",
      actorAgentId: agent!.id,
      runId,
      payload: { issueId: issue!.id, role: "work", linkId: link.body.id },
    });
    const remainingLinks = await db.select().from(pipelineCaseIssueLinks).where(eq(pipelineCaseIssueLinks.id, link.body.id));
    expect(remainingLinks).toHaveLength(0);
  });

  it("paginates and caps case event responses", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipeline = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "event-cap", name: "Event cap" }).expect(201);
    const created = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "event-cap", title: "Event cap" })
      .expect(201);
    const caseId = created.body.case.id as string;
    const baseTime = Date.now() + 1_000;

    await db.insert(pipelineCaseEvents).values(
      Array.from({ length: PIPELINE_CASE_EVENTS_MAX_LIMIT + 25 }, (_, index) => ({
        companyId: company.id,
        caseId,
        type: "updated",
        actorType: "user",
        actorUserId: "board-user",
        payload: { index },
        createdAt: new Date(baseTime + index),
        updatedAt: new Date(baseTime + index),
      })),
    );

    const firstPage = await http
      .get(`/api/cases/${caseId}/events?limit=${PIPELINE_CASE_EVENTS_MAX_LIMIT + 50}`)
      .expect(200);
    expect(firstPage.body.items).toHaveLength(PIPELINE_CASE_EVENTS_MAX_LIMIT);
    expect(firstPage.body.pagination).toMatchObject({
      limit: PIPELINE_CASE_EVENTS_MAX_LIMIT,
      offset: 0,
      nextOffset: PIPELINE_CASE_EVENTS_MAX_LIMIT,
      hasMore: true,
      order: "asc",
    });

    const secondPage = await http
      .get(`/api/cases/${caseId}/events?limit=10&offset=${PIPELINE_CASE_EVENTS_MAX_LIMIT}`)
      .expect(200);
    expect(secondPage.body.items).toHaveLength(10);
    expect(secondPage.body.pagination).toMatchObject({
      limit: 10,
      offset: PIPELINE_CASE_EVENTS_MAX_LIMIT,
      nextOffset: PIPELINE_CASE_EVENTS_MAX_LIMIT + 10,
      hasMore: true,
      order: "asc",
    });
  });

  it("returns a bounded context-pack event tail for large histories", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipeline = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "context-tail", name: "Context tail" }).expect(201);
    const created = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "context-tail", title: "Context tail" })
      .expect(201);
    const caseId = created.body.case.id as string;
    const eventCount = PIPELINE_CONTEXT_PACK_EVENT_LIMIT + 12;
    const baseTime = Date.now() + 1_000;

    await db.insert(pipelineCaseEvents).values(
      Array.from({ length: eventCount }, (_, index) => ({
        companyId: company.id,
        caseId,
        type: "updated",
        actorType: "user",
        actorUserId: "board-user",
        payload: { index },
        createdAt: new Date(baseTime + index),
        updatedAt: new Date(baseTime + index),
      })),
    );

    const pack = await http.get(`/api/cases/${caseId}/context-pack`).expect(200);
    expect(pack.body.events).toHaveLength(PIPELINE_CONTEXT_PACK_EVENT_LIMIT);
    expect(pack.body.events.map((event: { payload: { index: number } }) => event.payload.index)).toEqual(
      Array.from(
        { length: PIPELINE_CONTEXT_PACK_EVENT_LIMIT },
        (_, index) => eventCount - PIPELINE_CONTEXT_PACK_EVENT_LIMIT + index,
      ),
    );
  });

  it("returns 404 for cross-company pipeline route classes", async () => {
    const company = await seedCompany();
    const ownerHttp = request(app(boardActor));
    const pipeline = await ownerHttp
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "cross-company",
        name: "Cross-company",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          {
            key: "review",
            name: "Review",
            kind: "review",
            position: 200,
            config: {
              approveToStageKey: "done",
              rejectToStageKey: "cancelled",
              requireApproval: true,
              approver: { kind: "any_human" },
            },
          },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    await ownerHttp.put(`/api/pipelines/${pipeline.body.id}/documents/guidance`).send({ body: "Use the rubric." }).expect(200);
    const createdCase = await ownerHttp
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "cross-company", title: "Cross-company case" })
      .expect(201);
    const caseId = createdCase.body.case.id as string;
    await ownerHttp.post(`/api/cases/${caseId}/transition`).send({ toStageKey: "review", expectedVersion: 1 }).expect(200);
    const [manualIssue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Manual work issue",
      status: "todo",
      priority: "medium",
    }).returning();
    const issueLink = await ownerHttp
      .post(`/api/cases/${caseId}/issue-links`)
      .send({ issueId: manualIssue!.id, role: "work" })
      .expect(201);
    const [routine] = await db.insert(routines).values({ companyId: company.id, title: "Routine" }).returning();
    await db.insert(pipelineAutomationExecutions).values({
      companyId: company.id,
      caseId,
      automationId: "retry-me",
      triggeringEventId: randomUUID(),
      routineId: routine!.id,
      status: "failed",
      error: "boom",
    });
    const otherAgent: Express.Request["actor"] = {
      type: "agent",
      agentId: randomUUID(),
      companyId: randomUUID(),
      runId: randomUUID(),
      source: "agent_key",
    };
    const wrongCompanyHttp = request(app(otherAgent));
    const routes = [
      { name: "pipeline detail", method: "get", path: `/api/pipelines/${pipeline.body.id}` },
      { name: "case detail", method: "get", path: `/api/cases/${caseId}` },
      { name: "review inbox", method: "get", path: `/api/companies/${company.id}/review-cases` },
      {
        name: "review bulk mutation",
        method: "post",
        path: `/api/companies/${company.id}/review-cases/bulk`,
        body: { items: [{ caseId, decision: "approve", expectedVersion: 2 }] },
      },
      {
        name: "review detail mutation",
        method: "post",
        path: `/api/cases/${caseId}/review`,
        body: { decision: "approve", expectedVersion: 2 },
      },
      { name: "document read", method: "get", path: `/api/pipelines/${pipeline.body.id}/documents/guidance` },
      {
        name: "document write",
        method: "put",
        path: `/api/pipelines/${pipeline.body.id}/documents/guidance`,
        body: { body: "wrong-company update" },
      },
      {
        name: "issue-link create mutation",
        method: "post",
        path: `/api/cases/${caseId}/issue-links`,
        body: { issueId: manualIssue!.id, role: "work" },
      },
      {
        name: "issue-link delete mutation",
        method: "delete",
        path: `/api/cases/${caseId}/issue-links/${issueLink.body.id}`,
      },
      {
        name: "automation retry mutation",
        method: "post",
        path: `/api/cases/${caseId}/automations/retry-me/retry`,
      },
      { name: "case events", method: "get", path: `/api/cases/${caseId}/events` },
      { name: "case rollup", method: "get", path: `/api/cases/${caseId}/rollup` },
      { name: "case context-pack", method: "get", path: `/api/cases/${caseId}/context-pack` },
    ] as const;

    for (const route of routes) {
      let requestBuilder = wrongCompanyHttp[route.method](route.path);
      if ("body" in route) requestBuilder = requestBuilder.send(route.body);
      const res = await requestBuilder;
      expect(res.status, route.name).toBe(404);
    }
  });

  it("rejects agent mutations without a run id", async () => {
    const company = await seedCompany();
    const agentActor: Express.Request["actor"] = {
      type: "agent",
      agentId: randomUUID(),
      companyId: company.id,
      source: "agent_key",
    };

    const res = await request(app(agentActor))
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "agent", name: "Agent pipeline" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("run_id_required");
  });

  it("requires explicit target pipeline write permission for stage rewrites, direct ingest, and breakdown fanout", async () => {
    const company = await seedCompany();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Pipeline Agent",
      role: "engineer",
      status: "idle",
    }).returning();
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent!.id,
      status: "active",
      membershipRole: "member",
    });
    const http = request(app(boardActor));
    const target = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "unauthorized-target",
        name: "Unauthorized Target",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const source = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "authorized-source",
        name: "Authorized Source",
        stages: [
          {
            key: "planning",
            name: "Planning",
            kind: "open",
            position: 100,
            config: {
              breakdown: {
                targetPipelineId: target.body.id,
                targetStageKey: "intake",
                pieceNoun: "piece",
              },
            },
          },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    await grantAgentPipelineWrite(company.id, agent!.id, { pipelineId: source.body.id });

    const agentActor: Express.Request["actor"] = {
      type: "agent",
      agentId: agent!.id,
      companyId: company.id,
      runId: randomUUID(),
      source: "agent_key",
    };
    const agentHttp = request(app(agentActor));
    const planningStage = source.body.stages.find((stage: { key: string }) => stage.key === "planning");

    await agentHttp
      .patch(`/api/pipelines/${target.body.id}/stages/${target.body.stages[0].id}`)
      .send({ config: { breakdown: { targetPipelineId: source.body.id, targetStageKey: "planning" } } })
      .expect(403);

    await agentHttp
      .patch(`/api/pipelines/${source.body.id}/stages/${planningStage.id}`)
      .send({ name: "Planning updated by scoped grant" })
      .expect(200);

    await agentHttp
      .post(`/api/pipelines/${target.body.id}/cases`)
      .send({ caseKey: "direct", title: "Direct target write" })
      .expect(403)
      .expect((res) => {
        expect(res.body.code).toBe("pipeline_write_forbidden");
      });

    const parent = await http
      .post(`/api/pipelines/${source.body.id}/cases`)
      .send({ caseKey: "parent", title: "Parent" })
      .expect(201);
    await agentHttp
      .post(`/api/cases/${parent.body.case.id}/breakdown`)
      .send({ items: [{ key: "child", title: "Child" }] })
      .expect(403)
      .expect((res) => {
        expect(res.body.code).toBe("pipeline_write_forbidden");
        expect(res.body.details.pipelineId).toBe(target.body.id);
      });

    const targetCases = await http.get(`/api/pipelines/${target.body.id}/cases`).expect(200);
    expect(targetCases.body).toHaveLength(0);
  });

  it("blocks pipeline breakdown automation when the routine assignee lacks target pipeline write permission, then recovers after grant", async () => {
    const company = await seedCompany();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Breakdown Bot",
      role: "engineer",
      status: "idle",
    }).returning();
    const [routine] = await db.insert(routines).values({
      companyId: company.id,
      title: "Break down item",
      description: "Create target work.",
      assigneeAgentId: agent!.id,
    }).returning();
    const http = request(app(boardActor));
    const target = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "preflight-target", name: "Preflight Target" })
      .expect(201);
    const source = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "preflight-source",
        name: "Preflight Source",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          {
            key: "breakdown",
            name: "Breakdown",
            kind: "working",
            position: 200,
            config: {
              onEnter: { type: "run_routine", routineId: routine!.id },
              breakdown: {
                targetPipelineId: target.body.id,
                targetStageKey: "intake",
                pieceNoun: "piece",
                waitForPieces: false,
              },
            },
          },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const parent = await http
      .post(`/api/pipelines/${source.body.id}/cases`)
      .send({ caseKey: "parent", title: "Parent" })
      .expect(201);

    await http
      .post(`/api/cases/${parent.body.case.id}/transition`)
      .send({ toStageKey: "breakdown", expectedVersion: 1 })
      .expect(200);

    const [failedLedger] = await db
      .select()
      .from(pipelineAutomationExecutions)
      .where(eq(pipelineAutomationExecutions.caseId, parent.body.case.id));
    expect(failedLedger).toMatchObject({
      status: "failed",
      executionIssueId: null,
    });
    expect(failedLedger!.error).toMatch(/^permission_preflight_failed:/);
    const failureEvents = await db
      .select()
      .from(pipelineCaseEvents)
      .where(eq(pipelineCaseEvents.caseId, parent.body.case.id));
    expect(failureEvents.filter((event) => event.type === "automation_failed")).toHaveLength(1);
    const routineRunsBeforeGrant = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine!.id));
    expect(routineRunsBeforeGrant).toHaveLength(0);

    const blockedDetail = await http.get(`/api/cases/${parent.body.case.id}`).expect(200);
    expect(blockedDetail.body.liveness).toMatchObject({
      state: "blocked",
      reason: "permission_preflight_failed",
    });

    await http
      .post(`/api/cases/${parent.body.case.id}/automations/${failedLedger!.automationId}/retry`)
      .expect(200);
    const stillFailureEvents = await db
      .select()
      .from(pipelineCaseEvents)
      .where(eq(pipelineCaseEvents.caseId, parent.body.case.id));
    expect(stillFailureEvents.filter((event) => event.type === "automation_failed")).toHaveLength(1);

    await grantAgentPipelineWrite(company.id, agent!.id, { pipelineId: target.body.id });
    const revalidatedDetail = await http.get(`/api/cases/${parent.body.case.id}`).expect(200);
    expect(revalidatedDetail.body.liveness).toMatchObject({
      state: "attention",
      reason: "automation_failed",
      message: "Pipeline automation permission has been restored; retry the failed automation ledger.",
    });
    const retried = await http
      .post(`/api/cases/${parent.body.case.id}/automations/${failedLedger!.automationId}/retry`)
      .expect(200);
    expect(retried.body).toMatchObject({
      status: "succeeded",
      execution: { executionIssueId: expect.any(String) },
    });
    const linkedAutomationIssues = await db
      .select()
      .from(pipelineCaseIssueLinks)
      .where(eq(pipelineCaseIssueLinks.caseId, parent.body.case.id));
    expect(linkedAutomationIssues.filter((link) => link.role === "automation")).toHaveLength(1);
    const routineRunsAfterGrant = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine!.id));
    expect(routineRunsAfterGrant).toHaveLength(1);
  });

  it("rejects automation retry from a same-company agent that lacks target pipeline write permission", async () => {
    const company = await seedCompany();
    const [assigneeAgent, callerAgent] = await db.insert(agents).values([
      {
        companyId: company.id,
        name: "Breakdown Bot",
        role: "engineer",
        status: "idle",
      },
      {
        companyId: company.id,
        name: "Curious Coworker",
        role: "engineer",
        status: "idle",
      },
    ]).returning();
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "agent",
      principalId: callerAgent!.id,
      status: "active",
      membershipRole: "member",
    });
    const [routine] = await db.insert(routines).values({
      companyId: company.id,
      title: "Break down item",
      description: "Create target work.",
      assigneeAgentId: assigneeAgent!.id,
    }).returning();
    const http = request(app(boardActor));
    const target = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "retry-target", name: "Retry Target" })
      .expect(201);
    const source = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "retry-source",
        name: "Retry Source",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          {
            key: "breakdown",
            name: "Breakdown",
            kind: "working",
            position: 200,
            config: {
              onEnter: { type: "run_routine", routineId: routine!.id },
              breakdown: {
                targetPipelineId: target.body.id,
                targetStageKey: "intake",
                pieceNoun: "piece",
                waitForPieces: false,
              },
            },
          },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const parent = await http
      .post(`/api/pipelines/${source.body.id}/cases`)
      .send({ caseKey: "parent", title: "Parent" })
      .expect(201);

    await http
      .post(`/api/cases/${parent.body.case.id}/transition`)
      .send({ toStageKey: "breakdown", expectedVersion: 1 })
      .expect(200);

    const [failedLedger] = await db
      .select()
      .from(pipelineAutomationExecutions)
      .where(eq(pipelineAutomationExecutions.caseId, parent.body.case.id));
    expect(failedLedger!.error).toMatch(/^permission_preflight_failed:/);

    await grantAgentPipelineWrite(company.id, assigneeAgent!.id, { pipelineId: target.body.id });

    const callerActor: Express.Request["actor"] = {
      type: "agent",
      agentId: callerAgent!.id,
      companyId: company.id,
      runId: randomUUID(),
      source: "agent_key",
    };
    await request(app(callerActor))
      .post(`/api/cases/${parent.body.case.id}/automations/${failedLedger!.automationId}/retry`)
      .expect(403)
      .expect((res) => {
        expect(res.body.code).toBe("pipeline_write_forbidden");
        expect(res.body.details.pipelineId).toBe(target.body.id);
      });

    const routineRunsAfterDeniedRetry = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine!.id));
    expect(routineRunsAfterDeniedRetry).toHaveLength(0);
  });

  it("rejects current-stage automation reruns from a same-company agent that lacks target pipeline write permission", async () => {
    const company = await seedCompany();
    const [assigneeAgent, callerAgent] = await db.insert(agents).values([
      {
        companyId: company.id,
        name: "Breakdown Bot",
        role: "engineer",
        status: "idle",
      },
      {
        companyId: company.id,
        name: "Curious Coworker",
        role: "engineer",
        status: "idle",
      },
    ]).returning();
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "agent",
      principalId: callerAgent!.id,
      status: "active",
      membershipRole: "member",
    });
    const [routine] = await db.insert(routines).values({
      companyId: company.id,
      title: "Break down item",
      description: "Create target work.",
      assigneeAgentId: assigneeAgent!.id,
    }).returning();
    const http = request(app(boardActor));
    const target = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "rerun-target", name: "Rerun Target" })
      .expect(201);
    const source = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "rerun-source",
        name: "Rerun Source",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          {
            key: "breakdown",
            name: "Breakdown",
            kind: "working",
            position: 200,
            config: {
              onEnter: { type: "run_routine", routineId: routine!.id },
              breakdown: {
                targetPipelineId: target.body.id,
                targetStageKey: "intake",
                pieceNoun: "piece",
                waitForPieces: false,
              },
            },
          },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    await grantAgentPipelineWrite(company.id, assigneeAgent!.id, { pipelineId: target.body.id });
    const parent = await http
      .post(`/api/pipelines/${source.body.id}/cases`)
      .send({ caseKey: "parent", title: "Parent" })
      .expect(201);

    await http
      .post(`/api/cases/${parent.body.case.id}/transition`)
      .send({ toStageKey: "breakdown", expectedVersion: 1 })
      .expect(200);

    const routineRunsBeforeDeniedRerun = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine!.id));
    expect(routineRunsBeforeDeniedRerun).toHaveLength(1);

    const callerActor: Express.Request["actor"] = {
      type: "agent",
      agentId: callerAgent!.id,
      companyId: company.id,
      runId: randomUUID(),
      source: "agent_key",
    };
    await request(app(callerActor))
      .post(`/api/cases/${parent.body.case.id}/automation/current-stage/rerun`)
      .expect(403)
      .expect((res) => {
        expect(res.body.code).toBe("pipeline_write_forbidden");
        expect(res.body.details.pipelineId).toBe(target.body.id);
      });

    const routineRunsAfterDeniedRerun = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine!.id));
    expect(routineRunsAfterDeniedRerun).toHaveLength(1);
  });

  it("reuses breakdown children by request key when automation retries after recovery", async () => {
    const company = await seedCompany();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Fanout Bot",
      role: "engineer",
      status: "idle",
    }).returning();
    await grantAgentPipelineWrite(company.id, agent!.id);
    const http = request(app(boardActor));
    const target = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "dedupe-target", name: "Dedupe Target" })
      .expect(201);
    const source = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "dedupe-source",
        name: "Dedupe Source",
        stages: [
          {
            key: "breakdown",
            name: "Breakdown",
            kind: "open",
            position: 100,
            config: {
              breakdown: {
                targetPipelineId: target.body.id,
                targetStageKey: "intake",
                pieceNoun: "piece",
                waitForPieces: true,
              },
            },
          },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const parent = await http
      .post(`/api/pipelines/${source.body.id}/cases`)
      .send({ caseKey: "parent", title: "Parent" })
      .expect(201);
    const agentActor: Express.Request["actor"] = {
      type: "agent",
      agentId: agent!.id,
      companyId: company.id,
      runId: randomUUID(),
      source: "agent_key",
    };
    const agentHttp = request(app(agentActor));

    const first = await agentHttp
      .post(`/api/cases/${parent.body.case.id}/breakdown`)
      .send({ items: [{ key: "api", title: "API" }] })
      .expect(200);
    const retry = await agentHttp
      .post(`/api/cases/${parent.body.case.id}/breakdown`)
      .send({ items: [{ key: "api", title: "API duplicate" }] })
      .expect(200);

    expect(first.body.items[0]).toMatchObject({ ok: true, created: true });
    expect(retry.body.items[0]).toMatchObject({
      ok: true,
      created: false,
      case: { id: first.body.items[0].case.id, title: "API" },
    });
    const targetCases = await http.get(`/api/pipelines/${target.body.id}/cases`).expect(200);
    expect(targetCases.body.map((row: { case: { requestKey: string | null } }) => row.case.requestKey)).toEqual(["piece:api"]);
  });

  it("retries the previous automated stage by retiring owned effects and allowing replacement request keys", async () => {
    const company = await seedCompany();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Retry Bot",
      role: "engineer",
      status: "idle",
    }).returning();
    await grantAgentPipelineWrite(company.id, agent!.id);
    const [routine] = await db.insert(routines).values({
      companyId: company.id,
      title: "Retry automation",
      description: "Create children.",
      assigneeAgentId: agent!.id,
    }).returning();
    const http = request(app(boardActor));
    const target = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "retry-child-target", name: "Retry Child Target" })
      .expect(201);
    const source = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "retry-source",
        name: "Retry Source",
        stages: [
          {
            key: "intake",
            name: "Intake",
            kind: "working",
            position: 100,
            config: {
              onEnter: { type: "run_routine", routineId: routine!.id },
              breakdown: {
                targetPipelineId: target.body.id,
                targetStageKey: "intake",
                pieceNoun: "piece",
                waitForPieces: false,
              },
            },
          },
          { key: "covering", name: "Covering", kind: "working", position: 200 },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const parent = await http
      .post(`/api/pipelines/${source.body.id}/cases`)
      .send({ caseKey: "parent", title: "Parent" })
      .expect(201);
    const [firstAttempt] = await db
      .select()
      .from(pipelineAutomationExecutions)
      .where(eq(pipelineAutomationExecutions.caseId, parent.body.case.id));
    expect(firstAttempt?.executionIssueId).toBeTruthy();
    const child = await http
      .post(`/api/pipelines/${target.body.id}/cases`)
      .send({
        caseKey: "child-original",
        title: "Original child",
        parentCaseId: parent.body.case.id,
        requestKey: "piece:api",
      })
      .expect(201);
    await db
      .update(pipelineCases)
      .set({ automationAttemptId: firstAttempt!.id })
      .where(eq(pipelineCases.id, child.body.case.id));
    const parentBeforeCovering = await http.get(`/api/cases/${parent.body.case.id}`).expect(200);
    await http
      .post(`/api/cases/${parent.body.case.id}/transition`)
      .send({ toStageKey: "covering", expectedVersion: parentBeforeCovering.body.case.version })
      .expect(200);

    const plan = await http
      .get(`/api/cases/${parent.body.case.id}/automation/retry-plan`)
      .query({ scope: "previous_stage" })
      .expect(200);
    expect(plan.body).toMatchObject({
      allowed: true,
      scope: "previous_stage",
      targetStage: { key: "intake" },
      effectCounts: { directChildren: 1 },
    });

    const retry = await http
      .post(`/api/cases/${parent.body.case.id}/automation/retry`)
      .send({
        scope: "previous_stage",
        expectedVersion: plan.body.caseVersion,
        cleanup: {
          retireDirectChildren: true,
          retireDescendants: true,
          cancelLinkedAutomationIssues: true,
        },
      })
      .expect(200);
    expect(retry.body.plan.previousAttemptId).toBe(firstAttempt!.id);
    expect(retry.body.retired.caseIds).toContain(child.body.case.id);
    expect(retry.body.automationLedger.retryOfExecutionId).toBe(firstAttempt!.id);

    const [retiredChild] = await db
      .select()
      .from(pipelineCases)
      .where(eq(pipelineCases.id, child.body.case.id));
    expect(retiredChild!.retiredAt).toBeTruthy();
    expect(retiredChild!.hiddenFromBoardAt).toBeTruthy();
    const visibleChildren = await http
      .get(`/api/pipelines/${target.body.id}/cases`)
      .query({ parentCaseId: parent.body.case.id })
      .expect(200);
    expect(visibleChildren.body).toHaveLength(0);

    const replacement = await http
      .post(`/api/pipelines/${target.body.id}/cases`)
      .send({
        caseKey: "child-replacement",
        title: "Replacement child",
        parentCaseId: parent.body.case.id,
        requestKey: "piece:api",
      })
      .expect(201);
    expect(replacement.body.created).toBe(true);
    expect(replacement.body.case.id).not.toBe(child.body.case.id);
  });

  it("blocks automation retry preflight when owned effects have active linked work", async () => {
    const company = await seedCompany();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Retry Bot",
      role: "engineer",
      status: "idle",
    }).returning();
    await grantAgentPipelineWrite(company.id, agent!.id);
    const [routine] = await db.insert(routines).values({
      companyId: company.id,
      title: "Retry automation",
      assigneeAgentId: agent!.id,
    }).returning();
    const http = request(app(boardActor));
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "active-work-retry",
        name: "Active Work Retry",
        stages: [
          {
            key: "intake",
            name: "Intake",
            kind: "working",
            position: 100,
            config: { onEnter: { type: "run_routine", routineId: routine!.id } },
          },
          { key: "covering", name: "Covering", kind: "working", position: 200 },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const parent = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "parent", title: "Parent" })
      .expect(201);
    const [attempt] = await db
      .select()
      .from(pipelineAutomationExecutions)
      .where(eq(pipelineAutomationExecutions.caseId, parent.body.case.id));
    const child = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({
        caseKey: "child-active-work",
        title: "Child with active work",
        parentCaseId: parent.body.case.id,
        requestKey: "piece:active",
      })
      .expect(201);
    await db
      .update(pipelineCases)
      .set({ automationAttemptId: attempt!.id })
      .where(eq(pipelineCases.id, child.body.case.id));
    const [workIssue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Active child work",
      status: "in_progress",
      priority: "medium",
    }).returning();
    await db.insert(pipelineCaseIssueLinks).values({
      companyId: company.id,
      caseId: child.body.case.id,
      issueId: workIssue!.id,
      role: "work",
    });
    const parentBeforeCovering = await http.get(`/api/cases/${parent.body.case.id}`).expect(200);
    await http
      .post(`/api/cases/${parent.body.case.id}/transition`)
      .send({ toStageKey: "covering", expectedVersion: parentBeforeCovering.body.case.version })
      .expect(200);

    const plan = await http
      .get(`/api/cases/${parent.body.case.id}/automation/retry-plan`)
      .query({ scope: "previous_stage" })
      .expect(200);
    expect(plan.body.allowed).toBe(false);
    expect(plan.body.effectCounts.activeDescendants).toBeGreaterThanOrEqual(1);
    const activeDescendantBlocker = plan.body.blockers.find((blocker: { kind: string }) => blocker.kind === "active_descendants");
    expect(activeDescendantBlocker?.issueIds).toEqual(expect.arrayContaining([workIssue!.id]));
    await http
      .post(`/api/cases/${parent.body.case.id}/automation/retry`)
      .send({
        scope: "previous_stage",
        expectedVersion: plan.body.caseVersion,
        cleanup: {
          retireDirectChildren: true,
          retireDescendants: true,
          cancelLinkedAutomationIssues: true,
        },
      })
      .expect(422);
  });

  it("rejects agent exits from human review stages", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipelineRes = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "review-authz",
        name: "Review authz",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          {
            key: "review",
            name: "Review",
            kind: "review",
            position: 200,
            config: {
              approveToStageKey: "done",
              rejectToStageKey: "cancelled",
              requireApproval: true,
              approver: { kind: "any_human" },
            },
          },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const caseRes = await http.post(`/api/pipelines/${pipelineRes.body.id}/cases`).send({ caseKey: "review", title: "Review me" }).expect(201);
    await http.post(`/api/cases/${caseRes.body.case.id}/transition`).send({ toStageKey: "review", expectedVersion: 1 }).expect(200);

    const agentActor: Express.Request["actor"] = {
      type: "agent",
      agentId: randomUUID(),
      companyId: company.id,
      runId: randomUUID(),
      source: "agent_key",
    };
    const res = await request(app(agentActor))
      .post(`/api/cases/${caseRes.body.case.id}/transition`)
      .send({ toStageKey: "done", expectedVersion: 2 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("approval_required");
  });

  it("lets routine agents fan out child cases with context and request-key idempotency", async () => {
    const company = await seedCompany();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Pipeline Agent",
      role: "engineer",
      status: "idle",
    }).returning();
    await grantAgentPipelineWrite(company.id, agent!.id);
    const [routine] = await db.insert(routines).values({
      companyId: company.id,
      title: "Fan out {{release_notes}}",
      description: "Create child work for {{case_id}}.",
      assigneeAgentId: agent!.id,
      variables: [
        { name: "case_id", type: "text", required: true },
        { name: "release_notes", type: "text", required: true },
      ],
    }).returning();
    const http = request(app(boardActor));
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "agent-fanout",
        name: "Agent fanout",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          {
            key: "planning",
            name: "Planning",
            kind: "working",
            position: 200,
            config: { onEnter: { type: "run_routine", routineId: routine!.id } },
          },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);

    const parent = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "release", title: "Release", fields: { release_notes: "v1 shipped" } })
      .expect(201);
    await http
      .post(`/api/cases/${parent.body.case.id}/transition`)
      .send({ toStageKey: "planning", expectedVersion: 1 })
      .expect(200);

    const [run] = await db.select().from(routineRuns).where(eq(routineRuns.routineId, routine!.id));
    expect(run!.triggerPayload).toMatchObject({
      variables: {
        case_id: parent.body.case.id,
        release_notes: "v1 shipped",
      },
    });
    const [executionIssue] = await db.select().from(issues).where(eq(issues.originRunId, run!.id));
    expect(executionIssue!.title).toBe("[Pipeline: Agent fanout > Planning] Release (release): Fan out v1 shipped");
    const description = executionIssue!.description ?? "";
    const sectionOrder = [
      "## Pipeline Stage Automation",
      "## User Task",
      "## Workflow Instructions",
      "## Technical Context",
    ].map((heading) => description.indexOf(heading));
    expect(sectionOrder.every((index) => index >= 0)).toBe(true);
    expect(sectionOrder).toEqual([...sectionOrder].sort((left, right) => left - right));
    expect(description).toContain(`---\n\nCreate child work for ${parent.body.case.id}.\n\n---`);
    expect(description).toContain("`pipeline-case-operations`");
    expect(description).toContain(`- case_id: ${parent.body.case.id}`);
    expect(description).toContain(`- "release_notes": "v1 shipped"`);
    expect(description.match(/```json/g)).toHaveLength(1);
    expect(description).not.toContain("{pipelineId}");

    const agentActor: Express.Request["actor"] = {
      type: "agent",
      agentId: agent!.id,
      companyId: company.id,
      runId: randomUUID(),
      source: "agent_key",
    };
    const agentHttp = request(app(agentActor));
    const child = await agentHttp
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({
        caseKey: "child-a",
        title: "Child A",
        parentCaseId: parent.body.case.id,
        requestKey: "fanout:child-a",
        fields: { release_notes: "v1 shipped", asset: "hero" },
      })
      .expect(201);
    expect(child.body.case.parentCaseVersion).toBe(2);
    expect(child.body.case.requestKey).toBe("fanout:child-a");

    const retry = await agentHttp
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({
        caseKey: "child-a-retry",
        title: "Duplicate child",
        parentCaseId: parent.body.case.id,
        requestKey: "fanout:child-a",
        fields: { release_notes: "changed" },
      })
      .expect(200);
    expect(retry.body.created).toBe(false);
    expect(retry.body.case.id).toBe(child.body.case.id);
    expect(retry.body.case.title).toBe("Child A");

    await agentHttp.get(`/api/cases/${child.body.case.id}`).expect(200);
    await agentHttp
      .post(`/api/cases/${child.body.case.id}/transition`)
      .send({ toStageKey: "done", expectedVersion: 1 })
      .expect(200);
  });

  it("prevents agents from using case links to mutate another agent's issue indirectly", async () => {
    const company = await seedCompany();
    const [agent, otherAgent] = await db.insert(agents).values([
      {
        companyId: company.id,
        name: "Pipeline Agent",
        role: "engineer",
        status: "idle",
      },
      {
        companyId: company.id,
        name: "Other Agent",
        role: "engineer",
        status: "idle",
      },
    ]).returning();
    const http = request(app(boardActor));
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "link-authz", name: "Link authz" })
      .expect(201);
    const created = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "link-target", title: "Link target" })
      .expect(201);
    const [otherAgentIssue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Other-agent issue",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: otherAgent!.id,
    }).returning();
    const agentActor: Express.Request["actor"] = {
      type: "agent",
      agentId: agent!.id,
      companyId: company.id,
      runId: randomUUID(),
      source: "agent_key",
    };
    const agentHttp = request(app(agentActor));

    await agentHttp
      .post(`/api/cases/${created.body.case.id}/issue-links`)
      .send({ issueId: otherAgentIssue!.id, role: "work" })
      .expect(403);

    const link = await http
      .post(`/api/cases/${created.body.case.id}/issue-links`)
      .send({ issueId: otherAgentIssue!.id, role: "work" })
      .expect(201);

    await agentHttp
      .delete(`/api/cases/${created.body.case.id}/issue-links/${link.body.id}`)
      .expect(403);
  });

  it("resequences stages when inserting at an occupied position", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "insert-position", name: "Insert position" })
      .expect(201);

    await http
      .post(`/api/pipelines/${pipeline.body.id}/stages`)
      .send({ key: "qa", name: "QA", kind: "working", position: 200 })
      .expect(201);

    const detail = await http.get(`/api/pipelines/${pipeline.body.id}`).expect(200);
    expect(detail.body.stages.map((stage: { key: string; position: number }) => [stage.key, stage.position])).toEqual([
      ["intake", 100],
      ["qa", 200],
      ["in_progress", 300],
      ["review", 400],
      ["done", 1000],
      ["cancelled", 1100],
    ]);
  });

  it("requires a reason for forced off-path transition requests", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "force-route", name: "Force route", enforceTransitions: true })
      .expect(201);
    const created = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "force-me", title: "Force me" })
      .expect(201);

    const missingReason = await http
      .post(`/api/cases/${created.body.case.id}/transition`)
      .send({ toStageKey: "done", expectedVersion: 1, force: true });
    expect(missingReason.status).toBe(422);
    expect(missingReason.body.code).toBe("transition_not_allowed");

    await http
      .post(`/api/cases/${created.body.case.id}/transition`)
      .send({ toStageKey: "done", expectedVersion: 1, force: true, reason: "Operator override" })
      .expect(200);

    const events = await db.select().from(pipelineCaseEvents).where(eq(pipelineCaseEvents.caseId, created.body.case.id));
    expect(events.some((event) => event.type === "transition_forced" && event.payload.reason === "Operator override")).toBe(true);
  });

  it("validates review stage config on create and update", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));

    await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "bad-review",
        name: "Bad review",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          { key: "review", name: "Review", kind: "review", position: 200 },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(422);

    const pipeline = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "valid-review", name: "Valid review" }).expect(201);
    const intake = pipeline.body.stages.find((stage: { key: string }) => stage.key === "intake");
    await http.patch(`/api/pipelines/${pipeline.body.id}/stages/${intake.id}`).send({ kind: "review" }).expect(422);

    await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "bad-request-changes-target",
        name: "Bad request changes target",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          {
            key: "review",
            name: "Review",
            kind: "review",
            position: 200,
            config: {
              approveToStageKey: "done",
              rejectToStageKey: "cancelled",
              requestChangesToStageKey: "missing",
            },
          },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(422);
  });

  it("applies review decisions atomically with edits and stores reject reasons verbatim", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipeline = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "review-decisions", name: "Review decisions" }).expect(201);

    const approved = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "approve-edit", title: "Approve edit" })
      .expect(201);
    await http.post(`/api/cases/${approved.body.case.id}/transition`).send({ toStageKey: "review", expectedVersion: 1 }).expect(200);
    const approval = await http
      .post(`/api/cases/${approved.body.case.id}/review`)
      .send({
        decision: "approve",
        expectedVersion: 2,
        edits: { title: "Approved title", fields: { channel: "blog" } },
      })
      .expect(200);
    expect(approval.body.case.version).toBe(4);
    expect(approval.body.updateEvent.payload.version).toBe(3);
    const approvedDetail = await http.get(`/api/cases/${approved.body.case.id}`).expect(200);
    expect(approvedDetail.body.case.title).toBe("Approved title");
    expect(approvedDetail.body.case.fields).toEqual({ channel: "blog" });
    const approvedEvents = await http.get(`/api/cases/${approved.body.case.id}/events`).expect(200);
    expect(approvedEvents.body.items.map((event: { type: string }) => event.type)).toEqual([
      "ingested",
      "transitioned",
      "updated",
      "transitioned",
      "review_decided",
    ]);

    const rejected = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "reject-reason", title: "Reject reason" })
      .expect(201);
    await http.post(`/api/cases/${rejected.body.case.id}/transition`).send({ toStageKey: "review", expectedVersion: 1 }).expect(200);
    await http.post(`/api/cases/${rejected.body.case.id}/review`).send({ decision: "reject", expectedVersion: 2 }).expect(422);
    const reason = "  Keep this exact reason.  ";
    await http.post(`/api/cases/${rejected.body.case.id}/review`).send({ decision: "reject", reason, expectedVersion: 2 }).expect(200);
    const rejectedEvents = await http.get(`/api/cases/${rejected.body.case.id}/events`).expect(200);
    const reviewEvent = rejectedEvents.body.items.find((event: { type: string }) => event.type === "review_decided");
    expect(reviewEvent.payload.reason).toBe(reason);
  });

  it("routes request-changes review decisions to the configured stage", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "review-request-changes",
        name: "Review request changes",
        stages: [
          { key: "drafting", name: "Drafting", kind: "working", position: 100 },
          {
            key: "review",
            name: "Review",
            kind: "review",
            position: 200,
            config: {
              approveToStageKey: "done",
              rejectToStageKey: "cancelled",
              requestChangesToStageKey: "drafting",
            },
          },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);

    const created = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "needs-edits", title: "Needs edits" })
      .expect(201);
    await http.post(`/api/cases/${created.body.case.id}/transition`).send({ toStageKey: "review", expectedVersion: 1 }).expect(200);
    await http
      .post(`/api/cases/${created.body.case.id}/review`)
      .send({ decision: "request_changes", expectedVersion: 2 })
      .expect(422);

    const changed = await http
      .post(`/api/cases/${created.body.case.id}/review`)
      .send({ decision: "request_changes", reason: "Tighten the framing", expectedVersion: 2 })
      .expect(200);
    expect(changed.body.case.version).toBe(3);
    const detail = await http.get(`/api/cases/${created.body.case.id}`).expect(200);
    expect(detail.body.stage.key).toBe("drafting");
    const events = await http.get(`/api/cases/${created.body.case.id}/events`).expect(200);
    const reviewEvent = events.body.items.find((event: { type: string }) => event.type === "review_decided");
    expect(reviewEvent.payload.decision).toBe("request_changes");
    expect(reviewEvent.payload.reason).toBe("Tighten the framing");

    const defaultPipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "review-request-changes-missing", name: "Review request changes missing" })
      .expect(201);
    const missingConfigCase = await http
      .post(`/api/pipelines/${defaultPipeline.body.id}/cases`)
      .send({ caseKey: "missing-config", title: "Missing config" })
      .expect(201);
    await http.post(`/api/cases/${missingConfigCase.body.case.id}/transition`).send({ toStageKey: "review", expectedVersion: 1 }).expect(200);
    const missingConfig = await http
      .post(`/api/cases/${missingConfigCase.body.case.id}/review`)
      .send({ decision: "request_changes", reason: "Needs a loop", expectedVersion: 2 })
      .expect(422);
    expect(missingConfig.body.code).toBe("validation");
  });

  it("aggregates the review inbox across pipelines with parent and review config context", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const first = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "inbox-a", name: "Inbox A" }).expect(201);
    const second = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "inbox-b", name: "Inbox B" }).expect(201);

    const parent = await http
      .post(`/api/pipelines/${first.body.id}/cases`)
      .send({ caseKey: "parent", title: "Parent" })
      .expect(201);
    const child = await http
      .post(`/api/pipelines/${first.body.id}/cases`)
      .send({ caseKey: "child", title: "Child", parentCaseId: parent.body.case.id })
      .expect(201);
    await http.post(`/api/cases/${child.body.case.id}/transition`).send({ toStageKey: "review", expectedVersion: 1 }).expect(200);

    const other = await http
      .post(`/api/pipelines/${second.body.id}/cases`)
      .send({ caseKey: "other", title: "Other" })
      .expect(201);
    await http.post(`/api/cases/${other.body.case.id}/transition`).send({ toStageKey: "review", expectedVersion: 1 }).expect(200);

    const notReview = await http
      .post(`/api/pipelines/${second.body.id}/cases`)
      .send({ caseKey: "not-review", title: "Not review" })
      .expect(201);
    await http.post(`/api/cases/${notReview.body.case.id}/transition`).send({ toStageKey: "done", expectedVersion: 1 }).expect(200);

    const inbox = await http.get(`/api/companies/${company.id}/review-cases`).expect(200);
    expect(inbox.body).toHaveLength(2);
    expect(inbox.body.map((row: { pipeline: { key: string } }) => row.pipeline.key).sort()).toEqual(["inbox-a", "inbox-b"]);
    const childRow = inbox.body.find((row: { case: { id: string } }) => row.case.id === child.body.case.id);
    expect(childRow.parentCase.id).toBe(parent.body.case.id);
    expect(childRow.reviewConfig).toMatchObject({
      approveToStageKey: "done",
      rejectToStageKey: "cancelled",
      requireRejectReason: true,
      requireApproval: true,
      approver: { kind: "any_human" },
    });
  });

  it("bulk reviews partial successes without aborting stale items", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "bulk-review",
        name: "Bulk review",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          { key: "in_progress", name: "In progress", kind: "working", position: 200 },
          {
            key: "review",
            name: "Review",
            kind: "review",
            position: 300,
            config: {
              approveToStageKey: "done",
              rejectToStageKey: "cancelled",
              requestChangesToStageKey: "in_progress",
            },
          },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const caseIds: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      const created = await http
        .post(`/api/pipelines/${pipeline.body.id}/cases`)
        .send({ caseKey: `bulk-${index}`, title: `Bulk ${index}` })
        .expect(201);
      await http.post(`/api/cases/${created.body.case.id}/transition`).send({ toStageKey: "review", expectedVersion: 1 }).expect(200);
      caseIds.push(created.body.case.id);
    }
    for (const staleCaseId of caseIds.slice(0, 3)) {
      await http.patch(`/api/cases/${staleCaseId}`).send({ fields: { staleBeforeBulk: true }, expectedVersion: 2 }).expect(200);
    }

    const bulk = await http
      .post(`/api/companies/${company.id}/review-cases/bulk`)
      .send({
        items: caseIds.map((caseId, index) => index === 3
          ? { caseId, decision: "request_changes", reason: "Revise this item", expectedVersion: 2 }
          : { caseId, decision: "approve", expectedVersion: 2 }),
      })
      .expect(200);

    expect(bulk.body.results.filter((item: { ok: boolean }) => item.ok)).toHaveLength(47);
    const failed = bulk.body.results.filter((item: { ok: boolean }) => !item.ok);
    expect(failed).toHaveLength(3);
    expect(failed.every((item: { error: { code: string } }) => item.error.code === "version_conflict")).toBe(true);
    const requestChangesDetail = await http.get(`/api/cases/${caseIds[3]}`).expect(200);
    expect(requestChangesDetail.body.stage.key).toBe("in_progress");
  });

  it("returns conflict bodies with code, current version, and stage", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipelineRes = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "conflict", name: "Conflict" }).expect(201);
    const caseRes = await http.post(`/api/pipelines/${pipelineRes.body.id}/cases`).send({ caseKey: "conflict", title: "Conflict" }).expect(201);
    await http.patch(`/api/cases/${caseRes.body.case.id}`).send({ fields: { body: "Updated" }, expectedVersion: 1 }).expect(200);

    const res = await http.patch(`/api/cases/${caseRes.body.case.id}`).send({ fields: { body: "Stale" }, expectedVersion: 1 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("version_conflict");
    expect(res.body.details.version).toBe(2);
    expect(res.body.details.stage.key).toBe("intake");
  });
});
