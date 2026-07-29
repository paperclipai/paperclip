import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

/**
 * Central dormancy guard in enqueueWakeup: ALL automated wake sources
 * skip-at-source when the agent's company is outside its sprint window
 * ("dormant"), instead of creating queued runs that look frozen. Mirrors
 * run-gate-activity-window-schedule-skip.test.ts (same window + exemption
 * semantics) but exercises the guard end-to-end through the real service +
 * database so we prove (a) automated wakes skip, (b) the operator override
 * still runs, (c) exempt agents still enqueue, and (d) in-window companies are
 * not over-gated.
 */

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
}

// Build activity windows relative to the real wall-clock so the test is robust
// no matter what hour it runs at. enqueueWakeup evaluates the window with
// `new Date()` internally (it does not take an injectable clock), so we derive
// "dormant now" and "open now" windows from the current UTC hour.
function windowsForNow(now = new Date()) {
  const h = now.getUTCHours();
  return {
    // A 1-hour window two hours in the future -> currently closed (dormant).
    dormant: { timezone: "UTC", startHour: (h + 2) % 24, endHour: (h + 3) % 24 },
    // A 3-hour window spanning [h-1, h+2) -> currently open.
    open: { timezone: "UTC", startHour: (h + 23) % 24, endHour: (h + 2) % 24 },
  };
}

async function seedCompany(
  db: ReturnType<typeof createDb>,
  activityWindow: Record<string, unknown> | null,
) {
  const companyId = randomUUID();
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  await db.insert(companies).values({
    id: companyId,
    name: "ThinkStack KISS",
    issuePrefix,
    requireBoardApprovalForNewAgents: false,
    activityWindow: activityWindow ?? undefined,
    // Fixture gap: run dispatch now requires a resolvable responsible user
    // (422 responsible_user_unresolved otherwise); the company default is the
    // last rung of the resolution ladder.
    defaultResponsibleUserId: "responsible-user",
  });
  return companyId;
}

async function seedAgent(
  db: ReturnType<typeof createDb>,
  companyId: string,
  overrides: Partial<typeof agents.$inferInsert> = {},
) {
  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Kestrel",
    role: "ceo",
    status: "running",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
    ...overrides,
  });
  return agentId;
}

async function countRuns(db: ReturnType<typeof createDb>, agentId: string) {
  const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
  return rows;
}

async function skippedRequest(db: ReturnType<typeof createDb>, agentId: string, reason: string) {
  return db
    .select()
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.status, "skipped"),
        eq(agentWakeupRequests.reason, reason),
      ),
    )
    .then((rows) => rows[0] ?? null);
}

describe("enqueueWakeup dormancy guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-dormancy-");
    db = createDb(started.connectionString);
    tempDb = started;
  }, 120_000);

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  it("SKIPS an automated wake (triggerDetail:system) into a dormant company and creates no run", async () => {
    const heartbeat = heartbeatService(db);
    const { dormant } = windowsForNow();
    const companyId = await seedCompany(db, dormant);
    const agentId = await seedAgent(db, companyId);

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      requestedByActorType: "agent",
      requestedByActorId: "compiler",
      contextSnapshot: { source: "issue.update", wakeReason: "issue_assigned" },
    });

    // Matches the existing no-run early-skip branches: returns null.
    expect(run).toBeNull();
    expect(await countRuns(db, agentId)).toHaveLength(0);

    const skip = await skippedRequest(db, agentId, "outside_activity_window");
    expect(skip).not.toBeNull();
    expect(skip?.source).toBe("assignment");
  });

  it("SKIPS an automated wake attributed to requestedByActorType:system into a dormant company", async () => {
    const heartbeat = heartbeatService(db);
    const { dormant } = windowsForNow();
    const companyId = await seedCompany(db, dormant);
    const agentId = await seedAgent(db, companyId);

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      // Even if a caller forgot triggerDetail, the system actorType still gates.
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
    });

    expect(run).toBeNull();
    expect(await countRuns(db, agentId)).toHaveLength(0);
    expect(await skippedRequest(db, agentId, "outside_activity_window")).not.toBeNull();
  });

  it("does NOT skip a MANUAL operator wake (triggerDetail:manual, actorType:user) in a dormant company — operator override survives", async () => {
    const heartbeat = heartbeatService(db);
    const { dormant } = windowsForNow();
    const companyId = await seedCompany(db, dormant);
    const agentId = await seedAgent(db, companyId);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "operator wakeup",
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    // The guard must NOT short-circuit the operator override: a run is created
    // even though the company is dormant (it may already be dispatching, so we
    // assert it exists rather than pin a transient status).
    expect(run).not.toBeNull();
    expect(await countRuns(db, agentId)).toHaveLength(1);
    // And it was NOT recorded as an activity-window skip.
    expect(await skippedRequest(db, agentId, "outside_activity_window")).toBeNull();
  });

  it("does NOT skip an exempt shell-handler/compiler agent in a dormant company (handshake/evals still run)", async () => {
    const heartbeat = heartbeatService(db);
    const { dormant } = windowsForNow();
    const companyId = await seedCompany(db, dormant);
    const agentId = await seedAgent(db, companyId, {
      name: "Fallback-Compiler",
      adapterType: "paperclip_shell_handler",
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "handshake",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
    });

    expect(run).not.toBeNull();
    expect(await countRuns(db, agentId)).toHaveLength(1);
    expect(await skippedRequest(db, agentId, "outside_activity_window")).toBeNull();
  });

  it("does NOT skip an ignoreActivityWindow agent in a dormant company", async () => {
    const heartbeat = heartbeatService(db);
    const { dormant } = windowsForNow();
    const companyId = await seedCompany(db, dormant);
    const agentId = await seedAgent(db, companyId, {
      name: "PolymarketEngineer",
      runtimeConfig: { ignoreActivityWindow: true },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "hourly_eval",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
    });

    expect(run).not.toBeNull();
    expect(await countRuns(db, agentId)).toHaveLength(1);
    expect(await skippedRequest(db, agentId, "outside_activity_window")).toBeNull();
  });

  it("does NOT over-gate: an automated wake into an IN-WINDOW company still enqueues a run", async () => {
    const heartbeat = heartbeatService(db);
    const { open } = windowsForNow();
    const companyId = await seedCompany(db, open);
    const agentId = await seedAgent(db, companyId);

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
    });

    expect(run).not.toBeNull();
    expect(await countRuns(db, agentId)).toHaveLength(1);
    expect(await skippedRequest(db, agentId, "outside_activity_window")).toBeNull();
  });

  it("does NOT skip an automated wake when the company has NO activity window", async () => {
    const heartbeat = heartbeatService(db);
    const companyId = await seedCompany(db, null);
    const agentId = await seedAgent(db, companyId);

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
    });

    expect(run).not.toBeNull();
    expect(await countRuns(db, agentId)).toHaveLength(1);
    expect(await skippedRequest(db, agentId, "outside_activity_window")).toBeNull();
  });
});
