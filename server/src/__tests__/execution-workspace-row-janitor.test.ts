import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  executionWorkspaceRestorePoints,
  executionWorkspaceRuntimeLeases,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createExecutionWorkspaceRowJanitor } from "../services/execution-workspace-row-janitor.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-01-15T12:00:00.000Z");
/** Far outside every cooldown the test uses. */
const OLD = new Date(NOW.getTime() - 30 * DAY_MS);

describeEmbeddedPostgres("execution workspace row janitor", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let root: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("execution-workspace-row-janitor-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-row-janitor-"));
  });

  afterEach(async () => {
    // The restore point ledger has no foreign key to the company table, so it
    // is cleared on its own.
    await db.delete(executionWorkspaceRestorePoints);
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 1 });
    await database.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Janitor Company",
      issuePrefix: `J${companyId.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Janitor Agent" });
    return { companyId, agentId };
  }

  async function seedIssue(
    companyId: string,
    overrides: Partial<typeof issues.$inferInsert> = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Janitor fixture issue",
      status: "done",
      ...overrides,
    });
    return id;
  }

  async function seedWorkspace(
    companyId: string,
    sourceIssueId: string,
    overrides: Partial<typeof executionWorkspaces.$inferInsert> = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(executionWorkspaces).values({
      id,
      companyId,
      sourceIssueId,
      mode: "shared_workspace",
      strategyType: "local_fs",
      name: `janitor-${id.slice(0, 8)}`,
      providerType: "local_fs",
      status: "active",
      lastUsedAt: OLD,
      updatedAt: OLD,
      ...overrides,
    });
    return id;
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    overrides: Partial<typeof heartbeatRuns.$inferInsert> = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      scopeKind: "issue",
      status: "running",
      ...overrides,
    });
    return id;
  }

  async function workspaceExists(id: string): Promise<boolean> {
    const rows = await db
      .select({ id: executionWorkspaces.id })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, id));
    return rows.length > 0;
  }

  function createJanitor(overrides: { dryRun?: boolean } = {}) {
    return createExecutionWorkspaceRowJanitor(db, {
      cooldownMs: DAY_MS,
      now: () => NOW,
      ...overrides,
    });
  }

  it("removes a stale row whose source issue is terminal and that has no live user", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const workspaceId = await seedWorkspace(companyId, issueId);

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(1);
    expect(result.checked).toBe(1);
    expect(await workspaceExists(workspaceId)).toBe(false);
  });

  it("keeps a row that a live run points at", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const workspaceId = await seedWorkspace(companyId, issueId);
    await seedRun(companyId, agentId, { status: "running", issueId });

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await workspaceExists(workspaceId)).toBe(true);
  });

  it("keeps a row that a live run checks out", async () => {
    const { companyId, agentId } = await seedCompany();
    const runId = await seedRun(companyId, agentId, { status: "running", issueId: null });
    const issueId = await seedIssue(companyId, { status: "done", checkoutRunId: runId });
    const workspaceId = await seedWorkspace(companyId, issueId);

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(0);
    expect(await workspaceExists(workspaceId)).toBe(true);
  });

  it("keeps a row that a queued run points at", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const workspaceId = await seedWorkspace(companyId, issueId);
    await seedRun(companyId, agentId, { status: "queued", issueId });

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(0);
    expect(await workspaceExists(workspaceId)).toBe(true);
  });

  it("keeps a row that holds a live lease", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const workspaceId = await seedWorkspace(companyId, issueId);
    await db.insert(executionWorkspaceRuntimeLeases).values({
      companyId,
      executionWorkspaceId: workspaceId,
      ownerKey: `issue:${issueId}`,
      ownerIssueId: issueId,
      lastAction: "claim",
      expiresAt: new Date(NOW.getTime() + DAY_MS),
    });

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(0);
    expect(await workspaceExists(workspaceId)).toBe(true);
  });

  it("removes a row whose lease expired", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const workspaceId = await seedWorkspace(companyId, issueId);
    await db.insert(executionWorkspaceRuntimeLeases).values({
      companyId,
      executionWorkspaceId: workspaceId,
      ownerKey: `issue:${issueId}`,
      ownerIssueId: issueId,
      lastAction: "claim",
      expiresAt: new Date(NOW.getTime() - DAY_MS),
    });

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(1);
    expect(await workspaceExists(workspaceId)).toBe(false);
  });

  it("keeps a row that holds a running runtime service", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const workspaceId = await seedWorkspace(companyId, issueId);
    await db.insert(workspaceRuntimeServices).values({
      id: randomUUID(),
      companyId,
      executionWorkspaceId: workspaceId,
      issueId,
      scopeType: "issue",
      scopeId: issueId,
      serviceName: "dev-server",
      status: "running",
      lifecycle: "managed",
      provider: "local",
    });

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(0);
    expect(await workspaceExists(workspaceId)).toBe(true);
  });

  it("removes a row whose runtime service is stopped", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const workspaceId = await seedWorkspace(companyId, issueId);
    await db.insert(workspaceRuntimeServices).values({
      id: randomUUID(),
      companyId,
      executionWorkspaceId: workspaceId,
      issueId,
      scopeType: "issue",
      scopeId: issueId,
      serviceName: "dev-server",
      status: "stopped",
      lifecycle: "managed",
      provider: "local",
    });

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(1);
    expect(await workspaceExists(workspaceId)).toBe(false);
  });

  it("keeps a row that an open issue points at", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const workspaceId = await seedWorkspace(companyId, issueId);
    await seedIssue(companyId, { status: "in_progress", executionWorkspaceId: workspaceId });

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(0);
    expect(await workspaceExists(workspaceId)).toBe(true);
  });

  it("keeps a row whose source issue is not terminal", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "in_progress" });
    const workspaceId = await seedWorkspace(companyId, issueId);

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(0);
    expect(await workspaceExists(workspaceId)).toBe(true);
  });

  it("keeps a row whose source issue tree has an open child issue", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    await seedIssue(companyId, { status: "in_progress", parentId: issueId });
    const workspaceId = await seedWorkspace(companyId, issueId);

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(0);
    expect(await workspaceExists(workspaceId)).toBe(true);
  });

  it("keeps a row that was used inside the cooldown", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const workspaceId = await seedWorkspace(companyId, issueId, {
      lastUsedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(0);
    expect(await workspaceExists(workspaceId)).toBe(true);
  });

  it("keeps a row that was updated inside the cooldown", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const workspaceId = await seedWorkspace(companyId, issueId, {
      updatedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(0);
    expect(await workspaceExists(workspaceId)).toBe(true);
  });

  it("removes a shared workspace row and leaves the shared checkout on disk", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const checkout = path.join(root, "shared-checkout");
    await fs.mkdir(checkout, { recursive: true });
    const marker = path.join(checkout, "marker.txt");
    await fs.writeFile(marker, "shared checkout content");
    const workspaceId = await seedWorkspace(companyId, issueId, { cwd: checkout });

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(1);
    expect(await workspaceExists(workspaceId)).toBe(false);
    // The janitor deletes rows only. The shared checkout directory and the file
    // in it are untouched.
    await expect(fs.readFile(marker, "utf8")).resolves.toBe("shared checkout content");
  });

  it("keeps an isolated workspace row that still holds its worktree", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const workspaceId = await seedWorkspace(companyId, issueId, {
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      status: "active",
    });

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(0);
    expect(await workspaceExists(workspaceId)).toBe(true);
  });

  it("removes an archived row whose cleanup became eligible long ago", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const workspaceId = await seedWorkspace(companyId, issueId, {
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      status: "archived",
      closedAt: OLD,
      cleanupEligibleAt: OLD,
    });

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(1);
    expect(await workspaceExists(workspaceId)).toBe(false);
  });

  it("keeps an archived row whose cleanup became eligible inside the cooldown", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const workspaceId = await seedWorkspace(companyId, issueId, {
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      status: "archived",
      closedAt: OLD,
      cleanupEligibleAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(0);
    expect(await workspaceExists(workspaceId)).toBe(true);
  });

  it("keeps a row that holds a live restore point", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const workspaceId = await seedWorkspace(companyId, issueId);
    await db.insert(executionWorkspaceRestorePoints).values({
      companyId,
      executionWorkspaceId: workspaceId,
      sourceIssueId: issueId,
      generation: 1,
      objectKey: `restore/${workspaceId}`,
      sha256: "0".repeat(64),
      byteSize: 12,
      status: "active",
    });

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(0);
    expect(await workspaceExists(workspaceId)).toBe(true);
  });

  it("removes nothing in a dry run and reports the row", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const workspaceId = await seedWorkspace(companyId, issueId);

    const result = await createJanitor({ dryRun: true }).sweep(25);

    expect(result.dryRun).toBe(true);
    expect(result.removed).toBe(1);
    expect(await workspaceExists(workspaceId)).toBe(true);
  });

  it("has no deadline when there is no candidate row", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    // An isolated row that still holds its worktree is never a candidate, so
    // it gives the sweeper no deadline.
    await seedWorkspace(companyId, issueId, {
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      status: "active",
    });

    const janitor = createJanitor();

    expect(await janitor.nextDeadline()).toBeNull();
  });

  it("reports the earliest deadline of a row that leaves the cooldown", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "done" });
    const dueAt = new Date(NOW.getTime() + 2 * DAY_MS);
    await seedWorkspace(companyId, issueId, { lastUsedAt: dueAt, updatedAt: dueAt });

    const janitor = createJanitor();

    expect(await janitor.nextDeadline()).toBe(dueAt.getTime());
  });

  it("removes the row and reports the count of removed rows", async () => {
    const { companyId } = await seedCompany();
    const issueId = await seedIssue(companyId, { status: "cancelled" });
    const first = await seedWorkspace(companyId, issueId);
    const second = await seedWorkspace(companyId, issueId);

    const result = await createJanitor().sweep(25);

    expect(result.removed).toBe(2);
    expect(await workspaceExists(first)).toBe(false);
    expect(await workspaceExists(second)).toBe(false);
  });
});
