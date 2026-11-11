import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  environments,
  executionWorkspaces,
  instanceSettings,
  issues,
  principalPermissionGrants,
  projects,
} from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("issue execution-workspace fields under the isolated-workspaces gate", () => {
  const ctx = useEmbeddedPostgres("paperclip-issues-execution-workspace-gate-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(issues);
      await db.delete(executionWorkspaces);
      await db.delete(environments);
      await db.delete(projects);
      await db.delete(principalPermissionGrants);
      await db.delete(companyMemberships);
      await db.delete(companies);
      await db.delete(instanceSettings);
    },
  });

  async function seed(options: {
    isolatedWorkspaces: boolean;
    storeWorkspaceBinding?: boolean;
    storeIsolatedSettings?: boolean;
    storeSettings?: Record<string, unknown>;
    storeRuntimeBinding?: boolean;
    workspaceConfig?: Record<string, unknown>;
    seedEnvironment?: boolean;
  }) {
    await instanceSettingsService(ctx.db).updateExperimental({
      enableIsolatedWorkspaces: options.isolatedWorkspaces,
    });
    const company = await seedCompanyWithBoardAccess(ctx.db, "Workspace gate");
    const companyId = company.companyId;
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const workspaceId = randomUUID();
    const issueId = randomUUID();
    const environmentId = randomUUID();

    if (options.seedEnvironment) {
      await ctx.db.insert(environments).values({
        id: environmentId,
        name: `Env ${environmentId}`,
        driver: "ssh",
        status: "active",
      });
    }

    await ctx.db.insert(projects).values([
      { id: projectId, companyId, name: "Platform" },
      { id: otherProjectId, companyId, name: "Docs" },
    ]);
    await ctx.db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Platform workspace",
      ...(options.workspaceConfig
        ? { metadata: { config: options.workspaceConfig } }
        : {}),
    });
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Target the right repository",
      status: "todo",
      priority: "medium",
      ...(options.storeWorkspaceBinding ? { executionWorkspaceId: workspaceId } : {}),
      ...(options.storeIsolatedSettings
        ? {
          executionWorkspacePreference: "isolated_workspace" as const,
          executionWorkspaceSettings: { mode: "isolated_workspace" as const },
        }
        : {}),
      ...(options.storeRuntimeBinding
        ? {
          executionWorkspaceId: workspaceId,
          executionWorkspacePreference: "reuse_existing" as const,
          executionWorkspaceSettings: { mode: "shared_workspace" as const },
        }
        : {}),
      ...(options.storeSettings
        ? { executionWorkspaceSettings: options.storeSettings }
        : {}),
    });

    return { ...company, projectId, otherProjectId, workspaceId, issueId, environmentId };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  function patch(seeded: Seeded, body: Record<string, unknown>) {
    return request(routeApp(ctx.db, seeded.actor, issueRoutes))
      .patch(`/api/issues/${seeded.issueId}`)
      .send(body);
  }

  async function storedWorkspaceFields(seeded: Seeded) {
    const [row] = await ctx.db.select().from(issues).where(eq(issues.id, seeded.issueId));
    return {
      executionWorkspaceId: row?.executionWorkspaceId ?? null,
      executionWorkspacePreference: row?.executionWorkspacePreference ?? null,
      executionWorkspaceSettings: row?.executionWorkspaceSettings ?? null,
    };
  }

  async function storedWorkspaceConfig(seeded: Seeded) {
    const [row] = await ctx.db
      .select({ metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.workspaceId));
    const metadata = (row?.metadata ?? null) as Record<string, unknown> | null;
    return (metadata?.config ?? null) as Record<string, unknown> | null;
  }

  it("refuses an environment-only settings payload rather than erase stored settings", async () => {
    const seeded = await seed({
      isolatedWorkspaces: false,
      seedEnvironment: true,
      storeSettings: { networkEgress: { allowFqdns: ["registry.npmjs.org"], allowCidrs: [] } },
    });

    const res = await patch(seeded, {
      executionWorkspaceSettings: { environmentId: seeded.environmentId },
    });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("executionWorkspaceSettings");
    expect((await storedWorkspaceFields(seeded)).executionWorkspaceSettings).toMatchObject({
      networkEgress: { allowFqdns: ["registry.npmjs.org"] },
    });
  });

  it("refuses an empty settings blob over a stored isolated posture", async () => {
    const seeded = await seed({ isolatedWorkspaces: false, storeIsolatedSettings: true });

    const res = await patch(seeded, { executionWorkspaceSettings: {} });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("executionWorkspaceSettings");
    expect(await storedWorkspaceFields(seeded)).toMatchObject({
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });

  it("accepts an empty settings blob when the column already holds nothing", async () => {
    const seeded = await seed({ isolatedWorkspaces: false });

    const res = await patch(seeded, { executionWorkspaceSettings: {} });

    expect(res.status).toBe(200);
    expect(await storedWorkspaceFields(seeded)).toMatchObject({
      executionWorkspaceSettings: null,
    });
  });

  it("does not let a cleared settings payload erase the bound workspace's config", async () => {
    const seeded = await seed({
      isolatedWorkspaces: false,
      storeRuntimeBinding: true,
      workspaceConfig: {
        provisionCommand: "make setup",
        teardownCommand: "make teardown",
        cleanupCommand: "make clean",
      },
    });

    const res = await patch(seeded, { executionWorkspaceSettings: null });

    expect(res.status).toBe(200);
    expect(await storedWorkspaceFields(seeded)).toMatchObject({
      executionWorkspaceSettings: null,
    });
    expect(await storedWorkspaceConfig(seeded)).toMatchObject({
      provisionCommand: "make setup",
      teardownCommand: "make teardown",
      cleanupCommand: "make clean",
    });
  });

  it("refuses a workspace id it cannot persist, and the row is unchanged", async () => {
    const seeded = await seed({ isolatedWorkspaces: false });

    const res = await patch(seeded, { executionWorkspaceId: seeded.workspaceId });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("executionWorkspaceId");
    expect(await storedWorkspaceFields(seeded)).toMatchObject({ executionWorkspaceId: null });
  });

  it("names every refused field, not just the first", async () => {
    const seeded = await seed({ isolatedWorkspaces: false });

    const res = await patch(seeded, {
      executionWorkspaceId: seeded.workspaceId,
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    expect(res.status).toBe(422);
    const body = JSON.stringify(res.body);
    expect(body).toContain("executionWorkspaceId");
    expect(body).toContain("executionWorkspacePreference");
    expect(body).toContain("executionWorkspaceSettings");
  });

  it("refuses a settings payload the gate would strip", async () => {
    const seeded = await seed({ isolatedWorkspaces: false });

    const res = await patch(seeded, {
      executionWorkspaceSettings: {
        mode: "shared_workspace",
        workspaceStrategy: { type: "git_worktree" },
      },
    });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("executionWorkspaceSettings");
  });

  it("refuses a preference the gate cannot honour", async () => {
    const seeded = await seed({ isolatedWorkspaces: false });

    const res = await patch(seeded, { executionWorkspacePreference: "reuse_existing" });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("executionWorkspacePreference");
  });

  it("accepts the project picker's body, and the project move takes", async () => {
    const seeded = await seed({ isolatedWorkspaces: false });

    const res = await patch(seeded, {
      projectId: seeded.otherProjectId,
      executionWorkspaceId: null,
      executionWorkspacePreference: "shared_workspace",
      executionWorkspaceSettings: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe(seeded.otherProjectId);
  });

  it("accepts a settings payload that normalizes to what is already stored", async () => {
    const seeded = await seed({ isolatedWorkspaces: false });

    const res = await patch(seeded, { title: "Renamed", executionWorkspaceSettings: {} });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Renamed");
  });

  it("accepts re-sent stored values, and applies the rest of the body", async () => {
    const seeded = await seed({ isolatedWorkspaces: false });

    const res = await patch(seeded, {
      projectId: seeded.otherProjectId,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe(seeded.otherProjectId);
  });

  it("accepts a bare shared_workspace settings blob", async () => {
    const seeded = await seed({ isolatedWorkspaces: false });

    const res = await patch(seeded, {
      projectId: seeded.otherProjectId,
      executionWorkspaceSettings: { mode: "shared_workspace" },
    });

    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe(seeded.otherProjectId);
  });

  it("accepts a re-sent non-null workspace id the row already holds", async () => {
    const seeded = await seed({ isolatedWorkspaces: false, storeWorkspaceBinding: true });

    const res = await patch(seeded, {
      title: "Renamed",
      executionWorkspaceId: seeded.workspaceId,
    });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Renamed");
    expect(await storedWorkspaceFields(seeded)).toMatchObject({
      executionWorkspaceId: seeded.workspaceId,
    });
  });

  it("accepts the picker's body against a row the runtime already bound", async () => {
    const seeded = await seed({ isolatedWorkspaces: false, storeWorkspaceBinding: true });

    const res = await patch(seeded, {
      title: "Renamed",
      executionWorkspaceId: null,
      executionWorkspacePreference: "shared_workspace",
      executionWorkspaceSettings: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Renamed");
  });

  it("lets a runtime-bound task move project, clearing the stale binding", async () => {
    const seeded = await seed({ isolatedWorkspaces: false, storeWorkspaceBinding: true });

    const res = await patch(seeded, {
      projectId: seeded.otherProjectId,
      executionWorkspaceId: null,
      executionWorkspacePreference: "shared_workspace",
      executionWorkspaceSettings: null,
    });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("isolated_workspaces_disabled");
    expect(res.body.projectId).toBe(seeded.otherProjectId);
    expect(await storedWorkspaceFields(seeded)).toMatchObject({
      executionWorkspaceId: null,
    });
  });

  it("persists a downgrade of both the preference and the settings blob", async () => {
    const seeded = await seed({ isolatedWorkspaces: false, storeIsolatedSettings: true });

    const res = await patch(seeded, {
      executionWorkspacePreference: "shared_workspace",
      executionWorkspaceSettings: { mode: "shared_workspace" },
    });

    expect(res.status).toBe(200);
    expect(res.body.changes).toHaveProperty("executionWorkspaceSettings");
    expect(await storedWorkspaceFields(seeded)).toMatchObject({
      executionWorkspacePreference: "shared_workspace",
      executionWorkspaceSettings: { mode: "shared_workspace" },
    });
  });

  it("persists a cleared settings blob over a stored isolated posture", async () => {
    const seeded = await seed({ isolatedWorkspaces: false, storeIsolatedSettings: true });

    const res = await patch(seeded, { executionWorkspaceSettings: null });

    expect(res.status).toBe(200);
    expect(await storedWorkspaceFields(seeded)).toMatchObject({
      executionWorkspaceSettings: null,
    });
  });

  it("persists a network-egress settings blob the gate still honours", async () => {
    const seeded = await seed({ isolatedWorkspaces: false });

    const res = await patch(seeded, {
      executionWorkspaceSettings: {
        mode: "shared_workspace",
        networkEgress: { allowFqdns: ["registry.npmjs.org"], allowCidrs: [] },
      },
    });

    expect(res.status).toBe(200);
    expect((await storedWorkspaceFields(seeded)).executionWorkspaceSettings).toMatchObject({
      mode: "shared_workspace",
      networkEgress: { allowFqdns: ["registry.npmjs.org"] },
    });
  });

  it("persists a settings downgrade without touching the bound workspace's config", async () => {
    const seeded = await seed({
      isolatedWorkspaces: false,
      storeRuntimeBinding: true,
      workspaceConfig: {
        provisionCommand: "make setup",
        teardownCommand: "make teardown",
        cleanupCommand: "make clean",
      },
    });

    const res = await patch(seeded, { executionWorkspaceSettings: { mode: "shared_workspace" } });

    expect(res.status).toBe(200);
    expect(await storedWorkspaceFields(seeded)).toMatchObject({
      executionWorkspaceSettings: { mode: "shared_workspace" },
    });
    expect(await storedWorkspaceConfig(seeded)).toMatchObject({
      provisionCommand: "make setup",
      teardownCommand: "make teardown",
      cleanupCommand: "make clean",
    });
  });

  it("persists a cleared workspace binding instead of dropping the null", async () => {
    const seeded = await seed({ isolatedWorkspaces: false, storeWorkspaceBinding: true });

    const res = await patch(seeded, { executionWorkspaceId: null });

    expect(res.status).toBe(200);
    expect(await storedWorkspaceFields(seeded)).toMatchObject({
      executionWorkspaceId: null,
    });
  });

  it("does not refuse an environment-only settings payload as a gate violation", async () => {
    const seeded = await seed({ isolatedWorkspaces: false });

    const res = await patch(seeded, {
      title: "Renamed",
      executionWorkspaceSettings: { environmentId: randomUUID() },
    });

    expect(JSON.stringify(res.body)).not.toContain("isolated_workspaces_disabled");
  });

  it("leaves a PATCH that names none of the gated fields alone", async () => {
    const seeded = await seed({ isolatedWorkspaces: false });

    const res = await patch(seeded, { title: "Renamed" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Renamed");
  });

  it("persists the workspace id when the gate is on, and reports it in changes", async () => {
    const seeded = await seed({ isolatedWorkspaces: true });

    const res = await patch(seeded, { executionWorkspaceId: seeded.workspaceId });

    expect(res.status).toBe(200);
    expect(res.body.executionWorkspaceId).toBe(seeded.workspaceId);
    expect(res.body.changes).toHaveProperty("executionWorkspaceId");
    expect(await storedWorkspaceFields(seeded)).toMatchObject({
      executionWorkspaceId: seeded.workspaceId,
    });
  });
});
