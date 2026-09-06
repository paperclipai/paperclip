import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  evaluatePreStartAdmission,
  selectActiveCapacityWindow,
  type CapacitySnapshot,
} from "../services/pre-start-admission.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.ts";
import {
  getEmbeddedPostgresTestSupport,
  type EmbeddedPostgresTestDatabase,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const TEST_ADAPTER = "pre_start_admission_test";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

function snapshot(input: {
  observedAt: Date;
  windows: CapacitySnapshot["windows"];
}): CapacitySnapshot {
  return {
    provider: "openai",
    observedAt: input.observedAt,
    windows: input.windows,
  };
}

describe("pre-start admission decisions", () => {
  it("fails closed on stale telemetry in enforce mode", async () => {
    const now = new Date("2026-09-06T12:00:00.000Z");
    const evaluate = vi.fn();
    const outcome = await evaluatePreStartAdmission({
      now,
      subject: {
        companyId: "company-1",
        agentId: "agent-1",
        issue: null,
        issueId: null,
        runId: "run-1",
        wakeupRequestId: "wake-1",
        provider: "openai",
        model: "gpt-5.4",
      },
      hook: {
        mode: "enforce",
        maxSnapshotAgeMs: 30_000,
        readCapacitySnapshot: async () =>
          snapshot({
            observedAt: new Date("2026-09-06T11:59:00.000Z"),
            windows: [],
          }),
        evaluate,
      },
    });

    expect(outcome).toMatchObject({
      allow: false,
      enforced: true,
      reasonCode: "telemetry_stale",
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("uses the fresh quota window after reset instead of the exhausted prior window", () => {
    const now = new Date("2026-09-06T12:00:01.000Z");
    const active = selectActiveCapacityWindow({
      now,
      model: "gpt-5.4",
      snapshot: snapshot({
        observedAt: now,
        windows: [
          {
            key: "five-hour:old",
            startsAt: new Date("2026-09-06T07:00:00.000Z"),
            resetsAt: new Date("2026-09-06T12:00:00.000Z"),
            remaining: 0,
            model: "gpt-5.4",
          },
          {
            key: "five-hour:fresh",
            startsAt: new Date("2026-09-06T12:00:00.000Z"),
            resetsAt: new Date("2026-09-06T17:00:00.000Z"),
            remaining: 100,
            model: "gpt-5.4",
          },
        ],
      }),
    });

    expect(active?.key).toBe("five-hour:fresh");
    expect(active?.remaining).toBe(100);
  });

  it("keeps vetoes observe-only unless enforcement is explicitly activated", async () => {
    const now = new Date("2026-09-06T12:00:00.000Z");
    const outcome = await evaluatePreStartAdmission({
      now,
      subject: {
        companyId: "company-1",
        agentId: "agent-1",
        issue: null,
        issueId: null,
        runId: "run-1",
        wakeupRequestId: "wake-1",
        provider: "openai",
        model: "gpt-5.4",
      },
      hook: {
        maxSnapshotAgeMs: 30_000,
        readCapacitySnapshot: async () =>
          snapshot({
            observedAt: now,
            windows: [
              {
                key: "five-hour",
                startsAt: new Date("2026-09-06T10:00:00.000Z"),
                resetsAt: new Date("2026-09-06T15:00:00.000Z"),
                remaining: 0,
              },
            ],
          }),
        evaluate: async () => ({ allow: false, reason: "No capacity" }),
      },
    });

    expect(outcome).toMatchObject({
      allow: true,
      enforced: false,
      mode: "observe",
      reasonCode: "hook_veto",
    });
  });
});

describeEmbeddedPostgres("heartbeat pre-start admission boundary", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  const adapterExecute = vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
  }));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-pre-start-admission-",
    );
    db = createDb(tempDb.connectionString);
    registerServerAdapter({
      type: TEST_ADAPTER,
      execute: adapterExecute,
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    adapterExecute.mockClear();
  });

  afterAll(async () => {
    unregisterServerAdapter(TEST_ADAPTER);
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Admission test",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Admission Agent",
      role: "engineer",
      status: "active",
      adapterType: TEST_ADAPTER,
      adapterConfig: { provider: "openai", model: "gpt-5.4" },
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    return { agentId };
  }

  it("vetoes before adapter execution and deduplicates the wake", async () => {
    const { agentId } = await seedAgent();
    const evaluate = vi.fn(async () => ({
      allow: false,
      reason: "Synthetic capacity exhausted",
    }));
    const heartbeat = heartbeatService(db, {
      preStartAdmission: {
        mode: "enforce",
        maxSnapshotAgeMs: 30_000,
        readCapacitySnapshot: async () => {
          const now = new Date();
          return snapshot({
            observedAt: now,
            windows: [
              {
                key: "five-hour",
                startsAt: new Date(now.getTime() - 60_000),
                resetsAt: new Date(now.getTime() + 60_000),
                remaining: 0,
              },
            ],
          });
        },
        evaluate,
      },
    });
    const wakeOptions = {
      source: "automation" as const,
      reason: "issue_assigned",
      idempotencyKey: "synthetic-duplicate-wake",
      requestedByActorType: "system" as const,
    };

    const first = await heartbeat.wakeup(agentId, wakeOptions);
    expect(first).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const duplicate = await heartbeat.wakeup(agentId, wakeOptions);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(duplicate?.id).toBe(first?.id);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(adapterExecute).not.toHaveBeenCalled();
    expect(await heartbeat.getRun(first!.id)).toMatchObject({
      status: "cancelled",
      errorCode: "pre_start_admission_hook_veto",
      error: "Synthetic capacity exhausted",
    });
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  });
});
