import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, executionWorkspaces, heartbeatRuns, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { isGitWorkspaceExpirationEligible } from "../services/git-workspace-expiration.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

type Plan = { "Relation Name"?: string; "Actual Loops"?: number; Plans?: Plan[] };
const flatten = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];
const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("Git expiration eligibility", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("git-expiration-eligibility-");
    db = createDb(database.connectionString, { maxConnections: 1 });
  });
  afterEach(async () => { vi.restoreAllMocks(); await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const now = new Date(), old = new Date(now.getTime() - 3 * 86_400_000);
    await db.insert(companies).values({ id: companyId, name: "Eligibility", issuePrefix: `EL${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Eligibility" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Finished root", status: "done", completedAt: old });
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: issueId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "Eligibility", cwd: `/tmp/eligibility-${companyId}` }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", finishedAt: old, contextSnapshot: { issueId } });
    const eligible = () => db.transaction(tx => isGitWorkspaceExpirationEligible(tx, workspace, now));
    return { companyId, agentId, issueId, workspace, now, old, eligible };
  }

  async function alias(f: Awaited<ReturnType<typeof fixture>>, kind: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Other owner", issuePrefix: `EO${companyId.slice(0, 6)}` });
    const cwd = kind.endsWith("child") ? `${f.workspace.cwd}/nested` : f.workspace.cwd;
    if (kind.startsWith("project")) {
      const [project] = await db.insert(projects).values({ companyId, name: "Other project" }).returning();
      const [row] = await db.insert(projectWorkspaces).values({ companyId, projectId: project.id, name: "Other checkout", cwd }).returning();
      return { id: row.id, table: projectWorkspaces };
    }
    const [row] = await db.insert(executionWorkspaces).values({ companyId, mode: "isolated_workspace", strategyType: "git_worktree", name: "Other checkout",
      cwd: kind === "workspace provider" ? `/tmp/unrelated-${companyId}` : cwd,
      providerRef: kind === "workspace provider" ? f.workspace.cwd : null }).returning();
    return { id: row.id, table: executionWorkspaces };
  }

  it.each(["workspace same", "workspace provider", "workspace child", "project same", "project child"])("rejects %s before reading run history", async kind => {
    const f = await fixture();
    await alias(f, kind);
    await db.transaction(async tx => {
      const execute = vi.spyOn(tx, "execute");
      expect(await isGitWorkspaceExpirationEligible(tx, f.workspace, f.now)).toBe(false);
      const query = execute.mock.calls[0]![0];
      execute.mockRestore();
      const rows = await tx.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`);
      const explained = rows[0]["QUERY PLAN"] as Array<{ Plan: Plan }>;
      const historyScans = flatten(explained[0].Plan).filter(node => node["Relation Name"] === "heartbeat_runs");
      expect(historyScans.every(node => node["Actual Loops"] === 0)).toBe(true);
    });
  });

  it("rechecks a shared consumer added or removed between eligibility checks", async () => {
    const f = await fixture();
    expect(await f.eligible()).toBe(true);
    const consumer = await alias(f, "workspace same");
    expect(await f.eligible()).toBe(false);
    await db.delete(consumer.table).where(eq(consumer.table.id, consumer.id));
    expect(await f.eligible()).toBe(true);
  });

  it("does not treat a sibling path prefix as a descendant", async () => {
    const f = await fixture();
    await db.insert(executionWorkspaces).values({ companyId: f.companyId, mode: "isolated_workspace", strategyType: "git_worktree", name: "Sibling", cwd: `${f.workspace.cwd}-sibling` });
    expect(await f.eligible()).toBe(true);
  });

  it.each(["issueId", "nativeIssueId", "contextIssue", "contextTask", "contextWorkspace", "checkout"])("retains the active-run veto through %s", async route => {
    const f = await fixture(), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "scheduled_retry",
      ...(route === "issueId" ? { scopeKind: "issue" as const, issueId: f.issueId } : {}),
      ...(route === "nativeIssueId" ? { nativeIssueId: f.issueId } : {}),
      contextSnapshot: route === "contextIssue" ? { issueId: f.issueId } : route === "contextTask" ? { taskId: f.issueId } : route === "contextWorkspace" ? { executionWorkspaceId: f.workspace.id } : null });
    if (route === "checkout") {
      await db.insert(issues).values({ companyId: f.companyId, title: "Other finished consumer", status: "done", completedAt: f.old, executionWorkspaceId: f.workspace.id, checkoutRunId: runId });
    }
    expect(await f.eligible()).toBe(false);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: f.old }).where(eq(heartbeatRuns.id, runId));
    expect(await f.eligible()).toBe(true);
  });
});
