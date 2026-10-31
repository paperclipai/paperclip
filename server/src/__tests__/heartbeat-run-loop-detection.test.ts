import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { subscribeCompanyLiveEvents } from "../services/live-events.ts";
import { LOOP_DETECTOR_THRESHOLD } from "../services/run-loop-detector.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Run-loop detection dispatch test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

// The detector is a pure function wrapped in try/catch inside the dispatch path.
// This seam lets one test force it to throw so we can prove dispatch survives a
// detector failure, while every other test exercises the real implementation.
const detectorControl = vi.hoisted(() => ({ failNext: false, calls: 0 }));
vi.mock("../services/run-loop-detector.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../services/run-loop-detector.ts")>(
      "../services/run-loop-detector.ts",
    );
  return {
    ...actual,
    detectRunLoops: (input: Parameters<typeof actual.detectRunLoops>[0]) => {
      detectorControl.calls += 1;
      if (detectorControl.failNext) {
        throw new Error("fixture run-loop detector failure");
      }
      return actual.detectRunLoops(input);
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-loop detection dispatch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat run-loop detection dispatch", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-run-loop-detection-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    detectorControl.failNext = false;
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    // Executed runs write to many company-scoped tables; clear them all.
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Run Loop Detection Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Run Loop Detection Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    return { companyId, agentId };
  }

  // Seeds `count` terminal runs sharing one (issueId, wakeReason) group inside
  // the detector window. They carry no wakeup request, so recovery never tries
  // to claim them; they exist only as history the detector groups over.
  async function insertGroupHistory(
    companyId: string,
    agentId: string,
    issueId: string,
    wakeReason: string,
    count: number,
  ) {
    const now = Date.now();
    for (let i = 0; i < count; i += 1) {
      const at = new Date(now - (i + 1) * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        scopeKind: "company",
        status: "succeeded",
        invocationSource: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { issueId, wakeReason },
        createdAt: at,
        startedAt: at,
        finishedAt: new Date(at.getTime() + 1_000),
      });
    }
  }

  // A manual wake from a user. It resolves its identity from the receipt, so it
  // can always be claimed and dispatched. Its run carries no group context, so
  // it never contributes to a detector group itself.
  async function insertClaimableRun(companyId: string, agentId: string) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      runId,
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      payload: { manualUserWake: true },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      createdAt: new Date(),
    });
    return { runId, wakeupRequestId };
  }

  function collectLoopEvents(companyId: string) {
    const events: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.type === "heartbeat.run_loop_suspected") events.push(event);
    });
    return { events, unsubscribe };
  }

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.id} = ${runId}`)
      .then((rows) => rows[0] ?? null);
  }

  it("emits heartbeat.run_loop_suspected through the public dispatch path when a group crosses the threshold", async () => {
    const { companyId, agentId } = await insertAgent();
    await insertGroupHistory(companyId, agentId, "issue-A", "issue_commented", LOOP_DETECTOR_THRESHOLD);
    const { runId } = await insertClaimableRun(companyId, agentId);
    const { events, unsubscribe } = collectLoopEvents(companyId);

    try {
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
    } finally {
      unsubscribe();
    }

    // Dispatch completed normally.
    expect(await runStatus(runId)).toMatchObject({ status: "succeeded" });
    expect(mockAdapterExecute).toHaveBeenCalledOnce();
    // ...and the detector observed the loop and published exactly one signal.
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      agentId,
      issueId: "issue-A",
      wakeReason: "issue_commented",
      count: LOOP_DETECTOR_THRESHOLD,
      threshold: LOOP_DETECTOR_THRESHOLD,
    });
  });

  it("still dispatches queued runs when the detector throws", async () => {
    const { companyId, agentId } = await insertAgent();
    // A group that WOULD cross the threshold, so the only reason no event fires
    // is the forced detector failure (not an empty window).
    await insertGroupHistory(companyId, agentId, "issue-A", "issue_commented", LOOP_DETECTOR_THRESHOLD);
    const { runId } = await insertClaimableRun(companyId, agentId);
    const { events, unsubscribe } = collectLoopEvents(companyId);

    const callsBefore = detectorControl.calls;
    detectorControl.failNext = true;
    try {
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
    } finally {
      detectorControl.failNext = false;
      unsubscribe();
    }

    // Detection ran (and threw) — this is the failure path, not a skipped detector.
    expect(detectorControl.calls).toBeGreaterThan(callsBefore);
    // Dispatch still succeeded despite the detector error being swallowed.
    expect(await runStatus(runId)).toMatchObject({ status: "succeeded" });
    expect(mockAdapterExecute).toHaveBeenCalledOnce();
    // No signal is published when detection fails.
    expect(events).toEqual([]);
  });

  it("keeps each group's cooldown separate so a new loop still emits while another is cooling down", async () => {
    const { companyId, agentId } = await insertAgent();
    await insertGroupHistory(companyId, agentId, "issue-A", "issue_commented", LOOP_DETECTOR_THRESHOLD);
    const { events, unsubscribe } = collectLoopEvents(companyId);

    try {
      // Dispatch 1: group A crosses the threshold -> one signal.
      const first = await insertClaimableRun(companyId, agentId);
      await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
      await heartbeat.drainActiveRunExecutions();
      expect(await runStatus(first.runId)).toMatchObject({ status: "succeeded" });
      expect(events.map((event) => event.payload.issueId)).toEqual(["issue-A"]);

      // Dispatch 2: group A is still over the threshold but on cooldown -> silent.
      const second = await insertClaimableRun(companyId, agentId);
      await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
      await heartbeat.drainActiveRunExecutions();
      expect(await runStatus(second.runId)).toMatchObject({ status: "succeeded" });
      expect(events.map((event) => event.payload.issueId)).toEqual(["issue-A"]);

      // Dispatch 3: a distinct group B crosses the threshold. Its cooldown is
      // tracked separately, so it emits even while group A is still cooling down.
      await insertGroupHistory(companyId, agentId, "issue-B", "issue_commented", LOOP_DETECTOR_THRESHOLD);
      const third = await insertClaimableRun(companyId, agentId);
      await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
      await heartbeat.drainActiveRunExecutions();
      expect(await runStatus(third.runId)).toMatchObject({ status: "succeeded" });
      expect(events.map((event) => event.payload.issueId)).toEqual(["issue-A", "issue-B"]);
    } finally {
      unsubscribe();
    }
  });
});
