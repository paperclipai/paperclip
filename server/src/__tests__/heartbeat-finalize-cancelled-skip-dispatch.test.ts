import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "ok",
    resultJson: { ok: true } as Record<string, unknown>,
    provider: "test",
    model: "test-model",
  })),
);

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
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres finalize-cancelled tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("executeRun finalize: cancelled status skips next-queued dispatch", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-finalize-cancelled-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "ok",
      resultJson: { ok: true },
      provider: "test",
      model: "test-model",
    }));
    // TRUNCATE CASCADE handles the activity_log FK to heartbeat_runs that the
    // claim + finalize paths populate. Plain row-delete hits a 23503 ordering
    // problem because activity_log has no ON DELETE CASCADE on run_id.
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Cancel-Dispatch Co",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    createdAt: Date;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "queued",
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: {},
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    return runId;
  }

  async function getRunStatus(runId: string): Promise<string | null> {
    const row = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    return row?.status ?? null;
  }

  // Polls until predicate is true or `timeoutMs` elapses. Resolves to the
  // observed status either way (caller asserts). Used to defend against the
  // fire-and-forget `void executeRun` chain — the second-run dispatch
  // completes on a microtask the test does not directly await.
  async function waitForStatus(
    runId: string,
    predicate: (status: string | null) => boolean,
    timeoutMs = 1_500,
    pollMs = 25,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    let observed = await getRunStatus(runId);
    while (!predicate(observed) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      observed = await getRunStatus(runId);
    }
    return observed;
  }

  it("does not dispatch the next queued run when the just-finished run is cancelled", async () => {
    const { companyId, agentId } = await seedAgent();
    const t0 = new Date("2026-05-19T00:00:00.000Z");
    const t1 = new Date("2026-05-19T00:00:01.000Z");
    const firstRunId = await seedQueuedRun({ companyId, agentId, createdAt: t0 });
    const secondRunId = await seedQueuedRun({ companyId, agentId, createdAt: t1 });

    // Mock adapter flips the running run to cancelled mid-execute. executeRun's
    // post-adapter status computation observes cancelled (terminal) and finalizes
    // the run as cancelled. The finally block then needs to skip the next-queued
    // dispatch — which is the production fix this test guards. Without the fix,
    // startNextQueuedRunForAgent claims the second run and flips it to running,
    // exactly the duplicate dispatch cancelRunInternal already performs.
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: new Date(),
          errorCode: "cancelled",
          error: "Cancelled mid-flight by test",
        })
        .where(eq(heartbeatRuns.id, firstRunId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "cancelled",
        resultJson: { cancelled: true },
        provider: "test",
        model: "test-model",
      };
    });

    await heartbeat.__test_executeRunForTesting(firstRunId);

    expect(await getRunStatus(firstRunId)).toBe("cancelled");

    // Run #2 must remain queued — assert via a short stability window rather
    // than a single point read. If the fix is reverted, the duplicate dispatch
    // typically lands within a few ms of executeRun's finally completing; a
    // 200ms quiescence check is enough to catch it deterministically.
    const stabilityWindowMs = 200;
    const tStart = Date.now();
    let observedDispatch: string | null = null;
    while (Date.now() - tStart < stabilityWindowMs) {
      const status = await getRunStatus(secondRunId);
      if (status !== "queued") {
        observedDispatch = status;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(observedDispatch, "second run should remain queued (no dispatch)").toBeNull();
  });

  it("still dispatches the next queued run when the finished run succeeded", async () => {
    const { companyId, agentId } = await seedAgent();
    const t0 = new Date("2026-05-19T00:00:00.000Z");
    const t1 = new Date("2026-05-19T00:00:01.000Z");
    const firstRunId = await seedQueuedRun({ companyId, agentId, createdAt: t0 });
    const secondRunId = await seedQueuedRun({ companyId, agentId, createdAt: t1 });

    // Default adapter mock returns success without mutating status. executeRun
    // finalizes run #1 as 'succeeded'. The finally block must still dispatch
    // run #2 via startNextQueuedRunForAgent — this is the existing production
    // contract and guards against the cancellation skip over-firing.
    await heartbeat.__test_executeRunForTesting(firstRunId);

    expect(await getRunStatus(firstRunId)).toBe("succeeded");

    // run #2 was claimed by the dispatch chain; the void executeRun for run #2
    // is fire-and-forget and may still be in flight. Poll for the status to
    // transition off 'queued' rather than relying on a single read — defends
    // against microtask deferral in the dispatch path.
    const secondStatus = await waitForStatus(secondRunId, (s) => s !== "queued");
    expect(secondStatus, "second run should have been dispatched off 'queued'").not.toBe("queued");
    expect(secondStatus).not.toBeNull();
  });
});
