import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, executionWorkspaces, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { meterDatabaseStatements } from "./helpers/database-statement-meter.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_TERMINAL_WORKSPACE_PAGE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const DAY = 86_400_000;

(support.supported ? describe : describe.skip)("terminal workspace page reads", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  let meter: ReturnType<typeof meterDatabaseStatements>;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("terminal-workspace-page-");
    const url = external ?? temporary!.connectionString;
    db = createDb(url);
    db.$client.options.onnotice = () => {};
    meter = meterDatabaseStatements(db, url);
  }, 120_000);
  afterEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { meter?.uninstall(); await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function seed(input: { open: number; held: number; companies: number }) {
    const old = new Date(Date.now() - 10 * DAY);
    const held: string[] = [];
    for (let company = 0; company < input.companies; company++) {
      const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Page", issuePrefix: `P${companyId.slice(0, 6)}` });
      await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "in_progress" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "idle", adapterType: "process" });
      for (const kind of [...Array(input.open).fill("open"), ...Array(input.held).fill("held")] as Array<"open" | "held">) {
        const id = randomUUID(), issueId = randomUUID(), childId = randomUUID();
        const runId = kind === "held" ? randomUUID() : null;
        if (runId) await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
        await db.insert(executionWorkspaces).values({ id, companyId, projectId, mode: "shared_workspace", strategyType: "project_primary",
          name: id, status: "active", providerType: "local_fs", cwd: `/missing/${id}`, createdAt: old, updatedAt: old });
        await db.insert(issues).values([
          { id: issueId, companyId, projectId, title: kind, status: "done", executionWorkspaceId: id, checkoutRunId: runId, completedAt: old, updatedAt: old },
          { id: childId, companyId, projectId, parentId: issueId, title: `${kind} child`, status: kind === "open" ? "todo" : "done",
            completedAt: kind === "open" ? null : old, updatedAt: old },
        ]);
        await db.update(executionWorkspaces).set({ sourceIssueId: issueId, updatedAt: old }).where(eq(executionWorkspaces.id, id));
        if (kind === "held") held.push(id);
      }
    }
    return { held };
  }

  it("reads the task trees and active runs of a page in a fixed number of statements", async () => {
    await seed({ open: 20, held: 5, companies: 2 });
    const service = executionWorkspaceService(db, { workspaceReaperCooldownDays: 1 });
    meter.startLog();
    const result = await service.sweepTerminalWorkspaces(50);
    const statements = meter.stopLog();
    expect(result).toMatchObject({ checked: 50, skippedNonTerminalTree: 40, skippedActiveRun: 10 });
    const treeReads = statements.filter(entry => /issue_tree/i.test(entry.sql));
    const runReads = statements.filter(entry => /"checkout_run_id", "execution_run_id"|live_run/.test(entry.sql));
    expect(treeReads).toHaveLength(1);
    expect(runReads).toHaveLength(1);
    expect(statements.length).toBeLessThan(10);
  });
});
