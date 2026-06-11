import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DEFAULT_HIBERNATION_THRESHOLD_HOURS,
  HIBERNATION_THRESHOLD_ENV_VAR,
  detectColdWake,
  resolveHibernationThresholdHours,
} from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres detectColdWake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("detectColdWake", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-detect-cold-wake-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    delete process.env[HIBERNATION_THRESHOLD_ENV_VAR];
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
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
      name: "TestAgent",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertSucceededRun(
    companyId: string,
    agentId: string,
    finishedAt: Date | null,
  ) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: finishedAt
        ? new Date(finishedAt.getTime() - 60_000)
        : null,
      finishedAt,
    });
  }

  it("returns cold + null lastRunFinishedAt when the agent has no prior succeeded run", async () => {
    const { agentId } = await seedCompanyAndAgent();

    const result = await detectColdWake(db, agentId);

    expect(result.isColdWake).toBe(true);
    expect(result.hoursSinceLastRun).toBeNull();
    expect(result.lastRunFinishedAt).toBeNull();
    expect(result.thresholdHours).toBe(DEFAULT_HIBERNATION_THRESHOLD_HOURS);
  });

  it("returns warm when the most recent succeeded run is within threshold", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const now = new Date("2026-06-11T12:00:00Z");
    const finishedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2h ago
    await insertSucceededRun(companyId, agentId, finishedAt);

    const result = await detectColdWake(db, agentId, undefined, { now });

    expect(result.isColdWake).toBe(false);
    expect(result.hoursSinceLastRun).toBeCloseTo(2, 5);
    expect(result.lastRunFinishedAt).toBe("2026-06-11T10:00:00.000Z");
    expect(result.thresholdHours).toBe(DEFAULT_HIBERNATION_THRESHOLD_HOURS);
  });

  it("returns cold when the most recent succeeded run exceeds the threshold", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const now = new Date("2026-06-11T12:00:00Z");
    const finishedAt = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48h ago
    await insertSucceededRun(companyId, agentId, finishedAt);

    const result = await detectColdWake(db, agentId, undefined, { now });

    expect(result.isColdWake).toBe(true);
    expect(result.hoursSinceLastRun).toBeCloseTo(48, 5);
    expect(result.lastRunFinishedAt).toBe(finishedAt.toISOString());
    expect(result.thresholdHours).toBe(DEFAULT_HIBERNATION_THRESHOLD_HOURS);
  });

  it("picks the most recent succeeded run when multiple exist and ignores non-succeeded runs", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const now = new Date("2026-06-11T12:00:00Z");
    // Older succeeded run, 30h ago.
    await insertSucceededRun(companyId, agentId, new Date(now.getTime() - 30 * 60 * 60 * 1000));
    // More recent succeeded run, 3h ago — must win.
    await insertSucceededRun(companyId, agentId, new Date(now.getTime() - 3 * 60 * 60 * 1000));
    // A failed run that finished 1h ago — must NOT win.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      startedAt: new Date(now.getTime() - 60 * 60 * 1000 - 60_000),
      finishedAt: new Date(now.getTime() - 60 * 60 * 1000),
    });

    const result = await detectColdWake(db, agentId, undefined, { now });

    expect(result.isColdWake).toBe(false);
    expect(result.hoursSinceLastRun).toBeCloseTo(3, 5);
    expect(result.lastRunFinishedAt).toBe(new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString());
  });

  it("ignores runs from other agents", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherAgent",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const now = new Date("2026-06-11T12:00:00Z");
    // Other agent ran 1h ago; should not count for our agent.
    await insertSucceededRun(companyId, otherAgentId, new Date(now.getTime() - 60 * 60 * 1000));

    const result = await detectColdWake(db, agentId, undefined, { now });

    expect(result.isColdWake).toBe(true);
    expect(result.hoursSinceLastRun).toBeNull();
    expect(result.lastRunFinishedAt).toBeNull();
  });

  it("honors the explicit thresholdHours argument over default and env", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const now = new Date("2026-06-11T12:00:00Z");
    const finishedAt = new Date(now.getTime() - 5 * 60 * 60 * 1000); // 5h ago
    await insertSucceededRun(companyId, agentId, finishedAt);
    process.env[HIBERNATION_THRESHOLD_ENV_VAR] = "1"; // would force cold via env
    // Param of 12 must win: 5h < 12h ⇒ warm.
    const result = await detectColdWake(db, agentId, 12, { now });

    expect(result.thresholdHours).toBe(12);
    expect(result.isColdWake).toBe(false);
    expect(result.hoursSinceLastRun).toBeCloseTo(5, 5);
  });

  it("honors PAPERCLIP_HIBERNATION_THRESHOLD_HOURS env override when no param is passed", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const now = new Date("2026-06-11T12:00:00Z");
    const finishedAt = new Date(now.getTime() - 5 * 60 * 60 * 1000); // 5h ago
    await insertSucceededRun(companyId, agentId, finishedAt);

    // Default 24h would say warm; env tightens to 2h ⇒ cold.
    process.env[HIBERNATION_THRESHOLD_ENV_VAR] = "2";
    const result = await detectColdWake(db, agentId, undefined, { now });

    expect(result.thresholdHours).toBe(2);
    expect(result.isColdWake).toBe(true);
    expect(result.hoursSinceLastRun).toBeCloseTo(5, 5);
  });

  it("returns an ISO-8601 lastRunFinishedAt string", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const now = new Date("2026-06-11T12:00:00Z");
    const finishedAt = new Date("2026-06-09T09:34:21Z");
    await insertSucceededRun(companyId, agentId, finishedAt);

    const result = await detectColdWake(db, agentId, undefined, { now });

    expect(result.lastRunFinishedAt).toBe("2026-06-09T09:34:21.000Z");
    expect(() => new Date(result.lastRunFinishedAt as string).toISOString()).not.toThrow();
  });
});

describe("resolveHibernationThresholdHours", () => {
  beforeEach(() => {
    delete process.env[HIBERNATION_THRESHOLD_ENV_VAR];
  });

  afterAll(() => {
    delete process.env[HIBERNATION_THRESHOLD_ENV_VAR];
  });

  it("returns the default when no override is set", () => {
    expect(resolveHibernationThresholdHours()).toBe(DEFAULT_HIBERNATION_THRESHOLD_HOURS);
  });

  it("prefers the positive finite override argument", () => {
    process.env[HIBERNATION_THRESHOLD_ENV_VAR] = "8";
    expect(resolveHibernationThresholdHours(48)).toBe(48);
  });

  it("falls back to env when the override is invalid", () => {
    process.env[HIBERNATION_THRESHOLD_ENV_VAR] = "8";
    expect(resolveHibernationThresholdHours(undefined)).toBe(8);
    expect(resolveHibernationThresholdHours(0)).toBe(8);
    expect(resolveHibernationThresholdHours(-3)).toBe(8);
    expect(resolveHibernationThresholdHours(Number.NaN)).toBe(8);
    expect(resolveHibernationThresholdHours(Number.POSITIVE_INFINITY)).toBe(8);
  });

  it("falls back to the default when env is invalid", () => {
    process.env[HIBERNATION_THRESHOLD_ENV_VAR] = "not-a-number";
    expect(resolveHibernationThresholdHours()).toBe(DEFAULT_HIBERNATION_THRESHOLD_HOURS);
    process.env[HIBERNATION_THRESHOLD_ENV_VAR] = "-1";
    expect(resolveHibernationThresholdHours()).toBe(DEFAULT_HIBERNATION_THRESHOLD_HOURS);
    process.env[HIBERNATION_THRESHOLD_ENV_VAR] = "0";
    expect(resolveHibernationThresholdHours()).toBe(DEFAULT_HIBERNATION_THRESHOLD_HOURS);
    process.env[HIBERNATION_THRESHOLD_ENV_VAR] = "   ";
    expect(resolveHibernationThresholdHours()).toBe(DEFAULT_HIBERNATION_THRESHOLD_HOURS);
  });
});
