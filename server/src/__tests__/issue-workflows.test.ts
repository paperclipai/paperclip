import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documents,
  instanceSettings,
  issueComments,
  issueDocuments,
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

  async function seedAgent(companyId: string, role: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role,
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
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
    expect(applied.createdChildren.every((issue) => issue.parentId === rootIssue.id)).toBe(true);
    expect(applied.createdChildren.every((issue) => issue.projectId === projectId)).toBe(true);
    expect(applied.createdChildren.every((issue) => (issue.workflowRequiredArtifacts?.length ?? 0) > 0)).toBe(true);

    const isolatedLaneRoles = applied.createdChildren
      .filter((issue) => issue.executionWorkspacePreference === "isolated_workspace")
      .map((issue) => issue.workflowLaneRole);
    expect(isolatedLaneRoles).toEqual(["engineer", "security", "qa"]);

    const decoratedParent = await workflows.decorateIssue(applied.parentIssue);
    expect(decoratedParent.workflowSummary?.lanes).toHaveLength(5);
  });

  it("surfaces unresolved security ownership when no security specialist exists", async () => {
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

    const securityLane = applied.createdChildren.find((issue) => issue.workflowLaneRole === "security");
    expect(securityLane?.assigneeAgentId ?? null).toBeNull();

    const decoratedParent = await workflows.decorateIssue(applied.parentIssue);
    const securitySummary = decoratedParent.workflowSummary?.lanes.find((lane) => lane.role === "security");
    expect(securitySummary?.unresolvedOwnership).toBe(true);
    expect(securitySummary?.blockingReasons).toContain("Lane has no assigned owner.");
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
