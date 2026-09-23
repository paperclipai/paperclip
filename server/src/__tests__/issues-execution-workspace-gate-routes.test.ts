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
   * A bare `{ mode: "shared_workspace" }` is the gate's own posture expressed in
   * the settings blob, and the picker posts exactly it for a project that has an
   * execution-workspace policy configured. It is honoured — but only bare: the
   * next case shows the same mode stops being honourable the moment the blob
   * also carries something the gate cannot deliver.
   */
  it("accepts a bare shared_workspace settings blob", async () => {
    const seeded = await seed({ isolatedWorkspaces: false });

    const res = await patch(seeded, {
      projectId: seeded.otherProjectId,
      executionWorkspaceSettings: { mode: "shared_workspace" },
    });

    expect(res.status).toBe(200);
    expect(res.body.projectId).toBe(seeded.otherProjectId);
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
   * The picker again, but against a row that already carries a workspace the
   * runtime bound past the strip — `heartbeat.ts` patches `executionWorkspaceId`
   * through `issuesSvc.update` with `bindRuntimeSharedWorkspace`, so *any* task
   * that has run once holds one, gate or no gate. An earlier revision of this
   * guard refused `executionWorkspaceId: null` whenever the row held an id,
   * which meant a task could be moved between projects only until the first
   * time it ran. Null is the gate's baseline and is honoured regardless of what
   * the row holds.
   */
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

  /**
   * The same body *with* a project change is still refused — but by
   * "Execution workspace must belong to the selected project", a validation that
   * predates this guard and fires on the binding left in the row. Pinned so the
   * distinction stays visible: this guard must not be what refuses it, or a
   * later reader would read the 422 as the gate check being over-broad and
   * loosen the wrong code. That a runtime-bound task cannot be moved between
   * projects while the gate is off is pre-existing and out of scope here.
   */
  it("is not the reason a project move with a stale binding is refused", async () => {
    const seeded = await seed({ isolatedWorkspaces: false, storeWorkspaceBinding: true });

    const res = await patch(seeded, {
      projectId: seeded.otherProjectId,
      executionWorkspaceId: null,
      executionWorkspacePreference: "shared_workspace",
      executionWorkspaceSettings: null,
    });

    expect(JSON.stringify(res.body)).not.toContain("isolated_workspaces_disabled");
  });

  /**
   * Selecting an issue environment travels inside the settings blob and is a
   * different feature behind a different flag. The parse drops `environmentId`
   * (the service does not pass `includeEnvironmentId`) and returns `{}` rather
   * than `null`, so an earlier revision compared `{}` against a stored `null`,
   * decided they differed, and refused environment selection as an
   * isolated-workspaces violation.
   *
   * The id here is not seeded, so the request still fails on "Environment not
   * found" — which is the point: the refusal must come from environment
   * validation downstream, never from this guard.
   */
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
