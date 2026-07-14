import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  routineRuns,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
  ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
  heartbeatService,
} from "../services/heartbeat.ts";
import {
  STALE_ACTIVE_RUN_WATCHDOG_WHITELIST,
} from "../services/recovery/service.ts";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Acknowledged.",
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping stale-active-run whitelist tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("stale-active-run watchdog whitelist", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-active-run-whitelist-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type SeedOpts = {
    now: Date;
    ageMs: number;
    routineId?: string;
    agentId?: string;
  };

  async function seedRunningRunWithRoutine(opts: SeedOpts) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const agentId = opts.agentId ?? randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const routineId = opts.routineId ?? randomUUID();
    const issuePrefix = `WL${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    const startedAt = new Date(opts.now.getTime() - opts.ageMs);

    await db.insert(companies).values({
      id: companyId,
      name: "Whitelist Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentId,
        companyId,
        name: "Memory Keeper",
        role: "engineer",
        status: "running",
        reportsTo: managerId,
        adapterType: "opencode_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Nightly Memory Sync",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      originKind: "routine",
      updatedAt: startedAt,
      createdAt: startedAt,
    });
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Nightly Memory Sync",
      description: "Read and write Obsidian vault nightly.",
      assigneeAgentId: agentId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
    });
    await db.insert(routineRuns).values({
      id: randomUUID(),
      companyId,
      routineId,
      source: "schedule",
      status: "issue_created",
      linkedIssueId: issueId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      lastOutputAt: null,
      lastOutputSeq: 0,
      contextSnapshot: { issueId },
      logBytes: 0,
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    return { companyId, agentId, issueId, runId, routineId };
  }

  async function seedRunningRunWithoutRoutine(opts: { now: Date; ageMs: number; agentId?: string }) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const agentId = opts.agentId ?? randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `WL${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    const startedAt = new Date(opts.now.getTime() - opts.ageMs);

    await db.insert(companies).values({
      id: companyId,
      name: "Whitelist Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentId,
        companyId,
        name: "Ad-hoc Worker",
        role: "engineer",
        status: "running",
        reportsTo: managerId,
        adapterType: "opencode_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Some manual task",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      originKind: "manual",
      updatedAt: startedAt,
      createdAt: startedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      lastOutputAt: null,
      lastOutputSeq: 0,
      contextSnapshot: { issueId },
      logBytes: 0,
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    return { companyId, agentId, issueId, runId };
  }

  const [WHITELIST_ENTRY] = STALE_ACTIVE_RUN_WATCHDOG_WHITELIST;

  it("whitelist constant contains at least one entry keyed on stable UUIDs", () => {
    expect(STALE_ACTIVE_RUN_WATCHDOG_WHITELIST.length).toBeGreaterThan(0);
    expect(WHITELIST_ENTRY).toBeDefined();
    expect(WHITELIST_ENTRY?.agentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(WHITELIST_ENTRY?.routineId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("does NOT fire on the whitelisted (agentId, routineId) pair at suspicious silence threshold", async () => {
    if (!WHITELIST_ENTRY) throw new Error("No whitelist entry to test against");
    const now = new Date("2026-07-15T01:00:00.000Z");
    const { companyId } = await seedRunningRunWithRoutine({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 5_000,
      agentId: WHITELIST_ENTRY.agentId,
      routineId: WHITELIST_ENTRY.routineId,
    });
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(result.created, "should not create evaluation for whitelisted pair").toBe(0);
    expect(result.skipped, "should count whitelisted run as skipped").toBe(1);
  });

  it("does NOT fire on the whitelisted (agentId, routineId) pair at critical silence threshold", async () => {
    if (!WHITELIST_ENTRY) throw new Error("No whitelist entry to test against");
    const now = new Date("2026-07-15T01:00:00.000Z");
    const { companyId } = await seedRunningRunWithRoutine({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS + 5_000,
      agentId: WHITELIST_ENTRY.agentId,
      routineId: WHITELIST_ENTRY.routineId,
    });
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(result.created, "should not create evaluation at critical threshold for whitelisted pair").toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("still fires on the whitelisted agent running a DIFFERENT routine (not the whitelisted routine)", async () => {
    if (!WHITELIST_ENTRY) throw new Error("No whitelist entry to test against");
    const now = new Date("2026-07-15T01:00:00.000Z");
    const differentRoutineId = randomUUID();
    const { companyId } = await seedRunningRunWithRoutine({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 5_000,
      agentId: WHITELIST_ENTRY.agentId,
      routineId: differentRoutineId,
    });
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(result.created, "different routine on whitelisted agent should still fire").toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("still fires on a DIFFERENT agent running the whitelisted routine ID", async () => {
    if (!WHITELIST_ENTRY) throw new Error("No whitelist entry to test against");
    const now = new Date("2026-07-15T01:00:00.000Z");
    const differentAgentId = randomUUID();
    const { companyId } = await seedRunningRunWithRoutine({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 5_000,
      agentId: differentAgentId,
      routineId: WHITELIST_ENTRY.routineId,
    });
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(result.created, "different agent running whitelisted routine should still fire").toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("still fires on the whitelisted agent running a non-routine (ad-hoc) issue", async () => {
    if (!WHITELIST_ENTRY) throw new Error("No whitelist entry to test against");
    const now = new Date("2026-07-15T01:00:00.000Z");
    const { companyId } = await seedRunningRunWithoutRoutine({
      now,
      ageMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS + 5_000,
      agentId: WHITELIST_ENTRY.agentId,
    });
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.scanSilentActiveRuns({ now, companyId });
    expect(result.created, "non-routine run on whitelisted agent should still fire").toBe(1);
    expect(result.skipped).toBe(0);
  });
});
