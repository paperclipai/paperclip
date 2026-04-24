import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documents,
  instanceSettings,
  issueComments,
  issueDocuments,
  issueRelations,
  issueWorkflowInstances,
  issueWorkflowLaneArtifacts,
  issueWorkflowLanes,
  issueWorkProducts,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { issueWorkflowService } from "../services/issue-workflows.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueWorkflowService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let workflows!: ReturnType<typeof issueWorkflowService>;
  let settings!: ReturnType<typeof instanceSettingsService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-workflows-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    workflows = issueWorkflowService(db);
    settings = instanceSettingsService(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(issueWorkProducts);
    await db.delete(issueWorkflowLaneArtifacts);
    await db.delete(issueWorkflowLanes);
    await db.delete(issueWorkflowInstances);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "PrivateClip") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `WF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedProject(companyId: string) {
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Checkout",
      status: "active",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
      },
    });
    return projectId;
  }

  async function seedAgent(companyId: string, role: string, name: string, status = "active") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role,
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function attachIssueDocument(input: {
    companyId: string;
    issueId: string;
    key: string;
    title: string;
    authorAgentId: string;
    updatedAt?: Date;
  }) {
    const documentId = randomUUID();
    const updatedAt = input.updatedAt ?? new Date();
    await db.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      title: input.title,
      format: "markdown",
      latestBody: `${input.title} body`,
      latestRevisionId: null,
      latestRevisionNumber: 1,
      createdByAgentId: input.authorAgentId,
      updatedByAgentId: input.authorAgentId,
      createdAt: updatedAt,
      updatedAt,
    });
    await db.insert(issueDocuments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      documentId,
      key: input.key,
    });
    return documentId;
  }

  async function markLaneDoneAndPromote(issueId: string) {
    await svc.update(issueId, { status: "done", completionGuardrailsSatisfied: true });
    return workflows.advanceWorkflowDependents(issueId);
  }

  it("creates deterministic workflow child lanes with inherited context and isolated build lanes", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "security", "Security Agent");
    await seedAgent(companyId, "qa", "QA Agent");

    const rootIssue = await svc.create(companyId, {
      title: "Harden checkout release",
      projectId,
      priority: "high",
      status: "todo",
      createdByUserId: "user-1",
    });

    const applied = await workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    });

    expect(applied.parentIssue.workflowTemplateKey).toBe("engineering_delivery_v1");
    expect(applied.createdChildren.map((issue) => issue.workflowLaneRole)).toEqual([
      "pm",
      "designer",
      "engineer",
      "security",
      "qa",
    ]);
    const laneByRole = new Map(
      applied.createdChildren.map((issue) => [issue.workflowLaneRole, issue]),
    );
    expect(laneByRole.get("pm")?.status).toBe("todo");
    expect(laneByRole.get("designer")?.status).toBe("blocked");
    expect(laneByRole.get("engineer")?.status).toBe("blocked");
    expect(laneByRole.get("security")?.status).toBe("blocked");
    expect(laneByRole.get("qa")?.status).toBe("blocked");
    expect(applied.createdChildren.every((issue) => issue.parentId === rootIssue.id)).toBe(true);
    expect(applied.createdChildren.every((issue) => issue.projectId === projectId)).toBe(true);
    expect(applied.createdChildren.every((issue) => (issue.workflowRequiredArtifacts?.length ?? 0) > 0)).toBe(true);

    const isolatedLaneRoles = applied.createdChildren
      .filter((issue) => issue.executionWorkspacePreference === "isolated_workspace")
      .map((issue) => issue.workflowLaneRole);
    expect(isolatedLaneRoles).toEqual(["engineer", "security", "qa"]);

    const blockerRows = await db
      .select({
        blockerIssueId: issueRelations.issueId,
        blockedIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(blockerRows).toEqual(expect.arrayContaining([
      {
        blockerIssueId: laneByRole.get("pm")?.id,
        blockedIssueId: laneByRole.get("designer")?.id,
      },
      {
        blockerIssueId: laneByRole.get("designer")?.id,
        blockedIssueId: laneByRole.get("engineer")?.id,
      },
      {
        blockerIssueId: laneByRole.get("engineer")?.id,
        blockedIssueId: laneByRole.get("security")?.id,
      },
      {
        blockerIssueId: laneByRole.get("engineer")?.id,
        blockedIssueId: laneByRole.get("qa")?.id,
      },
    ]));

    const decoratedParent = await workflows.decorateIssue(applied.parentIssue);
    expect(decoratedParent.workflowSummary?.lanes).toHaveLength(5);
  });

  it("repairs missing workflow dependency relations and blocked statuses when decorating a stale workflow root", async () => {
    const companyId = await seedCompany("WorkflowRepairCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "security", "Security Agent");
    await seedAgent(companyId, "qa", "QA and Release Engineer");

    const rootIssue = await svc.create(companyId, {
      title: "Repair a stale workflow graph",
      projectId,
      priority: "high",
      status: "todo",
      createdByUserId: "user-1",
    });

    const applied = await workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    });
    const laneByRole = new Map(
      applied.createdChildren.map((issue) => [issue.workflowLaneRole, issue]),
    );
    const downstreamLaneIds = ["designer", "engineer", "security", "qa"]
      .map((role) => laneByRole.get(role)?.id)
      .filter((issueId): issueId is string => Boolean(issueId));

    await db
      .delete(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    for (const laneId of downstreamLaneIds) {
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, laneId));
    }

    const decoratedParent = await workflows.decorateIssue(applied.parentIssue);
    expect(decoratedParent.workflowSummary?.activeRoles).toEqual(["pm"]);
    expect(decoratedParent.workflowSummary?.waitingRoles).toEqual([
      "designer",
      "engineer",
      "security",
      "qa",
    ]);

    const blockerRows = await db
      .select({
        blockerIssueId: issueRelations.issueId,
        blockedIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(blockerRows).toHaveLength(4);

    const refreshedStatuses = await Promise.all(
      downstreamLaneIds.map(async (issueId) => (await svc.getById(issueId))?.status ?? null),
    );
    expect(refreshedStatuses).toEqual(["blocked", "blocked", "blocked", "blocked"]);
  });

  it("provisions and assigns a security specialist when template application needs one", async () => {
    const companyId = await seedCompany("NoSecCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "ceo", "CEO Agent");
    await seedAgent(companyId, "coo", "COO Agent");
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "qa", "QA Agent");

    const rootIssue = await svc.create(companyId, {
      title: "Release checkout",
      projectId,
      priority: "medium",
      status: "todo",
      createdByUserId: "user-1",
    });

    const applied = await workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    });

    const reloadedParent = await svc.getById(rootIssue.id);
    expect(reloadedParent?.workflowTemplateKey).toBe("engineering_delivery_v1");

    const persistedChildren = await db
      .select({
        id: issues.id,
        workflowLaneRole: issues.workflowLaneRole,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.parentId, rootIssue.id));
    expect(applied.createdChildren).toHaveLength(5);
    expect(persistedChildren).toHaveLength(5);

    const securityAgent = await db
      .select({
        id: agents.id,
        role: agents.role,
        status: agents.status,
        name: agents.name,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .then((rows) => rows.find((row) => row.role === "security") ?? null);
    expect(securityAgent).not.toBeNull();
    expect(securityAgent?.status).toBe("idle");

    const securityLane = persistedChildren.find((issue) => issue.workflowLaneRole === "security") ?? null;
    expect(securityLane?.assigneeAgentId).toBe(securityAgent?.id ?? null);

    const workflowInstances = await db.execute(sql`
      select root_issue_id, template_key
      from issue_workflow_instances
      where root_issue_id = ${rootIssue.id}
    `) as Array<{ root_issue_id: string; template_key: string }>;
    expect(workflowInstances).toHaveLength(1);
    expect(workflowInstances[0]?.root_issue_id).toBe(rootIssue.id);
    expect(workflowInstances[0]?.template_key).toBe("engineering_delivery_v1");

    const workflowLanes = await db.execute(sql`
      select issue_id, lane_role, reviewer_agent_id
      from issue_workflow_lanes
      where root_issue_id = ${rootIssue.id}
      order by lane_role asc
    `) as Array<{ issue_id: string; lane_role: string; reviewer_agent_id: string | null }>;
    expect(workflowLanes).toHaveLength(5);
    expect(workflowLanes.find((lane) => lane.lane_role === "security")?.issue_id).toBe(securityLane?.id ?? null);
    expect(workflowLanes.find((lane) => lane.lane_role === "security")?.reviewer_agent_id).toBeNull();
  });

  it("blocks workflow application instead of duplicating an unavailable security specialist", async () => {
    const companyId = await seedCompany("PausedSecCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "ceo", "CEO Agent");
    await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "security", "Paused Security Agent", "paused");
    await seedAgent(companyId, "qa", "QA Agent");

    const rootIssue = await svc.create(companyId, {
      title: "Provision replacement security coverage",
      projectId,
      priority: "medium",
      status: "todo",
      createdByUserId: "user-1",
    });

    await expect(workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    })).rejects.toThrow("requires an available security specialist");

    const securityAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .then((rows) => rows.filter((row) => row.role === "security"));
    expect(securityAgents).toHaveLength(1);
    expect(securityAgents[0]?.status).toBe("paused");

    const childLanes = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.parentId, rootIssue.id));
    expect(childLanes).toHaveLength(0);
  });

  it("rolls back root issue creation when a workflow template cannot be applied inside the same transaction", async () => {
    const companyId = await seedCompany("NoSecAtomicCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    await seedAgent(companyId, "qa", "QA Agent");

    await expect(db.transaction(async (tx) => {
      const rootIssue = await svc.create(companyId, {
        title: "Atomic workflow create",
        projectId,
        priority: "medium",
        status: "todo",
        createdByUserId: "user-1",
      }, tx);

      await workflows.applyTemplate({
        companyId,
        templateKey: "engineering_delivery_v1",
        parentIssue: rootIssue,
        actorUserId: "user-1",
        createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
        updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
        dbOrTx: tx,
      });
    })).rejects.toThrow("requires an available security specialist");

    const persistedIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(persistedIssues).toHaveLength(0);
  });

  it("assigns the least-loaded pooled QA reviewer to workflow QA lanes even when a canonical reviewer exists", async () => {
    const companyId = await seedCompany("CanonicalQaWorkflowCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "security", "Security Agent");
    const qaRunnerAgentId = await seedAgent(companyId, "qa", "QA Runner");
    const canonicalQaAgentId = await seedAgent(companyId, "qa", "QA and Release Engineer");

    await svc.create(companyId, {
      title: "Existing canonical QA load",
      projectId,
      priority: "medium",
      status: "todo",
      assigneeAgentId: canonicalQaAgentId,
      createdByUserId: "user-1",
    });

    const rootIssue = await svc.create(companyId, {
      title: "Route workflow QA to the pooled reviewer",
      projectId,
      priority: "high",
      status: "todo",
      createdByUserId: "user-1",
    });

    const applied = await workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    });

    const qaLane = applied.createdChildren.find((issue) => issue.workflowLaneRole === "qa");
    expect(qaLane?.assigneeAgentId).toBe(qaRunnerAgentId);
    expect(qaLane?.assigneeAgentId).not.toBe(canonicalQaAgentId);
  });

  it("falls back to a single eligible non-canonical QA agent for workflow QA ownership", async () => {
    const companyId = await seedCompany("SingleFallbackQaWorkflowCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "security", "Security Agent");
    const qaRunnerAgentId = await seedAgent(companyId, "qa", "QA Runner");

    const rootIssue = await svc.create(companyId, {
      title: "Allow single-QA workflow fallback",
      projectId,
      priority: "high",
      status: "todo",
      createdByUserId: "user-1",
    });

    const applied = await workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    });
    const laneByRole = new Map(
      applied.createdChildren.map((issue) => [issue.workflowLaneRole, issue]),
    );
    const qaLane = laneByRole.get("qa");
    expect(qaLane?.assigneeAgentId ?? null).toBe(qaRunnerAgentId);

    await markLaneDoneAndPromote(laneByRole.get("pm")!.id);
    await markLaneDoneAndPromote(laneByRole.get("designer")!.id);
    await markLaneDoneAndPromote(laneByRole.get("engineer")!.id);

    const refreshedQaLane = await svc.getById(qaLane!.id);
    expect(refreshedQaLane?.assigneeAgentId ?? null).toBe(qaRunnerAgentId);

    const decoratedParent = await workflows.decorateIssue(applied.parentIssue);
    expect(decoratedParent.workflowSummary?.ownerNeededRoles).not.toContain("qa");
  });

  it("prefers the configured release-gate QA owner over canonical-name heuristics for workflow QA lanes", async () => {
    const companyId = await seedCompany("ConfiguredQaWorkflowCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "security", "Security Agent");
    const configuredQaAgentId = await seedAgent(companyId, "qa", "QA Runner");
    await seedAgent(companyId, "qa", "QA and Release Engineer");

    await db
      .update(companies)
      .set({ releaseGateQaAgentId: configuredQaAgentId })
      .where(eq(companies.id, companyId));

    const rootIssue = await svc.create(companyId, {
      title: "Use configured QA owner",
      projectId,
      priority: "high",
      status: "todo",
      createdByUserId: "user-1",
    });

    const applied = await workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    });

    const qaLane = applied.createdChildren.find((issue) => issue.workflowLaneRole === "qa");
    expect(qaLane?.assigneeAgentId).toBe(configuredQaAgentId);
  });

  it("assigns workflow QA lanes from the pooled reviewer roster when multiple QA agents are eligible", async () => {
    const companyId = await seedCompany("AmbiguousQaWorkflowCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "security", "Security Agent");
    const qaOwnerOneId = await seedAgent(companyId, "qa", "QA One");
    const qaOwnerTwoId = await seedAgent(companyId, "qa", "QA Two");

    const rootIssue = await svc.create(companyId, {
      title: "Route workflow QA from the reviewer pool",
      projectId,
      priority: "high",
      status: "todo",
      createdByUserId: "user-1",
    });

    const applied = await workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    });
    const laneByRole = new Map(
      applied.createdChildren.map((issue) => [issue.workflowLaneRole, issue]),
    );
    const qaLane = laneByRole.get("qa");
    const expectedQaAssigneeId = [qaOwnerOneId, qaOwnerTwoId].sort()[0];
    expect(qaLane?.assigneeAgentId ?? null).toBe(expectedQaAssigneeId);

    await markLaneDoneAndPromote(laneByRole.get("pm")!.id);
    await markLaneDoneAndPromote(laneByRole.get("designer")!.id);
    await markLaneDoneAndPromote(laneByRole.get("engineer")!.id);

    const refreshedQaLane = await svc.getById(qaLane!.id);
    expect(refreshedQaLane?.status).toBe("todo");
    expect(refreshedQaLane?.assigneeAgentId ?? null).toBe(expectedQaAssigneeId);

    const decoratedParent = await workflows.decorateIssue(applied.parentIssue);
    const qaSummary = decoratedParent.workflowSummary?.lanes.find((lane) => lane.role === "qa");
    expect(qaSummary?.phase).toBe("ready");
    expect(qaSummary?.unresolvedOwnership).toBe(false);
    expect(decoratedParent.workflowSummary?.ownerNeededRoles).not.toContain("qa");
  });

  it("assigns a pooled QA reviewer when a blocked workflow QA lane becomes unblocked", async () => {
    const companyId = await seedCompany("UnblockQaWorkflowCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "security", "Security Agent");

    const rootIssue = await svc.create(companyId, {
      title: "Assign QA on unblock",
      projectId,
      priority: "high",
      status: "todo",
      createdByUserId: "user-1",
    });

    const applied = await workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    });
    const laneByRole = new Map(
      applied.createdChildren.map((issue) => [issue.workflowLaneRole, issue]),
    );
    const qaLane = laneByRole.get("qa");
    expect(qaLane?.status).toBe("blocked");
    expect(qaLane?.assigneeAgentId ?? null).toBeNull();

    const canonicalQaAgentId = await seedAgent(companyId, "qa", "QA and Release Engineer");

    await markLaneDoneAndPromote(laneByRole.get("pm")!.id);
    await markLaneDoneAndPromote(laneByRole.get("designer")!.id);
    await markLaneDoneAndPromote(laneByRole.get("engineer")!.id);

    const refreshedQaLane = await svc.getById(qaLane!.id);
    expect(refreshedQaLane?.status).toBe("todo");
    expect(refreshedQaLane?.assigneeAgentId).toBe(canonicalQaAgentId);
  });

  it("does not let stale QA reviewer memory override pooled lane assignment on unblock", async () => {
    const companyId = await seedCompany("StaleQaMemoryWorkflowCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "security", "Security Agent");
    const loadedQaAgentId = await seedAgent(companyId, "qa", "Loaded QA");
    const freshQaAgentId = await seedAgent(companyId, "qa", "Fresh QA");

    await svc.create(companyId, {
      title: "Existing QA load",
      projectId,
      priority: "medium",
      status: "todo",
      assigneeAgentId: loadedQaAgentId,
      createdByUserId: "user-1",
    });

    const rootIssue = await svc.create(companyId, {
      title: "Ignore stale QA memory on unblock",
      projectId,
      priority: "high",
      status: "todo",
      createdByUserId: "user-1",
    });

    const applied = await workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    });
    const laneByRole = new Map(
      applied.createdChildren.map((issue) => [issue.workflowLaneRole, issue]),
    );
    const qaLane = laneByRole.get("qa");
    expect(qaLane?.status).toBe("blocked");

    await db
      .update(issues)
      .set({
        assigneeAgentId: null,
        qaReviewerAgentId: loadedQaAgentId,
      })
      .where(eq(issues.id, qaLane!.id));
    await db
      .update(issueWorkflowLanes)
      .set({ reviewerAgentId: loadedQaAgentId })
      .where(eq(issueWorkflowLanes.issueId, qaLane!.id));

    await markLaneDoneAndPromote(laneByRole.get("pm")!.id);
    await markLaneDoneAndPromote(laneByRole.get("designer")!.id);
    await markLaneDoneAndPromote(laneByRole.get("engineer")!.id);

    const refreshedQaLane = await svc.getById(qaLane!.id);
    expect(refreshedQaLane?.status).toBe("todo");
    expect(refreshedQaLane?.assigneeAgentId).toBe(freshQaAgentId);
    expect(refreshedQaLane?.qaReviewerAgentId).toBe(freshQaAgentId);

    const refreshedWorkflowLane = await db
      .select({ reviewerAgentId: issueWorkflowLanes.reviewerAgentId })
      .from(issueWorkflowLanes)
      .where(eq(issueWorkflowLanes.issueId, qaLane!.id))
      .then((rows) => rows[0] ?? null);
    expect(refreshedWorkflowLane?.reviewerAgentId).toBe(freshQaAgentId);
  });

  it("blocks lane completion when required artifacts are missing or security fail markers are present", async () => {
    const companyId = await seedCompany("SecReviewCo");
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    const securityAgentId = await seedAgent(companyId, "security", "Security Agent");

    const laneIssue = await svc.create(companyId, {
      title: "Security: Threat review",
      status: "todo",
      priority: "medium",
      assigneeAgentId: securityAgentId,
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "security",
      workflowRequiredArtifacts: [
        {
          key: "threat-review",
          label: "Threat review document",
          kind: "document",
          blocking: true,
          documentKey: "threat-review",
        },
      ],
      createdByUserId: "user-1",
    });

    const missingArtifacts = await workflows.evaluateLaneCompletion(laneIssue);
    expect(missingArtifacts.canComplete).toBe(false);
    expect(missingArtifacts.blockingReasons[0]).toContain("Threat review document");

    const documentId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Threat review",
      format: "markdown",
      latestBody: "Threat review body",
      latestRevisionId: null,
      latestRevisionNumber: 1,
      createdByAgentId: securityAgentId,
      updatedByAgentId: securityAgentId,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId: laneIssue.id,
      documentId,
      key: "threat-review",
    });

    const satisfiedArtifacts = await workflows.evaluateLaneCompletion(laneIssue);
    expect(satisfiedArtifacts.canComplete).toBe(true);

    await db.insert(issueComments).values({
      companyId,
      issueId: laneIssue.id,
      authorAgentId: securityAgentId,
      authorUserId: null,
      body: "[SECURITY FAIL] Auth abuse path still unresolved",
    });

    const blockedBySecurityComment = await workflows.evaluateLaneCompletion(laneIssue);
    expect(blockedBySecurityComment.canComplete).toBe(false);
    expect(blockedBySecurityComment.blockingReasons).toContain("Fail-level security findings are unresolved.");
  });

  it("requires the latest assigned QA verdict comment to be complete and passing for workflow QA lanes", async () => {
    const companyId = await seedCompany("WorkflowQaGateCo");
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    const canonicalQaAgentId = await seedAgent(companyId, "qa", "QA and Release Engineer");
    const qaRunnerAgentId = await seedAgent(companyId, "qa", "QA Runner");

    const qaLane = await svc.create(companyId, {
      title: "QA: Validate release",
      status: "in_review",
      priority: "high",
      assigneeAgentId: canonicalQaAgentId,
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
      workflowRequiredArtifacts: [
        {
          key: "qa-verdict",
          label: "QA verdict document",
          kind: "document",
          blocking: true,
          documentKey: "qa-verdict",
        },
      ],
      createdByUserId: "user-1",
    });

    await attachIssueDocument({
      companyId,
      issueId: qaLane.id,
      key: "qa-verdict",
      title: "QA verdict",
      authorAgentId: canonicalQaAgentId,
      updatedAt: new Date("2026-04-10T09:00:00Z"),
    });

    await db.insert(issueComments).values([
      {
        id: randomUUID(),
        companyId,
        issueId: qaLane.id,
        authorAgentId: canonicalQaAgentId,
        authorUserId: null,
        body: [
          "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
          "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
          "[QA PASS]",
          "[RELEASE CONFIRMED]",
        ].join("\n"),
        createdAt: new Date("2026-04-10T10:00:00Z"),
        updatedAt: new Date("2026-04-10T10:00:00Z"),
      },
      {
        id: randomUUID(),
        companyId,
        issueId: qaLane.id,
        authorAgentId: canonicalQaAgentId,
        authorUserId: null,
        body: [
          "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
          "[QA PASS]",
          "[RELEASE CONFIRMED]",
        ].join("\n"),
        createdAt: new Date("2026-04-10T11:00:00Z"),
        updatedAt: new Date("2026-04-10T11:00:00Z"),
      },
      {
        id: randomUUID(),
        companyId,
        issueId: qaLane.id,
        authorAgentId: qaRunnerAgentId,
        authorUserId: null,
        body: [
          "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
          "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
          "[QA PASS]",
          "[RELEASE CONFIRMED]",
        ].join("\n"),
        createdAt: new Date("2026-04-10T12:00:00Z"),
        updatedAt: new Date("2026-04-10T12:00:00Z"),
      },
    ]);

    const blocked = await workflows.evaluateLaneCompletion(qaLane);
    expect(blocked.canComplete).toBe(false);
    expect(blocked.blockingReasons).toContain("Latest assigned QA verdict must include passing verification evidence.");

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId: qaLane.id,
      authorAgentId: canonicalQaAgentId,
      authorUserId: null,
      body: [
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
        "TYPECHECK=pass",
        "TESTS=pass",
        "BUILD=pass",
        "SMOKE=pass",
        "[QA PASS]",
        "[RELEASE CONFIRMED]",
      ].join("\n"),
      createdAt: new Date("2026-04-10T12:30:00Z"),
      updatedAt: new Date("2026-04-10T12:30:00Z"),
    });

    const blockedByNonCanonicalVerification = await workflows.evaluateLaneCompletion(qaLane);
    expect(blockedByNonCanonicalVerification.canComplete).toBe(false);
    expect(blockedByNonCanonicalVerification.blockingReasons).toContain(
      "Latest assigned QA verdict must include passing verification evidence.",
    );

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId: qaLane.id,
      authorAgentId: canonicalQaAgentId,
      authorUserId: null,
      body: [
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
        "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
        "[QA PASS]",
        "[RELEASE CONFIRMED]",
      ].join("\n"),
      createdAt: new Date("2026-04-10T13:00:00Z"),
      updatedAt: new Date("2026-04-10T13:00:00Z"),
    });

    const satisfied = await workflows.evaluateLaneCompletion(qaLane);
    expect(satisfied.canComplete).toBe(true);
  });

  it("requires workflow QA comment evidence to be refreshed after upstream invalidation", async () => {
    const companyId = await seedCompany("WorkflowQaFreshnessCo");
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    const qaAgentId = await seedAgent(companyId, "qa", "QA and Release Engineer");

    const qaLane = await svc.create(companyId, {
      title: "QA: Validate refreshed release",
      status: "in_review",
      priority: "high",
      assigneeAgentId: qaAgentId,
      qaReviewerAgentId: qaAgentId,
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
      workflowRequiredArtifacts: [
        {
          key: "qa-verdict",
          label: "QA verdict document",
          kind: "document",
          blocking: true,
          documentKey: "qa-verdict",
        },
      ],
      createdByUserId: "user-1",
    });

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId: qaLane.id,
      authorAgentId: qaAgentId,
      authorUserId: null,
      body: [
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
        "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
        "[QA PASS]",
        "[RELEASE CONFIRMED]",
      ].join("\n"),
      createdAt: new Date("2026-04-10T10:00:00Z"),
      updatedAt: new Date("2026-04-10T10:00:00Z"),
    });
    await db
      .update(issues)
      .set({ workflowInvalidatedAt: new Date("2026-04-10T11:00:00Z") })
      .where(eq(issues.id, qaLane.id));
    await attachIssueDocument({
      companyId,
      issueId: qaLane.id,
      key: "qa-verdict",
      title: "QA verdict",
      authorAgentId: qaAgentId,
      updatedAt: new Date("2026-04-10T12:00:00Z"),
    });

    const refreshedQaLane = await svc.getById(qaLane.id);
    const blocked = await workflows.evaluateLaneCompletion(refreshedQaLane!);

    expect(blocked.canComplete).toBe(false);
    expect(blocked.blockingReasons).toContain("Latest assigned QA verdict comment is stale and must be refreshed after upstream changes.");
  });

  it("blocks workflow QA lane completion when the lane owner is not an active QA reviewer", async () => {
    const companyId = await seedCompany("WorkflowQaOwnershipCo");
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    const canonicalQaAgentId = await seedAgent(companyId, "qa", "QA and Release Engineer");
    const engineerAgentId = await seedAgent(companyId, "engineer", "Engineer Agent");

    const qaLane = await svc.create(companyId, {
      title: "QA: Validate release ownership",
      status: "in_review",
      priority: "high",
      assigneeAgentId: engineerAgentId,
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
      workflowRequiredArtifacts: [
        {
          key: "qa-verdict",
          label: "QA verdict document",
          kind: "document",
          blocking: true,
          documentKey: "qa-verdict",
        },
      ],
      createdByUserId: "user-1",
    });

    await attachIssueDocument({
      companyId,
      issueId: qaLane.id,
      key: "qa-verdict",
      title: "QA verdict",
      authorAgentId: canonicalQaAgentId,
    });
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId: qaLane.id,
      authorAgentId: canonicalQaAgentId,
      authorUserId: null,
      body: [
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
        "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
        "[QA PASS]",
        "[RELEASE CONFIRMED]",
      ].join("\n"),
      createdAt: new Date("2026-04-10T10:00:00Z"),
      updatedAt: new Date("2026-04-10T10:00:00Z"),
    });

    const blocked = await workflows.evaluateLaneCompletion(qaLane);
    expect(blocked.canComplete).toBe(false);
    expect(blocked.blockingReasons[0]).toContain("active QA reviewer");
  });

  it("derives waiting versus actionable workflow summary buckets without treating downstream waiting lanes as current blockers", async () => {
    const companyId = await seedCompany("WorkflowSummaryCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    const pmAgentId = await seedAgent(companyId, "pm", "PM Agent");
    const designerAgentId = await seedAgent(companyId, "designer", "Designer Agent");
    const engineerAgentId = await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "security", "Security Agent");
    await seedAgent(companyId, "qa", "QA and Release Engineer");

    const rootIssue = await svc.create(companyId, {
      title: "Show waiting lanes separately",
      projectId,
      priority: "high",
      status: "todo",
      createdByUserId: "user-1",
    });

    const applied = await workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    });
    const laneByRole = new Map(
      applied.createdChildren.map((issue) => [issue.workflowLaneRole, issue]),
    );
    const pmLane = laneByRole.get("pm");
    const designerLane = laneByRole.get("designer");
    const engineerLane = laneByRole.get("engineer");
    const securityLane = laneByRole.get("security");
    const qaLane = laneByRole.get("qa");
    expect(pmLane && designerLane && engineerLane && securityLane && qaLane).toBeTruthy();

    await attachIssueDocument({
      companyId,
      issueId: pmLane!.id,
      key: "plan",
      title: "Plan",
      authorAgentId: pmAgentId,
    });
    await attachIssueDocument({
      companyId,
      issueId: designerLane!.id,
      key: "design",
      title: "Design",
      authorAgentId: designerAgentId,
    });

    await markLaneDoneAndPromote(pmLane!.id);
    await markLaneDoneAndPromote(designerLane!.id);

    const decoratedParent = await workflows.decorateIssue(applied.parentIssue);
    const workflowSummary = decoratedParent.workflowSummary;
    expect(workflowSummary?.activeRoles).toEqual(["engineer"]);
    expect(workflowSummary?.waitingRoles).toEqual(["security", "qa"]);
    expect(workflowSummary?.ownerNeededRoles).toEqual([]);
    expect(workflowSummary?.blockingReasons).toEqual(
      expect.arrayContaining(["ENGINEER: Implementation artifact is missing."]),
    );
    expect(workflowSummary?.blockingReasons.join("\n")).not.toContain("SECURITY:");
    expect(workflowSummary?.blockingReasons.join("\n")).not.toContain("QA:");
    expect(workflowSummary?.lanes.find((lane) => lane.role === "engineer")?.phase).toBe("ready");
    expect(workflowSummary?.lanes.find((lane) => lane.role === "security")?.phase).toBe("waiting");
    expect(workflowSummary?.lanes.find((lane) => lane.role === "qa")?.phase).toBe("waiting");
    expect(engineerLane?.assigneeAgentId).toBe(engineerAgentId);
  });

  it("promotes workflow dependents from blocked to todo when their final dependency becomes terminal", async () => {
    const companyId = await seedCompany("DependencyCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "security", "Security Agent");
    await seedAgent(companyId, "qa", "QA Agent");

    const rootIssue = await svc.create(companyId, {
      title: "Ship workflow dependency chain",
      projectId,
      priority: "high",
      status: "todo",
      createdByUserId: "user-1",
    });

    const applied = await workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    });
    const laneByRole = new Map(
      applied.createdChildren.map((issue) => [issue.workflowLaneRole, issue]),
    );
    const pmLane = laneByRole.get("pm");
    const designerLane = laneByRole.get("designer");
    expect(pmLane).toBeTruthy();
    expect(designerLane).toBeTruthy();

    await svc.update(pmLane!.id, { status: "done", completionGuardrailsSatisfied: true });
    const promoted = await workflows.advanceWorkflowDependents(pmLane!.id);

    expect(promoted.map((issue) => issue.id)).toEqual([designerLane!.id]);
    const refreshedDesignerLane = await svc.getById(designerLane!.id);
    expect(refreshedDesignerLane?.status).toBe("todo");
  });

  it("repairs missing workflow dependency relations before promoting dependents", async () => {
    const companyId = await seedCompany("WorkflowRepairPromotionCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "security", "Security Agent");
    await seedAgent(companyId, "qa", "QA and Release Engineer");

    const rootIssue = await svc.create(companyId, {
      title: "Repair graph before workflow promotion",
      projectId,
      priority: "high",
      status: "todo",
      createdByUserId: "user-1",
    });

    const applied = await workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    });
    const laneByRole = new Map(
      applied.createdChildren.map((issue) => [issue.workflowLaneRole, issue]),
    );
    const pmLane = laneByRole.get("pm");
    const designerLane = laneByRole.get("designer");
    expect(pmLane).toBeTruthy();
    expect(designerLane).toBeTruthy();

    await db
      .delete(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
        ),
      );

    await svc.update(pmLane!.id, { status: "done", completionGuardrailsSatisfied: true });
    const promoted = await workflows.advanceWorkflowDependents(pmLane!.id);

    expect(promoted.map((issue) => issue.id)).toEqual([designerLane!.id]);
    const refreshedDesignerLane = await svc.getById(designerLane!.id);
    expect(refreshedDesignerLane?.status).toBe("todo");

    const blockerRows = await db
      .select({
        blockerIssueId: issueRelations.issueId,
        blockedIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(blockerRows).toHaveLength(4);
  });

  it("hands back failing workflow QA to engineer and invalidates downstream lanes", async () => {
    const companyId = await seedCompany("HandbackCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    const engineerAgentId = await seedAgent(companyId, "engineer", "Engineer Agent");
    const securityAgentId = await seedAgent(companyId, "security", "Security Agent");
    const qaAgentId = await seedAgent(companyId, "qa", "QA and Release Engineer");

    const rootIssue = await svc.create(companyId, {
      title: "Ship cross-lane remediation",
      projectId,
      priority: "high",
      status: "todo",
      createdByUserId: "user-1",
    });

    const applied = await workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    });
    const laneByRole = new Map(
      applied.createdChildren.map((issue) => [issue.workflowLaneRole, issue]),
    );
    const pmLane = laneByRole.get("pm");
    const designerLane = laneByRole.get("designer");
    const engineerLane = laneByRole.get("engineer");
    const securityLane = laneByRole.get("security");
    const qaLane = laneByRole.get("qa");
    expect(pmLane && designerLane && engineerLane && securityLane && qaLane).toBeTruthy();

    await markLaneDoneAndPromote(pmLane!.id);
    await markLaneDoneAndPromote(designerLane!.id);
    await markLaneDoneAndPromote(engineerLane!.id);
    await svc.update(securityLane!.id, { status: "done", completionGuardrailsSatisfied: true });

    const handback = await workflows.handbackWorkflowLane(qaLane!.id);
    expect(handback?.targetIssue?.id).toBe(engineerLane!.id);

    const refreshedEngineer = await svc.getById(engineerLane!.id);
    const refreshedSecurity = await svc.getById(securityLane!.id);
    const refreshedQa = await svc.getById(qaLane!.id);

    expect(refreshedEngineer?.status).toBe("todo");
    expect(refreshedEngineer?.workflowInvalidatedAt).toBeTruthy();
    expect(refreshedEngineer?.assigneeAgentId).toBe(engineerAgentId);
    expect(refreshedSecurity?.status).toBe("blocked");
    expect(refreshedSecurity?.workflowInvalidatedAt).toBeTruthy();
    expect(refreshedSecurity?.assigneeAgentId).toBe(securityAgentId);
    expect(refreshedQa?.status).toBe("blocked");
    expect(refreshedQa?.workflowInvalidatedAt).toBeTruthy();
    expect(refreshedQa?.assigneeAgentId).toBe(qaAgentId);
  });

  it("marks invalidated workflow artifacts stale until they are refreshed", async () => {
    const companyId = await seedCompany("ArtifactStaleCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    const engineerAgentId = await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "security", "Security Agent");
    await seedAgent(companyId, "qa", "QA Agent");

    const rootIssue = await svc.create(companyId, {
      title: "Refresh stale workflow artifacts",
      projectId,
      priority: "high",
      status: "todo",
      createdByUserId: "user-1",
    });

    const applied = await workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    });
    const laneByRole = new Map(
      applied.createdChildren.map((issue) => [issue.workflowLaneRole, issue]),
    );
    const pmLane = laneByRole.get("pm");
    const designerLane = laneByRole.get("designer");
    const engineerLane = laneByRole.get("engineer");
    const securityLane = laneByRole.get("security");
    expect(pmLane && designerLane && engineerLane && securityLane).toBeTruthy();

    await markLaneDoneAndPromote(pmLane!.id);
    await markLaneDoneAndPromote(designerLane!.id);
    await markLaneDoneAndPromote(engineerLane!.id);

    await attachIssueDocument({
      companyId,
      issueId: engineerLane!.id,
      key: "implementation-summary",
      title: "Implementation summary",
      authorAgentId: engineerAgentId,
      updatedAt: new Date("2026-04-10T10:00:00Z"),
    });
    await attachIssueDocument({
      companyId,
      issueId: securityLane!.id,
      key: "threat-review",
      title: "Threat review",
      authorAgentId: engineerAgentId,
      updatedAt: new Date("2026-04-10T10:00:00Z"),
    });

    const invalidation = await workflows.invalidateWorkflowDescendants({
      issueId: engineerLane!.id,
      invalidateSelf: true,
    });
    const invalidatedEngineer = invalidation.invalidatedSelf;
    expect(invalidatedEngineer?.workflowInvalidatedAt).toBeTruthy();
    const refreshTimestamp = new Date(
      (invalidatedEngineer?.workflowInvalidatedAt ?? new Date()).getTime() + 60_000,
    );

    const staleEngineer = await workflows.decorateIssue(await svc.getById(engineerLane!.id) as NonNullable<Awaited<ReturnType<typeof svc.getById>>>);
    const staleSecurity = await workflows.decorateIssue(await svc.getById(securityLane!.id) as NonNullable<Awaited<ReturnType<typeof svc.getById>>>);
    expect(staleEngineer.workflowArtifactStatus?.[0]).toMatchObject({
      satisfied: false,
      stale: true,
    });
    expect(staleSecurity.workflowArtifactStatus?.[0]).toMatchObject({
      satisfied: false,
      stale: true,
    });

    await db.update(documents)
      .set({
        latestBody: "Refreshed implementation summary",
        updatedAt: refreshTimestamp,
      })
      .where(eq(documents.title, "Implementation summary"));

    const refreshedEngineer = await workflows.decorateIssue(await svc.getById(engineerLane!.id) as NonNullable<Awaited<ReturnType<typeof svc.getById>>>);
    expect(refreshedEngineer.workflowArtifactStatus?.[0]).toMatchObject({
      satisfied: true,
      stale: false,
      detail: null,
    });
  });

  it("rolls back parent metadata and child lanes when template application fails mid-flight", async () => {
    const companyId = await seedCompany("RollbackCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "security", "Security Agent");
    await seedAgent(companyId, "qa", "QA Agent");

    const rootIssue = await svc.create(companyId, {
      title: "Transactional workflow apply",
      projectId,
      priority: "medium",
      status: "todo",
      createdByUserId: "user-1",
    });

    let createCalls = 0;
    await expect(workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: async (data, dbOrTx) => {
        createCalls += 1;
        if (createCalls === 3) {
          throw new Error("simulated workflow lane failure");
        }
        return svc.create(companyId, data, dbOrTx);
      },
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    })).rejects.toThrow("simulated workflow lane failure");

    const reloadedParent = await svc.getById(rootIssue.id);
    expect(reloadedParent?.workflowTemplateKey ?? null).toBeNull();

    const persistedChildren = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.parentId, rootIssue.id));
    expect(persistedChildren).toHaveLength(0);
  });

  it("rejects template application when workflow lanes already exist under the parent", async () => {
    const companyId = await seedCompany("ConflictCo");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");

    const rootIssue = await svc.create(companyId, {
      title: "Existing workflow lane conflict",
      projectId,
      priority: "medium",
      status: "todo",
      createdByUserId: "user-1",
    });

    await svc.create(companyId, {
      title: "PM: Existing lane",
      projectId,
      parentId: rootIssue.id,
      priority: "medium",
      status: "todo",
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "pm",
      workflowRequiredArtifacts: [
        {
          key: "plan",
          label: "Plan document",
          kind: "document",
          blocking: true,
          documentKey: "plan",
        },
      ],
      createdByUserId: "user-1",
    });

    await expect(workflows.applyTemplate({
      companyId,
      templateKey: "engineering_delivery_v1",
      parentIssue: rootIssue,
      actorUserId: "user-1",
      createIssue: (data, dbOrTx) => svc.create(companyId, data, dbOrTx),
      updateIssue: (id, data, dbOrTx) => svc.update(id, data, dbOrTx),
    })).rejects.toThrow("Workflow lane issues already exist for this parent issue");

    const reloadedParent = await svc.getById(rootIssue.id);
    expect(reloadedParent?.workflowTemplateKey ?? null).toBeNull();
  });
});
