import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { blockIssueAfterLivenessExhaustion } from "../services/recovery/liveness-exhaustion.js";

describe("atomic liveness exhaustion ownership", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("liveness-fence-"); db = createDb(temporary.connectionString); }, 20_000);
  afterAll(async () => { await temporary?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), newerRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Fence fixture", issuePrefix: `F${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(heartbeatRuns).values([{ id: runId, companyId, agentId, status: "succeeded" }, { id: newerRunId, companyId, agentId, status: "running" }]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic ownership", status: "in_progress", assigneeAgentId: agentId });
    return { companyId, agentId, issueId, runId, newerRunId, now: new Date() };
  }
  it.each(["checkoutRunId", "executionRunId"] as const)("does not clear a newer %s", async field => {
    const f = await fixture();
    await db.update(issues).set({ [field]: f.newerRunId }).where(eq(issues.id, f.issueId));
    expect(await blockIssueAfterLivenessExhaustion(db, f)).toBe(false);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ [field]: f.newerRunId, status: "in_progress", unblockDescriptor: null });
  });
  it.each(["checkoutRunId", "executionRunId"] as const)("rechecks %s after a concurrent owner commits", async field => {
    const f = await fixture();
    let release!: () => void;
    let locked!: () => void;
    const ownerReady = new Promise<void>(resolve => { locked = resolve; });
    const ownerRelease = new Promise<void>(resolve => { release = resolve; });
    const owner = db.transaction(async tx => {
      await tx.update(issues).set({ [field]: f.newerRunId }).where(eq(issues.id, f.issueId));
      locked();
      await ownerRelease;
    });
    await ownerReady;
    const pending = blockIssueAfterLivenessExhaustion(db, f);
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'update "issues"%'`);
        if (rows.length > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally { release(); await owner; }
    expect(await pending).toBe(false);
    expect(waiting).toBe(true);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ [field]: f.newerRunId, status: "in_progress", unblockDescriptor: null });
  });
  it.each([false, true])("blocks only the exhausted owner or a released issue; owned=%s", async owned => {
    const f = await fixture();
    if (owned) await db.update(issues).set({ checkoutRunId: f.runId, executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    expect(await blockIssueAfterLivenessExhaustion(db, f)).toBe(true);
    expect(await blockIssueAfterLivenessExhaustion(db, f)).toBe(false);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ status: "blocked", checkoutRunId: null, executionRunId: null, unblockDescriptor: { owner: "board" } });
  });
  it("rejects a different company and changed assignment", async () => {
    const f = await fixture();
    expect(await blockIssueAfterLivenessExhaustion(db, { ...f, companyId: randomUUID() })).toBe(false);
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    expect(await blockIssueAfterLivenessExhaustion(db, f)).toBe(false);
  });
});
