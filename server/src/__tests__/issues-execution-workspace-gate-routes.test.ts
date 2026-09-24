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
    /**
     * A settings blob written straight to the issue row, for the cases that
     * assert a patch does not *destroy* stored settings. `storeIsolatedSettings`
     * cannot serve those: it writes a blob the gate refuses to change, so the
     * request never reaches the write being tested.
     */
    storeSettings?: Record<string, unknown>;
    /** Leaves the row in the shape `bindRuntimeSharedWorkspace` writes. */
    storeRuntimeBinding?: boolean;
    /** Config on the bound workspace's own row, which the issue patch can reach. */
    workspaceConfig?: Record<string, unknown>;
    /**
     * Seeds a real environment and returns its id. Without one, an
     * environment-carrying patch is refused by `assertEnvironmentSelectionForCompany`
     * before it ever reaches the write under test, and the assertion would pass
     * for the wrong reason.
     */
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
        // `assertEnvironmentSelectionForCompany` allows local/ssh/sandbox, and
        // "local" carries a unique index that would collide across cases.
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
      // Written straight to the row, so a row can already carry the fields the
      // gate refuses to *change* — the state left behind by an instance that
      // once ran with the gate on.
      ...(options.storeWorkspaceBinding ? { executionWorkspaceId: workspaceId } : {}),
      // The state an instance is left in when the gate is switched off after
      // tasks were already configured under it.
      ...(options.storeIsolatedSettings
        ? {
          executionWorkspacePreference: "isolated_workspace" as const,
          executionWorkspaceSettings: { mode: "isolated_workspace" as const },
        }
        : {}),
      // The shape `bindRuntimeSharedWorkspace` leaves behind: the runtime writes
      // these past the gate, so any task that has run once holds them.
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

  /** Reads straight from the row, so no route-layer shaping can mask a drop. */
  async function storedWorkspaceFields(seeded: Seeded) {
    const [row] = await ctx.db.select().from(issues).where(eq(issues.id, seeded.issueId));
    return {
      executionWorkspaceId: row?.executionWorkspaceId ?? null,
      executionWorkspacePreference: row?.executionWorkspacePreference ?? null,
      executionWorkspaceSettings: row?.executionWorkspaceSettings ?? null,
    };
  }

  /** Reads the bound workspace's own config, which an issue patch can reach. */
  async function storedWorkspaceConfig(seeded: Seeded) {
    const [row] = await ctx.db
      .select({ metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.workspaceId));
    const metadata = (row?.metadata ?? null) as Record<string, unknown> | null;
    return (metadata?.config ?? null) as Record<string, unknown> | null;
  }

  /**
   * Persisting a gate-baseline settings value must not become a way to erase
   * configuration the gate never governed.
   *
   * `{ environmentId }` is issue environment selection — a different feature
   * behind a different flag. `parseIssueExecutionWorkspaceSettings` drops
   * `environmentId` when called the way `update()` calls it, so the blob
   * normalizes to nothing and reads as a baseline value. If that is written, the
   * column is overwritten with `{}` and whatever it held — `networkEgress` here,
   * which is honoured with the gate off — is gone. The blob carries no gated
   * content, so the gate has no business either refusing it or rewriting the
   * column over it.
   */
  it("does not let an environment-only settings payload erase stored settings", async () => {
    const seeded = await seed({
      isolatedWorkspaces: false,
      seedEnvironment: true,
      storeSettings: { networkEgress: { allowFqdns: ["registry.npmjs.org"], allowCidrs: [] } },
    });

    const res = await patch(seeded, {
      executionWorkspaceSettings: { environmentId: seeded.environmentId },
    });

    expect(res.status).toBe(200);
    expect((await storedWorkspaceFields(seeded)).executionWorkspaceSettings).toMatchObject({
      networkEgress: { allowFqdns: ["registry.npmjs.org"] },
    });
  });

  /**
   * The same rule, one layer further out. On a row the runtime bound
   * (`executionWorkspaceId` + `reuse_existing`), a settings write is propagated
   * to the bound workspace's own config row. The patch builder emits an explicit
   * `null` for every config key it knows, so propagating a *baseline* settings
   * value erases the workspace's `provisionCommand`, `teardownCommand`,
   * `environmentId` and `workspaceRuntime` — configuration that belongs to the
   * workspace and that the caller never mentioned.
   *
   * Any task that has run once holds this row shape, so this is the common case,
   * not a corner. `cleanupCommand` is deliberately asserted too: the builder
   * omits it, so it survives, and its survival is what distinguishes "the sync
   * fired and erased the rest" from "the workspace was never touched".
   */
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
   * The picker's full body against a runtime-bound row, which used to be
   * unmovable. The blanket strip deleted the `executionWorkspaceId: null`, so
   * `update()` fell back to the id already in the row
   * (`issueData.executionWorkspaceId !== undefined ? … : existing.…`) and
   * `assertValidExecutionWorkspace` refused the move with "Execution workspace
   * must belong to the selected project" — a workspace of the *old* project.
   * Any task that had run once was stuck in its project.
   *
   * Letting the baseline null survive the strip clears the binding in the same
   * patch, so the ownership check has nothing stale to object to. The re-read
   * proves both halves: the project moved *and* the binding is gone.
   */
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

  /**
   * A downgrade is a real change, and the row is left holding isolated values
   * whenever the gate is switched off after tasks were configured under it. The
   * blanket strip swallowed the downgrade and answered 200, so the task kept
   * running isolated with the feature supposedly disabled and the API insisting
   * the change had been accepted.
   *
   * Refusing it instead would be no better: the project picker posts exactly
   * this body on every project change. So the preference — a scalar that only
   * ever *removes* configuration — is written, and the re-read proves it.
   *
   * `executionWorkspaceSettings` is the deliberate exception, asserted here so
   * the limit is pinned rather than only described. Writing a baseline settings
   * blob overwrites the column and can erase the bound workspace's own
   * provisioning config, which two tests above prove; the conservative drop is
   * chosen over a write that destroys configuration the caller never named. The
   * field that actually unsticks a task, `executionWorkspaceId`, does persist.
   */
  it("persists a preference downgrade but still drops the settings blob", async () => {
    const seeded = await seed({ isolatedWorkspaces: false, storeIsolatedSettings: true });

    const res = await patch(seeded, {
      executionWorkspacePreference: "shared_workspace",
      executionWorkspaceSettings: { mode: "shared_workspace" },
    });

    expect(res.status).toBe(200);
    expect(await storedWorkspaceFields(seeded)).toMatchObject({
      executionWorkspacePreference: "shared_workspace",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });

  /**
   * The clearing direction, against the binding the runtime writes past the gate
   * (`bindRuntimeSharedWorkspace`). Clearing it never worked: the strip dropped
   * the null, so the task stayed pointed at a workspace — after a project move,
   * one belonging to the *previous* project — while the response reported
   * success. The re-read is the whole point of this test.
   */
  it("persists a cleared workspace binding instead of dropping the null", async () => {
    const seeded = await seed({ isolatedWorkspaces: false, storeWorkspaceBinding: true });

    const res = await patch(seeded, { executionWorkspaceId: null });

    expect(res.status).toBe(200);
    expect(await storedWorkspaceFields(seeded)).toMatchObject({
      executionWorkspaceId: null,
    });
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
