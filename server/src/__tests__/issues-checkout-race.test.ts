// VAS-27 regression: concurrent checkouts must be atomic.
//
// Before the fix, the `checkout` path in services/issues.ts combined:
//   1. A staleness pre-check transaction (held a row lock)
//   2. A conditional UPDATE outside any lock
//   3. An adoptStaleCheckoutRun fallback that re-read heartbeat_runs without a lock
// Two concurrent checkouts for the same issue could both resolve as winners —
// the loser would enter adoptStaleCheckoutRun, observe the winner's run in a
// non-queued/non-running transient state, declare it "stale", and hijack the
// assignment. This violated the "one agent per task" invariant.
//
// This test fires N concurrent checkouts against the same freshly-created issue
// and asserts that exactly one succeeds; all others either 409 (conflict) or
// return the row already owned by the same run (idempotent self-checkout).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue checkout race tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

describeEmbeddedPostgres("issueService.checkout race — VAS-27", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-checkout-race-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("exactly one concurrent checkout wins; losers see 409", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CMO",
      role: "cmo",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "VAS-26 repro",
      status: "todo",
      priority: "high",
    });

    // Insert N distinct queued heartbeat runs — one per competing checkout.
    const N = 8;
    const runIds = Array.from({ length: N }, () => randomUUID());
    await db.insert(heartbeatRuns).values(
      runIds.map((id) => ({
        id,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "queued",
        contextSnapshot: { issueId },
      })),
    );

    // Fire all checkouts concurrently.
    const results = await Promise.allSettled(
      runIds.map((runId) => svc.checkout(issueId, agentId, ["todo", "backlog", "in_review"], runId)),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one run must win — any other "success" would mean a second agent
    // run also believes it owns the issue (the VAS-27 bug).
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(N - 1);

    // All rejections must be 409 Issue checkout conflict — never some other error.
    for (const r of rejected) {
      const err = (r as PromiseRejectedResult).reason;
      expect(String(err?.message ?? err)).toMatch(/checkout conflict/i);
    }

    // DB state must reflect a single winner.
    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(sql`${issues.id} = ${issueId}`)
      .then((rows) => rows[0]!);

    expect(row.status).toBe("in_progress");
    expect(row.assigneeAgentId).toBe(agentId);
    expect(row.checkoutRunId).not.toBeNull();
    expect(runIds).toContain(row.checkoutRunId);
    // Execution lock must match the checkout owner.
    expect(row.executionRunId).toBe(row.checkoutRunId);

    // The one success must be the run whose id matches the DB state.
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ checkoutRunId: string | null }>).value;
    expect(winner.checkoutRunId).toBe(row.checkoutRunId);
  }, 30_000);

  it("re-checkout by the same run is idempotent (no self-409)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CMO",
      role: "cmo",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Idempotent checkout",
      status: "todo",
      priority: "medium",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
      contextSnapshot: { issueId },
    });

    const first = await svc.checkout(issueId, agentId, ["todo"], runId);
    const second = await svc.checkout(issueId, agentId, ["todo", "in_progress"], runId);
    expect(first.checkoutRunId).toBe(runId);
    expect(second.checkoutRunId).toBe(runId);
  }, 20_000);
});
