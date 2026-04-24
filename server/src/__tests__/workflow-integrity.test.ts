import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  instanceSettings,
  issueRelations,
  issueWorkflowInstances,
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
import { workflowIntegrityService } from "../services/workflow-integrity.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workflowIntegrityScriptPath = fileURLToPath(
  new URL("../../scripts/reconcile-workflow-integrity.ts", import.meta.url),
);
const tsxBinary = fileURLToPath(
  new URL(
    process.platform === "win32" ? "../../node_modules/.bin/tsx.cmd" : "../../node_modules/.bin/tsx",
    import.meta.url,
  ),
);

describeEmbeddedPostgres("workflow integrity service", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let workflows!: ReturnType<typeof issueWorkflowService>;
  let settings!: ReturnType<typeof instanceSettingsService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-integrity-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    workflows = issueWorkflowService(db);
    settings = instanceSettingsService(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(issueWorkflowInstances);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Workflow Integrity Co") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `WI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedProject(companyId: string) {
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workflow Integrity Project",
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

  async function createStaleWorkflowRoot() {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "security", "Security Agent");
    await seedAgent(companyId, "qa", "QA and Release Engineer");

    const rootIssue = await svc.create(companyId, {
      title: "Repair stale workflow root",
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

    return {
      companyId,
      rootIssue,
      downstreamLaneIds,
      qaLaneId: laneByRole.get("qa")?.id ?? null,
    };
  }

  it("inspects workflow roots with drifted dependency relations and lane statuses", async () => {
    const { rootIssue } = await createStaleWorkflowRoot();

    const inspection = await workflowIntegrityService(db).inspect();

    expect(inspection.brokenWorkflowRoots.count).toBe(1);
    expect(inspection.brokenWorkflowRoots.roots).toHaveLength(1);
    expect(inspection.brokenWorkflowRoots.roots[0]).toMatchObject({
      rootIssueId: rootIssue.id,
      identifier: rootIssue.identifier,
      missingDependencyRelationCount: 4,
      laneStatusDriftCount: 4,
    });
  });

  it("repairs stale workflow roots in one reconcile sweep", async () => {
    const { companyId, rootIssue, qaLaneId } = await createStaleWorkflowRoot();

    const result = await workflowIntegrityService(db).reconcileAll();

    expect(result.workflowRootsRepaired).toBe(1);
    expect(result.dependencyRelationsRepaired).toBe(4);
    expect(result.laneStatusesNormalized).toBe(4);
    expect(result.repairedRootIssueIds).toEqual([rootIssue.id]);

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

    const qaLane = qaLaneId ? await svc.getById(qaLaneId) : null;
    expect(qaLane?.status).toBe("blocked");
  });

  it("ignores hidden workflow roots during inspection and reconciliation", async () => {
    const { companyId, rootIssue } = await createStaleWorkflowRoot();
    await db.update(issues).set({ hiddenAt: new Date("2026-04-20T12:00:00.000Z") }).where(eq(issues.id, rootIssue.id));

    const inspection = await workflowIntegrityService(db).inspect();
    expect(inspection.brokenWorkflowRoots.count).toBe(0);

    const result = await workflowIntegrityService(db).reconcileAll();
    expect(result.workflowRootsRepaired).toBe(0);
    expect(result.dependencyRelationsRepaired).toBe(0);
    expect(result.laneStatusesNormalized).toBe(0);

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
    expect(blockerRows).toHaveLength(0);
  });

  it("counts only changed dependency edges when a lane has an extra stale blocker relation", async () => {
    const companyId = await seedCompany("Workflow Integrity Edge Count Co");
    const projectId = await seedProject(companyId);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    await seedAgent(companyId, "pm", "PM Agent");
    await seedAgent(companyId, "designer", "Designer Agent");
    await seedAgent(companyId, "engineer", "Engineer Agent");
    await seedAgent(companyId, "security", "Security Agent");
    await seedAgent(companyId, "qa", "QA and Release Engineer");

    const rootIssue = await svc.create(companyId, {
      title: "Count exact workflow dependency drift",
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
      applied.createdChildren.map((issue) => [issue.workflowLaneRole, issue.id]),
    );

    await db.insert(issueRelations).values({
      companyId,
      issueId: laneByRole.get("pm")!,
      relatedIssueId: laneByRole.get("qa")!,
      type: "blocks",
      createdByAgentId: null,
      createdByUserId: null,
    });

    const inspection = await workflowIntegrityService(db).inspect();
    expect(inspection.brokenWorkflowRoots.count).toBe(1);
    expect(inspection.brokenWorkflowRoots.roots[0]).toMatchObject({
      rootIssueId: rootIssue.id,
      missingDependencyRelationCount: 1,
      laneStatusDriftCount: 0,
    });

    const result = await workflowIntegrityService(db).reconcileAll();
    expect(result.workflowRootsRepaired).toBe(1);
    expect(result.dependencyRelationsRepaired).toBe(1);
    expect(result.laneStatusesNormalized).toBe(0);
  });

  it("emits parseable JSON from the workflow integrity reconcile script", async () => {
    const { companyId, rootIssue, qaLaneId } = await createStaleWorkflowRoot();
    const databaseUrl = tempDb?.connectionString;
    expect(databaseUrl).toBeTruthy();

    const dryRun = spawnSync(
      tsxBinary,
      [workflowIntegrityScriptPath, "--json"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
        },
        encoding: "utf8",
      },
    );
    expect(dryRun.status).toBe(0);
    const dryRunPayload = JSON.parse(dryRun.stdout.trim()) as {
      mode: string;
      brokenWorkflowRoots: {
        count: number;
        roots: Array<{ rootIssueId: string }>;
      };
    };
    expect(dryRunPayload).toMatchObject({
      mode: "dry-run",
      brokenWorkflowRoots: {
        count: 1,
      },
    });
    expect(dryRunPayload.brokenWorkflowRoots.roots[0]?.rootIssueId).toBe(rootIssue.id);

    const applyRun = spawnSync(
      tsxBinary,
      [workflowIntegrityScriptPath, "--apply", "--json"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
        },
        encoding: "utf8",
      },
    );
    expect(applyRun.status).toBe(0);
    const applyPayload = JSON.parse(applyRun.stdout.trim()) as {
      mode: string;
      workflowRootsRepaired: number;
      dependencyRelationsRepaired: number;
      laneStatusesNormalized: number;
      repairedRootIssueIds: string[];
    };
    expect(applyPayload).toMatchObject({
      mode: "apply",
      workflowRootsRepaired: 1,
      dependencyRelationsRepaired: 4,
      laneStatusesNormalized: 4,
      repairedRootIssueIds: [rootIssue.id],
    });

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

    const qaLane = qaLaneId ? await svc.getById(qaLaneId) : null;
    expect(qaLane?.status).toBe("blocked");
  }, 20_000);
});
