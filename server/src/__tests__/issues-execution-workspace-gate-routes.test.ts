import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
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

/**
 * `PATCH /api/issues/:id` advertises `executionWorkspaceId`,
 * `executionWorkspacePreference` and `executionWorkspaceSettings`, but
 * `issueService.update` deletes all three while the `enableIsolatedWorkspaces`
 * instance gate is off. The request used to answer 200 with an empty `changes`
 * receipt, which reads as success — a caller only discovers the value never
 * landed by re-reading the record.
 *
 * These tests pin the two halves of the contract: a request that the gate
 * cannot honour is refused and names the field, and a request the gate *can*
 * honour still persists. Every "refused" case re-reads the row, because
 * asserting on the response status alone is exactly the check that passed while
 * the behaviour was broken.
 */
describeEmbeddedPostgres("issue execution-workspace fields under the isolated-workspaces gate", () => {
  const ctx = useEmbeddedPostgres("paperclip-issues-execution-workspace-gate-", {
    resetEach: async (db) => {
      // `resetCompanyIssueFixtures` covers only issues/grants/memberships/
      // companies. This suite also seeds projects, an execution workspace and
      // the instance settings row, and every PATCH writes an activity row that
      // holds a company reference — so the shared helper cannot be reused.
      await db.delete(activityLog);
      await db.delete(issues);
      await db.delete(executionWorkspaces);
      await db.delete(projects);
      await db.delete(principalPermissionGrants);
      await db.delete(companyMemberships);
      await db.delete(companies);
      await db.delete(instanceSettings);
    },
  });

  async function seed(options: { isolatedWorkspaces: boolean; storeWorkspaceBinding?: boolean }) {
    await instanceSettingsService(ctx.db).updateExperimental({
      enableIsolatedWorkspaces: options.isolatedWorkspaces,
    });
    const company = await seedCompanyWithBoardAccess(ctx.db, "Workspace gate");
    const companyId = company.companyId;
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const workspaceId = randomUUID();
    const issueId = randomUUID();

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
    });
    await ctx.db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Target the right repository",
      status: "todo",
      priority: "medium",
      // Written straight to the row, so a row can already carry the fields the
      // gate refuses to *change* — the state left behind by an instance that
      // once ran with the gate on.
      ...(options.storeWorkspaceBinding ? { executionWorkspaceId: workspaceId } : {}),
    });

    return { ...company, projectId, otherProjectId, workspaceId, issueId };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  function patch(seeded: Seeded, body: Record<string, unknown>) {
    return request(routeApp(ctx.db, seeded.actor, issueRoutes))
      .patch(`/api/issues/${seeded.issueId}`)
      .send(body);
  }

  /** Reads straight from the row, so no route-layer shaping can mask a drop. */
  async function storedWorkspaceFields(seeded: Seeded) {
    const [row] = await ctx.db.select().from(issues).where(eq(issues.id, seeded.issueId));
    return {
      executionWorkspaceId: row?.executionWorkspaceId ?? null,
      executionWorkspacePreference: row?.executionWorkspacePreference ?? null,
      executionWorkspaceSettings: row?.executionWorkspaceSettings ?? null,
    };
  }

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

  /**
   * The regression guard for the refusal's blast radius. The project picker
   * posts all three keys on *every* project change, not just when a workspace is
   * being chosen, and for a project with no execution-workspace policy
   * `defaultExecutionWorkspaceModeForProject` falls through to
   * `shared_workspace`. Refusing that body would make moving a task between
   * projects fail with a 422 on a default-configured instance — a far worse
   * regression than the bug being fixed.
   */
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

  /**
   * `{}` is what a settings builder produces when every field is left unset.
   * `parseIssueExecutionWorkspaceSettings` collapses it to `null`, so it would
   * store exactly what is already there — comparing the raw body instead would
   * refuse a write that changes nothing.
   */
  it("accepts a settings payload that normalizes to what is already stored", async () => {
    const seeded = await seed({ isolatedWorkspaces: false });

    const res = await patch(seeded, { title: "Renamed", executionWorkspaceSettings: {} });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Renamed");
  });

  /**
   * The round-trip shape: a client GETs an issue, changes one unrelated field
   * and PATCHes the whole object back, so all three keys ride along carrying the
   * values already in the row. Nothing is being asked to change, so the strip
   * swallows nothing and the request is an honest 200 — refusing it would break
   * every full-object client on a default-configured instance.
   */
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

  /**
   * `shared_workspace` is allowed as the gate's own posture, but that allowance
   * is scoped to the preference. A mode carried in the settings blob still has
   * to match the row, because the blob also carries strategy and egress keys the
   * gate has no way to honour.
   */
  it("does not extend the shared_workspace allowance to the settings blob", async () => {
    const seeded = await seed({ isolatedWorkspaces: false });

    const res = await patch(seeded, {
      executionWorkspaceSettings: { mode: "shared_workspace" },
    });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("executionWorkspaceSettings");
  });

  /**
   * The same round-trip against a row that already carries a workspace binding —
   * the state an instance is left in after the gate is switched back off. The
   * value is unchanged, so it is honourable even though it is non-null.
   */
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

  /**
   * ...and the mirror image: with a binding already stored, clearing it *is* a
   * change, so it is refused rather than silently ignored.
   */
  it("refuses clearing a stored workspace id, and the binding survives", async () => {
    const seeded = await seed({ isolatedWorkspaces: false, storeWorkspaceBinding: true });

    const res = await patch(seeded, { executionWorkspaceId: null });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("executionWorkspaceId");
    expect(await storedWorkspaceFields(seeded)).toMatchObject({
      executionWorkspaceId: seeded.workspaceId,
    });
  });

  it("leaves a PATCH that names none of the gated fields alone", async () => {
    const seeded = await seed({ isolatedWorkspaces: false });

    const res = await patch(seeded, { title: "Renamed" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Renamed");
  });

  /**
   * The half that proves the refusal is scoped to the gate rather than being a
   * blanket ban: with the feature on, the same request persists and the change
   * receipt reports it.
   */
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
