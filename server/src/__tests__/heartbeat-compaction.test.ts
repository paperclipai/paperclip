import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceRetentionConfig,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { compactHeartbeatRuns } from "../services/heartbeat-compaction.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat compaction tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A fixed past date that is always older than any retention threshold
const OLD_FINISHED_AT = new Date("2020-01-01T00:00:00.000Z");

describeEmbeddedPostgres("heartbeat compaction", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-compaction-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  });

  afterEach(async () => {
    await db.delete(instanceRetentionConfig);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function makeRun(overrides: {
    status: string;
    finishedAt: Date;
    resultJson?: Record<string, unknown>;
  }) {
    return {
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "assignment" as const,
      status: overrides.status,
      finishedAt: overrides.finishedAt,
      resultJson: overrides.resultJson ?? { summary: "test result" },
      stdoutExcerpt: "stdout text",
      stderrExcerpt: "stderr text",
      contextSnapshot: { issueId: randomUUID() },
    };
  }

  it("compacts a succeeded run older than the default threshold", async () => {
    const run = makeRun({ status: "succeeded", finishedAt: OLD_FINISHED_AT });
    await db.insert(heartbeatRuns).values(run);

    const before = Date.now();
    await compactHeartbeatRuns(db);

    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(row).toBeDefined();

    // Payload columns nulled
    expect(row!.resultJson).toBeNull();
    expect(row!.stdoutExcerpt).toBeNull();
    expect(row!.stderrExcerpt).toBeNull();
    expect(row!.contextSnapshot).toBeNull();

    // compactedAt set to a recent timestamp
    expect(row!.compactedAt).not.toBeNull();
    expect(row!.compactedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(row!.compactedAt!.getTime()).toBeLessThanOrEqual(Date.now());

    // Identity fields preserved
    expect(row!.status).toBe("succeeded");
    expect(row!.agentId).toBe(agentId);
    expect(row!.companyId).toBe(companyId);
    expect(row!.finishedAt).toEqual(OLD_FINISHED_AT);
  });

  it("does NOT compact a failed run older than the threshold", async () => {
    const run = makeRun({ status: "failed", finishedAt: OLD_FINISHED_AT });
    await db.insert(heartbeatRuns).values(run);

    await compactHeartbeatRuns(db);

    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(row).toBeDefined();
    expect(row!.resultJson).not.toBeNull();
    expect(row!.compactedAt).toBeNull();
  });

  it("does NOT compact a cancelled run older than the threshold", async () => {
    const run = makeRun({ status: "cancelled", finishedAt: OLD_FINISHED_AT });
    await db.insert(heartbeatRuns).values(run);

    await compactHeartbeatRuns(db);

    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(row).toBeDefined();
    expect(row!.resultJson).not.toBeNull();
    expect(row!.compactedAt).toBeNull();
  });

  it("does NOT compact a succeeded run whose finishedAt is within the retention window", async () => {
    // finishedAt = now, always within any retention window
    const run = makeRun({ status: "succeeded", finishedAt: new Date() });
    await db.insert(heartbeatRuns).values(run);

    await compactHeartbeatRuns(db);

    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(row).toBeDefined();
    expect(row!.resultJson).not.toBeNull();
    expect(row!.stdoutExcerpt).not.toBeNull();
    expect(row!.stderrExcerpt).not.toBeNull();
    expect(row!.contextSnapshot).not.toBeNull();
    expect(row!.compactedAt).toBeNull();
  });

  it("nulls adapter.invoke event payloads for compacted runs but preserves other event types", async () => {
    const run = makeRun({ status: "succeeded", finishedAt: OLD_FINISHED_AT });
    await db.insert(heartbeatRuns).values(run);

    await db.insert(heartbeatRunEvents).values([
      {
        companyId,
        runId: run.id,
        agentId,
        seq: 1,
        eventType: "adapter.invoke",
        payload: { model: "claude-sonnet", prompt: "do work" },
      },
      {
        companyId,
        runId: run.id,
        agentId,
        seq: 2,
        eventType: "tool.use",
        payload: { tool: "bash", input: "ls" },
      },
    ]);

    await compactHeartbeatRuns(db);

    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run.id))
      .orderBy(asc(heartbeatRunEvents.seq));

    const adapterEvent = events.find((e) => e.eventType === "adapter.invoke");
    const toolEvent = events.find((e) => e.eventType === "tool.use");

    expect(adapterEvent).toBeDefined();
    expect(adapterEvent!.payload).toBeNull();

    expect(toolEvent).toBeDefined();
    expect(toolEvent!.payload).toEqual({ tool: "bash", input: "ls" });
  });

  it("respects a custom succeeded_run_retention_hours from instance_retention_config", async () => {
    await db.insert(instanceRetentionConfig).values({
      succeededRunRetentionHours: 48,
      failedRunRetentionHours: 168,
      // companyId intentionally omitted (null) — global config row
    });

    const oldRun = makeRun({ status: "succeeded", finishedAt: OLD_FINISHED_AT });
    // 47h ago — always within a 48h window
    const recentRun = makeRun({
      status: "succeeded",
      finishedAt: new Date(Date.now() - 47 * 60 * 60 * 1000),
    });

    await db.insert(heartbeatRuns).values([oldRun, recentRun]);

    await compactHeartbeatRuns(db);

    const [oldRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, oldRun.id));
    const [recentRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, recentRun.id));

    expect(oldRow!.compactedAt).not.toBeNull();
    expect(recentRow!.compactedAt).toBeNull();
  });
});
