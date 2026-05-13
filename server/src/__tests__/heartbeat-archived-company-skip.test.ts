import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat archived skip tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Covers the `knownCompanyStatus` short-circuit in `enqueueWakeup` introduced
 * to avoid an N+1 `SELECT status FROM companies` round-trip from `tickTimers`
 * (which already filters archived companies via an inner join on `companies`).
 *
 * The optional param is the source of truth on the short-circuit branch: when
 * a caller passes `knownCompanyStatus: "archived"`, the wakeup is soft-skipped
 * even if the company is `active` in the DB. Conversely, passing an
 * `"active"` status must NOT cause a stale archived row in the DB to leak a
 * wakeup through — defense in depth is the caller's responsibility on that
 * path (which is why `tickTimers` does the inner-join filter).
 */
describeEmbeddedPostgres("heartbeat enqueueWakeup archived skip", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hb-archived-skip-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Cascade truncate from `companies` — agent_runtime_state, heartbeat_runs,
    // agent_wakeup_requests, and similar children all transitively point at
    // `companies(id)` via `agents.company_id`, so a CASCADE truncate is the
    // simplest reset.
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(companyStatus: "active" | "archived" = "active") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: companyStatus,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("short-circuits without inserting any wakeup row when knownCompanyStatus is 'archived'", async () => {
    // Note: the company in the DB is `active` here. We pass
    // `knownCompanyStatus: "archived"` to prove the optional param is the
    // source of truth on the short-circuit branch (and that no `SELECT
    // status FROM companies` round-trip overrides the caller's hint).
    const { agentId } = await seedCompanyAndAgent("active");
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "test_archived_skip",
      requestedByActorType: "system",
      requestedByActorId: "test",
      knownCompanyStatus: "archived",
    });

    expect(run).toBeNull();
    const requests = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(requests).toHaveLength(0);
  });

  it("enqueues normally when knownCompanyStatus is 'active'", async () => {
    const { agentId } = await seedCompanyAndAgent("active");
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "test_active_passthrough",
      requestedByActorType: "system",
      requestedByActorId: "test",
      knownCompanyStatus: "active",
    });

    expect(run).not.toBeNull();
    const requests = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(requests.length).toBeGreaterThan(0);
  });

  it("falls back to the per-call DB lookup when knownCompanyStatus is undefined (defense-in-depth path)", async () => {
    // No `knownCompanyStatus` passed — the function must query
    // `companies.status` itself. When that DB row is `archived`, the wakeup
    // is soft-skipped.
    const { agentId } = await seedCompanyAndAgent("archived");
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "test_defense_in_depth",
      requestedByActorType: "system",
      requestedByActorId: "test",
    });

    expect(run).toBeNull();
    const requests = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(requests).toHaveLength(0);
  });
});
