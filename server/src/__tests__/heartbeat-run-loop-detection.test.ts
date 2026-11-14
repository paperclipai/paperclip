import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
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
const detectorControl = vi.hoisted(
  () => ({ failNext: false, calls: 0, blockOn: null as Promise<void> | null }),
);
vi.mock("../services/run-loop-detector.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../services/run-loop-detector.ts")>(
      "../services/run-loop-detector.ts",
    );
  return {
    ...actual,
    detectRunLoops: async (input: Parameters<typeof actual.detectRunLoops>[0]) => {
      detectorControl.calls += 1;
      // `blockOn` gates detection so a test can hold the detector open and prove
      // dispatch does not wait for it (the dispatch path awaits detectRunLoops).
      if (detectorControl.blockOn) await detectorControl.blockOn;
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
    detectorControl.blockOn = null;
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

  // A persisted issue the detector can attribute an issue-scoped loop to. The
  // saved heartbeat_runs.issueId column has a foreign key to this row.
  async function insertIssue(companyId: string, title = "Run loop detection issue") {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title });
    return issueId;
  }

  // Seeds `count` terminal issue-scoped runs sharing one (saved issueId,
  // wakeReason) group inside the detector window. They carry no wakeup request,
  // so recovery never tries to claim them; they exist only as history the
  // detector groups over.
  //
  // `snapshotIssueId` models cross-task coalescing: the mutable
  // contextSnapshot.issueId can be rewritten to another issue after creation,
  // but the saved issueId column — the read boundary — stays put. When omitted
  // the snapshot mirrors the saved binding, as the enqueue path writes it.
  async function insertGroupHistory(
    companyId: string,
    agentId: string,
    savedIssueId: string,
    wakeReason: string,
    count: number,
    snapshotIssueId: string = savedIssueId,
  ) {
    const now = Date.now();
    const rows = Array.from({ length: count }, (_unused, i) => {
      const at = new Date(now - (i + 1) * 60_000);
      return {
        id: randomUUID(),
        companyId,
        agentId,
        scopeKind: "issue" as const,
        issueId: savedIssueId,
        status: "succeeded",
        invocationSource: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { issueId: snapshotIssueId, wakeReason },
        createdAt: at,
        startedAt: at,
        finishedAt: new Date(at.getTime() + 1_000),
      };
    });
    await db.insert(heartbeatRuns).values(rows);
  }

  // Seeds `count` company-scoped runs, each in its own single-run group (a
  // distinct wakeReason), all NEWER than `olderThanMs` ago. None qualifies as a
  // loop on its own; they exist only to crowd the recency-ordered fetch so a
  // regression that re-limited the fetch by row count would drop the older
  // qualifying loop below the horizon.
  async function insertUnrelatedNewerRuns(
    companyId: string,
    agentId: string,
    count: number,
  ) {
    const now = Date.now();
    const rows = Array.from({ length: count }, (_unused, i) => {
      // 10s apart keeps all of them well inside the detector window while still
      // newer than the (minutes-old) qualifying loop runs.
      const at = new Date(now - (i + 1) * 10_000);
      return {
        id: randomUUID(),
        companyId,
        agentId,
        scopeKind: "company" as const,
        status: "succeeded",
        invocationSource: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { wakeReason: `unrelated-${i}` },
        createdAt: at,
        startedAt: at,
        finishedAt: new Date(at.getTime() + 1_000),
      };
    });
    await db.insert(heartbeatRuns).values(rows);
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

  // Rejects if `p` does not settle within `ms`. Before the fire-and-forget fix,
  // dispatch awaited the detector inline, so a gated detector would hang the
  // resume call and trip this timeout.
  async function resolvesWithin<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
    const issueA = await insertIssue(companyId);
    await insertGroupHistory(companyId, agentId, issueA, "issue_commented", LOOP_DETECTOR_THRESHOLD);
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
      scopeKind: "issue",
      issueId: issueA,
      wakeReason: "issue_commented",
      count: LOOP_DETECTOR_THRESHOLD,
      threshold: LOOP_DETECTOR_THRESHOLD,
    });
  });

  it("attributes the loop to the saved issue even when the context snapshot was coalesced to another issue", async () => {
    // Privacy regression: a looping run bound to the private issueA has had its
    // mutable contextSnapshot.issueId rewritten to issueB by cross-task wake
    // coalescing. The signal (and its recentRunIds) must stay on the saved
    // issueA boundary, never leaking to viewers of issueB.
    const { companyId, agentId } = await insertAgent();
    const issueA = await insertIssue(companyId, "Private looping issue");
    const issueB = await insertIssue(companyId, "Unrelated replacement issue");
    await insertGroupHistory(
      companyId,
      agentId,
      issueA,
      "issue_commented",
      LOOP_DETECTOR_THRESHOLD,
      issueB,
    );
    const { runId } = await insertClaimableRun(companyId, agentId);
    const { events, unsubscribe } = collectLoopEvents(companyId);

    try {
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
    } finally {
      unsubscribe();
    }

    expect(await runStatus(runId)).toMatchObject({ status: "succeeded" });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ scopeKind: "issue", issueId: issueA });
    // The coalesced snapshot issue must never become the signal's boundary.
    expect(events[0].payload.issueId).not.toBe(issueB);
  });

  it("does not publish a signal for an issue-scoped loop whose issue was deleted (fail closed)", async () => {
    // Regression for the deleted-issue leak. heartbeat_runs.issue_id is
    // ON DELETE SET NULL and the scope-binding CHECK permits scope_kind='issue'
    // with issue_id NULL, so deleting a looping issue (a normal user action, and
    // a likely response to a loop) leaves its runs orphaned at
    // {scopeKind:"issue", issueId:null}. A signal built from them carries
    // issueId:null and no runId, which the live-events WS layer treats as "no
    // bindings to check" and broadcasts company-wide — while the run-read policy
    // denies those runs to everyone. The detector must drop them.
    const { companyId, agentId } = await insertAgent();
    const issueA = await insertIssue(companyId, "Deleted looping issue");
    await insertGroupHistory(companyId, agentId, issueA, "issue_commented", LOOP_DETECTOR_THRESHOLD);

    // Delete the issue; the FK sets the saved issue_id null on every seeded run,
    // reproducing the orphaned state the detector must fail closed on.
    await db.delete(issues).where(sql`${issues.id} = ${issueA}`);
    const orphaned = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(
        sql`${heartbeatRuns.agentId} = ${agentId} AND ${heartbeatRuns.scopeKind} = 'issue' AND ${heartbeatRuns.issueId} IS NULL`,
      );
    expect(orphaned[0].count).toBe(LOOP_DETECTOR_THRESHOLD);

    const { runId } = await insertClaimableRun(companyId, agentId);
    const { events, unsubscribe } = collectLoopEvents(companyId);

    try {
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
    } finally {
      unsubscribe();
    }

    // Dispatch still completes; no loop signal is published for the orphaned group.
    expect(await runStatus(runId)).toMatchObject({ status: "succeeded" });
    expect(events).toEqual([]);
  });

  it("counts a loop over the whole window even when newer unrelated runs would have filled a row-limited fetch", async () => {
    // Regression for the history-cutoff finding: the detector fetch is bounded by
    // the rolling window, not a recency-ordered row cap. The qualifying loop runs
    // are the OLDEST in the window; the 50 newer unrelated runs match the former
    // max(50, threshold) fetch cap, so the old code would have fetched only those
    // newer rows and missed the loop entirely.
    const { companyId, agentId } = await insertAgent();
    const issueA = await insertIssue(companyId);
    await insertGroupHistory(companyId, agentId, issueA, "issue_commented", LOOP_DETECTOR_THRESHOLD);
    await insertUnrelatedNewerRuns(companyId, agentId, 50);
    const { runId } = await insertClaimableRun(companyId, agentId);
    const { events, unsubscribe } = collectLoopEvents(companyId);

    try {
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
    } finally {
      unsubscribe();
    }

    expect(await runStatus(runId)).toMatchObject({ status: "succeeded" });
    // Only the real loop qualifies; the 50 unrelated runs are each their own
    // single-run group, so exactly one signal fires and it is issueA's.
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      scopeKind: "issue",
      issueId: issueA,
      count: LOOP_DETECTOR_THRESHOLD,
    });
  });

  it("still dispatches queued runs when the detector throws", async () => {
    const { companyId, agentId } = await insertAgent();
    const issueA = await insertIssue(companyId);
    // A group that WOULD cross the threshold, so the only reason no event fires
    // is the forced detector failure (not an empty window).
    await insertGroupHistory(companyId, agentId, issueA, "issue_commented", LOOP_DETECTOR_THRESHOLD);
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

  it("dispatches queued runs without waiting on the run-loop detector read", async () => {
    const { companyId, agentId } = await insertAgent();
    const issueA = await insertIssue(companyId);
    await insertGroupHistory(companyId, agentId, issueA, "issue_commented", LOOP_DETECTOR_THRESHOLD);
    const { runId } = await insertClaimableRun(companyId, agentId);
    const { events, unsubscribe } = collectLoopEvents(companyId);

    // Hold the detector open for the whole dispatch pass. The detector read is
    // an optional check: the resume pass awaits startNextQueuedRunForAgent per
    // agent in order, so awaiting the detector inline would let this one agent's
    // slow read stall every later agent. With the fire-and-forget dispatch,
    // resumeQueuedRunsForAgent must resolve even while the detector is blocked.
    let releaseDetector!: () => void;
    detectorControl.blockOn = new Promise<void>((resolve) => {
      releaseDetector = resolve;
    });

    try {
      await resolvesWithin(
        heartbeat.resumeQueuedRunsForAgent(companyId, agentId),
        3_000,
        "dispatch blocked on the run-loop detector read",
      );
      // Dispatch returned while the detector was still gated: no signal yet.
      expect(events).toEqual([]);

      // Releasing the detector lets its (now-tracked) read finish; drain waits
      // for that background promise, so the signal is observed deterministically.
      releaseDetector();
      await heartbeat.drainActiveRunExecutions();

      expect(await runStatus(runId)).toMatchObject({ status: "succeeded" });
      expect(mockAdapterExecute).toHaveBeenCalledOnce();
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ agentId, issueId: issueA });
    } finally {
      releaseDetector();
      unsubscribe();
    }
  });

  it("keeps each group's cooldown separate so a new loop still emits while another is cooling down", async () => {
    const { companyId, agentId } = await insertAgent();
    const issueA = await insertIssue(companyId, "Looping issue A");
    const issueB = await insertIssue(companyId, "Looping issue B");
    await insertGroupHistory(companyId, agentId, issueA, "issue_commented", LOOP_DETECTOR_THRESHOLD);
    const { events, unsubscribe } = collectLoopEvents(companyId);

    try {
      // Dispatch 1: group A crosses the threshold -> one signal.
      const first = await insertClaimableRun(companyId, agentId);
      await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
      await heartbeat.drainActiveRunExecutions();
      expect(await runStatus(first.runId)).toMatchObject({ status: "succeeded" });
      expect(events.map((event) => event.payload.issueId)).toEqual([issueA]);

      // Dispatch 2: group A is still over the threshold but on cooldown -> silent.
      const second = await insertClaimableRun(companyId, agentId);
      await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
      await heartbeat.drainActiveRunExecutions();
      expect(await runStatus(second.runId)).toMatchObject({ status: "succeeded" });
      expect(events.map((event) => event.payload.issueId)).toEqual([issueA]);

      // Dispatch 3: a distinct group B crosses the threshold. Its cooldown is
      // tracked separately, so it emits even while group A is still cooling down.
      await insertGroupHistory(companyId, agentId, issueB, "issue_commented", LOOP_DETECTOR_THRESHOLD);
      const third = await insertClaimableRun(companyId, agentId);
      await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
      await heartbeat.drainActiveRunExecutions();
      expect(await runStatus(third.runId)).toMatchObject({ status: "succeeded" });
      expect(events.map((event) => event.payload.issueId)).toEqual([issueA, issueB]);
    } finally {
      unsubscribe();
    }
  });
});
