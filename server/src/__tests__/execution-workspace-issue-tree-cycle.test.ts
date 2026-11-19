import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, agents, companies, createDb, executionWorkspaces, issues, projects, type Db } from "@paperclipai/db";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ISSUE_TREE_CYCLE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const DAY = 86_400_000;
const SWEEP_GUARD_TIMEOUT_MS = 20_000;

(support.supported ? describe : describe.skip)("issue tree cycle guard", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("issue-tree-cycle-");
    if (external) await applyPendingMigrations(external);
    const url = external ?? temporary!.connectionString;
    db = createDb(url);
    db.$client.options.onnotice = () => {};
  }, 120_000);
  afterEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  const old = () => new Date(Date.now() - 10 * DAY);

  async function seedCompany() {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cycle", issuePrefix: `C${companyId.slice(0, 5).toUpperCase()}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "in_progress" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "idle", adapterType: "process" });
    return { companyId, projectId, agentId };
  }

  async function seedIssue(input: {
    companyId: string;
    projectId: string;
    parentId?: string | null;
    status?: "done" | "todo";
    poisoned?: boolean;
  }) {
    const id = randomUUID();
    const at = old();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      projectId: input.projectId,
      parentId: input.poisoned ? id : input.parentId ?? null,
      title: `Issue ${id.slice(0, 6)}`,
      status: input.status ?? "done",
      completedAt: (input.status ?? "done") === "done" ? at : null,
      updatedAt: at,
    });
    return id;
  }

  async function seedWorkspace(input: { companyId: string; projectId: string; sourceIssueId: string }) {
    const id = randomUUID();
    const at = old();
    await db.insert(executionWorkspaces).values({
      id,
      companyId: input.companyId,
      projectId: input.projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: id,
      status: "active",
      providerType: "local_fs",
      cwd: `/missing/${id}`,
      createdAt: at,
      updatedAt: at,
    });
    await db.update(executionWorkspaces).set({ sourceIssueId: input.sourceIssueId, updatedAt: at }).where(eq(executionWorkspaces.id, id));
    return id;
  }

  function service() {
    return executionWorkspaceService(db, {
      workspaceReaperCooldownDays: 1,
      inspectGitCloseReadiness: async () => ({
        statusInspectionSucceeded: true,
        warnings: [],
        git: {
          repoRoot: null, workspacePath: "/missing", branchName: null, baseRef: null,
          hasDirtyTrackedFiles: false, hasUntrackedFiles: false, dirtyEntryCount: 0, untrackedEntryCount: 0,
          aheadCount: 0, behindCount: 0, isMergedIntoBase: true, createdByRuntime: false,
        },
      }),
    });
  }

  async function workspaceStatus(id: string) {
    const [row] = await db.select({ status: executionWorkspaces.status }).from(executionWorkspaces).where(eq(executionWorkspaces.id, id));
    return row!.status;
  }

  it("the unguarded UNION ALL walk spins on a self-parent tree; the guarded walk returns", async () => {
    const { companyId, projectId } = await seedCompany();
    const poisonedId = await seedIssue({ companyId, projectId, poisoned: true, status: "done" });
    // A row outside the subtree: `id IN (...)` must run the recursive subquery
    // to exhaustion for this row, so the unguarded walk cannot stop early.
    await seedIssue({ companyId, projectId, status: "done" });

    // The production capture from pg_stat_activity: an unguarded recursive
    // subtree walk over a poisoned tree. `statement_timeout` is the only thing
    // that stops it here; before the guard, the live equivalent ran until the
    // backend spilled its sort to pgsql_tmp and kept going.
    const unguardedFailure: unknown = await db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '3s'`);
      await tx.execute(sql`
        select "id" from "issues"
        where "company_id" = ${companyId} and "id" in (
          with recursive issue_tree(id) as (
            select "issues"."id" from "issues"
            where "issues"."company_id" = ${companyId} and "issues"."id" = ${poisonedId}
            union all
            select child.id from "issues" child
            join issue_tree parent on child.parent_id = parent.id
            where child.company_id = ${companyId}
          )
          select id from issue_tree
        )
      `);
    }).then(() => null, (error: unknown) => error);
    expect(unguardedFailure).toBeInstanceOf(Error);
    const cause = (unguardedFailure as { cause?: { message?: string } }).cause;
    expect(cause?.message ?? (unguardedFailure as Error).message).toMatch(/statement timeout/);

    // The guarded shape carries the ancestor path and stops on a revisit, so
    // the same poisoned tree returns the real rows immediately.
    const rows = await db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '3s'`);
      return tx.execute<{ id: string }>(sql`
        select "id" from "issues"
        where "company_id" = ${companyId} and "id" in (
          with recursive issue_tree(id, path, depth) as (
            select root.id, array[root.id]::uuid[], 0
            from "issues" root
            where root.company_id = ${companyId} and root.id = ${poisonedId}
            union all
            select child.id, issue_tree.path || child.id, issue_tree.depth + 1
            from "issues" child
            join issue_tree on child.parent_id = issue_tree.id
            where child.company_id = ${companyId}
              and issue_tree.depth < 1000
              and not child.id = any(issue_tree.path)
          )
          select id from issue_tree
        )
      `);
    });
    expect(rows.map(row => row.id)).toEqual([poisonedId]);
  }, SWEEP_GUARD_TIMEOUT_MS);

  it("archives a workspace whose poisoned self-parent tree is fully terminal", async () => {
    const { companyId, projectId } = await seedCompany();
    const rootId = await seedIssue({ companyId, projectId, poisoned: true, status: "done" });
    const workspaceId = await seedWorkspace({ companyId, projectId, sourceIssueId: rootId });

    const result = await service().sweepTerminalWorkspaces(50);

    expect(result).toMatchObject({ checked: 1, eligible: 1, archived: 1, skippedNonTerminalTree: 0 });
    expect(await workspaceStatus(workspaceId)).toBe("archived");
  }, SWEEP_GUARD_TIMEOUT_MS);

  it("keeps the workspace when a 2-cycle in the tree holds a non-terminal issue", async () => {
    const { companyId, projectId } = await seedCompany();
    const rootId = await seedIssue({ companyId, projectId, status: "done" });
    const childId = await seedIssue({ companyId, projectId, parentId: rootId, status: "todo" });
    await db.update(issues).set({ parentId: childId }).where(eq(issues.id, rootId));
    const workspaceId = await seedWorkspace({ companyId, projectId, sourceIssueId: rootId });

    const result = await service().sweepTerminalWorkspaces(50);

    expect(result).toMatchObject({ checked: 1, eligible: 0, archived: 0, skippedNonTerminalTree: 1 });
    expect(await workspaceStatus(workspaceId)).toBe("active");
    const [child] = await db.select({ parentId: issues.parentId }).from(issues).where(eq(issues.id, childId));
    expect(child!.parentId).toBe(rootId);
  }, SWEEP_GUARD_TIMEOUT_MS);

  it("walks a fully terminal 3-cycle to the archive decision without hanging", async () => {
    const { companyId, projectId } = await seedCompany();
    const aId = await seedIssue({ companyId, projectId, status: "done" });
    const bId = await seedIssue({ companyId, projectId, parentId: aId, status: "done" });
    const cId = await seedIssue({ companyId, projectId, parentId: bId, status: "done" });
    await db.update(issues).set({ parentId: cId }).where(eq(issues.id, aId));
    const workspaceId = await seedWorkspace({ companyId, projectId, sourceIssueId: aId });

    const result = await service().sweepTerminalWorkspaces(50);

    expect(result).toMatchObject({ checked: 1, eligible: 1, archived: 1, skippedNonTerminalTree: 0 });
    expect(await workspaceStatus(workspaceId)).toBe("archived");
  }, SWEEP_GUARD_TIMEOUT_MS);

  it("reads the workspace overview over a poisoned self-parent tree without hanging", async () => {
    // Reaches listWorkspaceIssueTree through assessDelivery — the query shape
    // captured live from pg_stat_activity during the temp-spill incident.
    const { companyId, projectId } = await seedCompany();
    const rootId = await seedIssue({ companyId, projectId, poisoned: true, status: "done" });
    await seedWorkspace({ companyId, projectId, sourceIssueId: rootId });

    const overview = await service().listOverview(companyId, { limit: 10, offset: 0 });

    expect(overview.total).toBe(1);
    expect(overview.items).toHaveLength(1);
  }, SWEEP_GUARD_TIMEOUT_MS);

  it("reads a healthy depth-5 fan-out tree exactly like the unguarded walk did", async () => {
    const { companyId, projectId } = await seedCompany();
    const rootId = await seedIssue({ companyId, projectId, status: "done" });
    let parentId = rootId;
    for (let depth = 0; depth < 5; depth += 1) {
      parentId = await seedIssue({ companyId, projectId, parentId, status: "done" });
      await seedIssue({ companyId, projectId, parentId, status: "done" });
    }
    const archivedId = await seedWorkspace({ companyId, projectId, sourceIssueId: rootId });
    const guarded = await service().sweepTerminalWorkspaces(50);
    expect(guarded).toMatchObject({ checked: 1, eligible: 1, archived: 1, skippedNonTerminalTree: 0 });
    expect(await workspaceStatus(archivedId)).toBe("archived");

    // The same shape with one open leaf must not archive: the guard sees the
    // deep non-terminal node instead of pruning the branch.
    const openRootId = await seedIssue({ companyId, projectId, status: "done" });
    let openParent = openRootId;
    for (let depth = 0; depth < 5; depth += 1) {
      openParent = await seedIssue({ companyId, projectId, parentId: openParent, status: "done" });
    }
    await seedIssue({ companyId, projectId, parentId: openParent, status: "todo" });
    const heldId = await seedWorkspace({ companyId, projectId, sourceIssueId: openRootId });
    const result = await service().sweepTerminalWorkspaces(50);
    expect(result).toMatchObject({ checked: 1, eligible: 0, archived: 0, skippedNonTerminalTree: 1 });
    expect(await workspaceStatus(heldId)).toBe("active");
  }, SWEEP_GUARD_TIMEOUT_MS);
});
