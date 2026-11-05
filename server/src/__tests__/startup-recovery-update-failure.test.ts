import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => vi.fn()),
}));
vi.mock("@ai-sdk/anthropic", () => ({}));
vi.mock("@ai-sdk/google", () => ({}));
vi.mock("@ai-sdk/xai", () => ({}));
vi.mock("@ai-sdk/amazon-bedrock", () => ({}));
vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: vi.fn(() => vi.fn()),
}));

import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const externalUrl = resolveExternalTestDatabaseUrl(
  "PAPERCLIP_STARTUP_RECOVERY_TEST_DATABASE_URL",
);
const embeddedPostgresSupport = externalUrl
  ? { supported: true, reason: undefined }
  : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("startup recovery continues on update failure", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb:
    | Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>
    | null = null;
  let companyId: string;

  beforeAll(async () => {
    if (!externalUrl)
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-startup-recovery-",
      );
    db = createDb(externalUrl ?? tempDb!.connectionString, {
      maxConnections: 4,
    });

    const [company] = await db
      .insert(companies)
      .values({ identifier: "SR", name: "Startup Recovery Test" })
      .returning();
    companyId = company.id;

    await db.execute(sql`
      CREATE OR REPLACE FUNCTION test_sr_fail_first()
      RETURNS TRIGGER AS $$
      DECLARE
        has_count INTEGER;
      BEGIN
        CREATE TEMP TABLE IF NOT EXISTS pg_temp._sr_update_count (cnt INTEGER);
        SELECT EXISTS(SELECT 1 FROM pg_temp._sr_update_count) INTO has_count;
        IF NOT has_count THEN
          INSERT INTO pg_temp._sr_update_count VALUES (1);
          RAISE EXCEPTION 'recovery: simulated update failure on first blocked update';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION test_sr_reset()
      RETURNS void AS $$
      BEGIN
        DROP TABLE IF EXISTS pg_temp._sr_update_count;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await db.execute(sql`
      CREATE OR REPLACE TRIGGER test_sr_fail_first_trigger
      BEFORE UPDATE ON issues
      FOR EACH ROW
      WHEN (NEW.status = 'blocked')
      EXECUTE FUNCTION test_sr_fail_first();
    `);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    try {
      await db.execute(sql`SELECT test_sr_reset()`);
    } catch {  }
    await db.execute(sql`TRUNCATE companies, issues, agents, heartbeat_runs, issue_recovery_actions CASCADE`);
  });

  it("skips the failing update and continues with subsequent issues", async () => {

    const [agent] = await db
      .insert(agents)
      .values({
        id: randomUUID(),
        companyId,
        identifier: "test-agent",
        name: "Test Agent",
        status: "idle",
      })
      .returning();

    const issue1Id = randomUUID();
    const issue2Id = randomUUID();
    const child1Id = randomUUID();
    const child2Id = randomUUID();

    await db.insert(issues).values([
      { id: issue1Id, companyId, identifier: "SR-1", title: "Source issue one", status: "todo" },
      { id: issue2Id, companyId, identifier: "SR-2", title: "Source issue two", status: "todo" },
      { id: child1Id, companyId, identifier: "SR-3", title: "Child of issue one", status: "todo", parentId: issue1Id },
      { id: child2Id, companyId, identifier: "SR-4", title: "Child of issue two", status: "todo", parentId: issue2Id },
    ]);

    const agentId = agent.id;
    const run1Id = randomUUID();
    const run2Id = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: run1Id,
        companyId,
        agentId: agentId,
        scopeKind: "issue",
        status: "queued",
        contextSnapshot: { issueId: child1Id },
        createdAt: new Date(),
        startedAt: new Date(),
      },
      {
        id: run2Id,
        companyId,
        agentId: agentId,
        scopeKind: "issue",
        status: "queued",
        contextSnapshot: { issueId: child2Id },
        createdAt: new Date(),
        startedAt: new Date(),
      },
    ]);

    const now = new Date();
    await db.insert(issueRecoveryActions).values([
      {
        id: randomUUID(),
        companyId,
        sourceIssueId: issue1Id,
        kind: "stranded_assigned_issue",
        status: "active",
        ownerType: "agent",
        ownerAgentId: agent.id,
        cause: "stranded_assigned_issue",
        fingerprint: "fp-1",
        evidence: { systemRecovery: {} },
        nextAction: "enqueue",
        wakePolicy: { type: "bounded_recovery_owner" },
        attemptCount: 0,
        maxAttempts: 5,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: randomUUID(),
        companyId,
        sourceIssueId: issue2Id,
        kind: "stranded_assigned_issue",
        status: "active",
        ownerType: "agent",
        ownerAgentId: agent.id,
        cause: "stranded_assigned_issue",
        fingerprint: "fp-2",
        evidence: { systemRecovery: {} },
        nextAction: "enqueue",
        wakePolicy: { type: "bounded_recovery_owner" },
        attemptCount: 0,
        maxAttempts: 5,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const enqueueWakeup = vi.fn().mockResolvedValue(true);
    const result = await recoveryService(db, { enqueueWakeup }).reconcileActiveRecoveryActions({ companyId });

    const totalProcessed = result.resolved + result.skipped + result.requeued;
    expect(totalProcessed).toBeGreaterThanOrEqual(2);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it("handles empty recovery actions without error", async () => {
    const result = await recoveryService(db, {
      enqueueWakeup: vi.fn().mockResolvedValue(true),
    }).reconcileActiveRecoveryActions({ companyId });

    expect(result.resolved).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.requeued).toBe(0);
    expect(result.issueIds).toEqual([]);
  });
});
