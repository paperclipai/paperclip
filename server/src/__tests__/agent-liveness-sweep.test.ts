import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  AGENT_NON_LIVE_DETECTED_ACTION,
  sweepStaleAgents,
} from "../services/agent-liveness-sweep.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-liveness-sweep tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// 2026-08-06T12:00:00Z. The Senior Reviewer seat died 2026-07-31 — well past 24h.
const NOW = new Date("2026-08-06T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const TWENTY_FIVE_H_AGO = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
const EIGHT_H_AGO = new Date(NOW.getTime() - 8 * 60 * 60 * 1000);

const HEARTBEAT_RUNTIME_CONFIG = { heartbeat: { enabled: true, intervalSec: 3600 } };
const ON_DEMAND_RUNTIME_CONFIG = { heartbeat: { enabled: false } };

describeEmbeddedPostgres("stale-agent reconciliation sweep (LEG-1927)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-liveness-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  // The sweep scans every active company, so each test must start from a clean
  // DB to keep global checked/flagged counts meaningful.
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (tempDb) await tempDb.cleanup();
  });

  async function seedCompany(prefix = "ALS") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(input: {
    companyId: string;
    name: string;
    status?: string;
    errorReason?: string | null;
    lastHeartbeatAt?: Date | null;
    runtimeConfig?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId: input.companyId,
      name: input.name,
      role: "engineer",
      status: input.status ?? "idle",
      errorReason: input.errorReason ?? null,
      lastHeartbeatAt: input.lastHeartbeatAt ?? null,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: input.runtimeConfig ?? {},
      permissions: {},
    });
    return id;
  }

  async function flaggedActivityRows(agentId: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.agentId, agentId),
        eq(activityLog.action, AGENT_NON_LIVE_DETECTED_ACTION),
      ));
  }

  it("flags the LEG-1924 stale-heartbeat shape and explicit error status, skips on-demand and healthy agents", async () => {
    const companyId = await seedCompany("A01");

    // 1. LEG-1924 live shape: status flipped to running, errorReason + stale heartbeat (>24h).
    const staleReviewerId = await seedAgent({
      companyId,
      name: "Senior Reviewer",
      status: "running",
      errorReason: "Process lost -- child pid 93238 is no longer running",
      lastHeartbeatAt: TWENTY_FIVE_H_AGO,
      runtimeConfig: HEARTBEAT_RUNTIME_CONFIG,
    });

    // 2. Explicit error status, also stale past 24h.
    const errorAgentId = await seedAgent({
      companyId,
      name: "Broken Agent",
      status: "error",
      errorReason: "adapter config missing",
      lastHeartbeatAt: TWENTY_FIVE_H_AGO,
      runtimeConfig: ON_DEMAND_RUNTIME_CONFIG,
    });

    // 3. On-demand agent with the same stale shape — must NOT be flagged (stale branch).
    const onDemandId = await seedAgent({
      companyId,
      name: "On-Demand Worker",
      status: "running",
      errorReason: "stale-but-not-cleared",
      lastHeartbeatAt: TWENTY_FIVE_H_AGO,
      runtimeConfig: ON_DEMAND_RUNTIME_CONFIG,
    });

    // 4. Healthy, recently heartbeating agent — must NOT be flagged.
    const healthyId = await seedAgent({
      companyId,
      name: "Healthy Worker",
      status: "idle",
      lastHeartbeatAt: EIGHT_H_AGO,
      runtimeConfig: HEARTBEAT_RUNTIME_CONFIG,
    });

    const result = await sweepStaleAgents(db, { now: NOW });

    // Two candidates inspected (status='error' OR errorReason set): staleReviewer, errorAgent, onDemand.
    // healthy is not a candidate (no error, status not error).
    expect(result.checked).toBe(3);
    expect(result.flagged).toBe(2);
    expect(result.logged).toBe(2);

    const staleRows = await flaggedActivityRows(staleReviewerId);
    expect(staleRows).toHaveLength(1);
    expect(staleRows[0]!.details).toMatchObject({
      reason: "stale_error_heartbeat",
      agentStatus: "running",
      agentName: "Senior Reviewer",
    });

    const errorRows = await flaggedActivityRows(errorAgentId);
    expect(errorRows).toHaveLength(1);
    expect(errorRows[0]!.details).toMatchObject({ reason: "error_status", agentStatus: "error" });

    expect(await flaggedActivityRows(onDemandId)).toHaveLength(0);
    expect(await flaggedActivityRows(healthyId)).toHaveLength(0);

    // The sweep must NOT mutate agent status.
    const reviewerStatus = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, staleReviewerId))
      .then((rows) => rows[0]?.status);
    expect(reviewerStatus).toBe("running");
  });

  it("is idempotent within the threshold window (no duplicate flags on re-run)", async () => {
    const companyId = await seedCompany("A02");
    const staleId = await seedAgent({
      companyId,
      name: "Stale Reviewer",
      status: "running",
      errorReason: "boom",
      lastHeartbeatAt: TWENTY_FIVE_H_AGO,
      runtimeConfig: HEARTBEAT_RUNTIME_CONFIG,
    });

    const first = await sweepStaleAgents(db, { now: NOW });
    expect(first.logged).toBe(1);

    // Re-run on the same tick — dedup suppresses a second flag.
    const second = await sweepStaleAgents(db, { now: NOW });
    expect(second.flagged).toBe(1);
    expect(second.logged).toBe(0);

    expect(await flaggedActivityRows(staleId)).toHaveLength(1);
  });

  it("does not flag an agent that is stale-but-under the configured threshold", async () => {
    const companyId = await seedCompany("A03");
    // 8h stale: shared classifier calls it stale, but the default 24h sweep threshold has not elapsed.
    await seedAgent({
      companyId,
      name: "Recently Stale",
      status: "running",
      errorReason: "transient",
      lastHeartbeatAt: EIGHT_H_AGO,
      runtimeConfig: HEARTBEAT_RUNTIME_CONFIG,
    });

    const result = await sweepStaleAgents(db, { now: NOW });
    expect(result.checked).toBe(1);
    expect(result.flagged).toBe(0);
    expect(result.logged).toBe(0);
  });

  it("honours a custom (shorter) threshold", async () => {
    const companyId = await seedCompany("A04");
    const staleId = await seedAgent({
      companyId,
      name: "Seven Hour Stale",
      status: "running",
      errorReason: "transient",
      lastHeartbeatAt: EIGHT_H_AGO,
      runtimeConfig: HEARTBEAT_RUNTIME_CONFIG,
    });

    // 8h stale + a 7h threshold → flagged as stale_error_heartbeat.
    const result = await sweepStaleAgents(db, {
      now: NOW,
      thresholdMs: 7 * 60 * 60 * 1000,
    });
    expect(result.flagged).toBe(1);
    expect(result.logged).toBe(1);

    const rows = await flaggedActivityRows(staleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ reason: "stale_error_heartbeat" });
  });

  it("skips agents in archived companies", async () => {
    const archivedCompanyId = randomUUID();
    await db.insert(companies).values({
      id: archivedCompanyId,
      name: "Archived Co",
      issuePrefix: "ARX",
      status: "archived",
      requireBoardApprovalForNewAgents: false,
    });
    await seedAgent({
      companyId: archivedCompanyId,
      name: "Dead In Archived Co",
      status: "error",
      errorReason: "boom",
      lastHeartbeatAt: TWENTY_FIVE_H_AGO,
      runtimeConfig: HEARTBEAT_RUNTIME_CONFIG,
    });

    const result = await sweepStaleAgents(db, { now: NOW });
    // No candidates from the archived company are inspected.
    expect(result.checked).toBe(0);
    expect(result.flagged).toBe(0);
  });
});
