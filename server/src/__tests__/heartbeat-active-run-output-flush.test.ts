import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS,
  heartbeatService,
} from "../services/heartbeat.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "ok",
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
    `Skipping embedded Postgres active-run output flush tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("active-run output progress flush (RUD-985)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-active-run-output-flush-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activeRuns = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
      if (activeRuns.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "ok",
      provider: "test",
      model: "test-model",
    }));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentAndIssue(opts: { companyId: string; agentId: string; issueId: string; now: Date }) {
    const issuePrefix = `F${opts.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: opts.companyId,
      name: "Active Run Flush Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: opts.agentId,
      companyId: opts.companyId,
      name: "Coder",
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
    await db.insert(issues).values({
      id: opts.issueId,
      companyId: opts.companyId,
      title: "Drive stdout for lastOutputAt",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: opts.agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      updatedAt: opts.now,
      createdAt: opts.now,
    });
  }

  async function waitForTerminal(runId: string, timeoutMs = 10_000): Promise<typeof heartbeatRuns.$inferSelect | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [row] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);
      if (row && (row.status === "succeeded" || row.status === "failed" || row.status === "cancelled")) {
        return row;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }

  it("keeps ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS small enough for the watchdog", () => {
    // The heartbeat watchdog flags runs as "suspicious" after 1h of silence
    // and "critical" after 4h. A flush debounce larger than a few seconds
    // causes the on-disk stdout cursor to be ahead of the DB cursor, which
    // produces false-positive silent-run evaluations on long-running
    // opencode_local tasks. (RUD-985)
    expect(ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS).toBeLessThanOrEqual(5_000);
  });

  it("advances lastOutputAt near-realtime as stdout chunks arrive (regression for RUD-985)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();
    await seedAgentAndIssue({ companyId, agentId, issueId, now });

    const heartbeat = heartbeatService(db);
    const wakeRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "update" },
      contextSnapshot: { issueId, source: "issue.update" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });
    expect(wakeRun).not.toBeNull();
    const runId = wakeRun!.id;

    // Mock adapter: stream several chunks, then return success. Each chunk
    // exercises the flush path inside the heartbeat service.
    const observedTimestamps: string[] = [];
    mockAdapterExecute.mockImplementation(async (ctx: { onLog: (s: "stdout" | "stderr", c: string) => Promise<void> }) => {
      const chunks = [
        '{"type":"step_start","sessionID":"ses_rud985"}\n',
        '{"type":"text","part":{"type":"text","text":"hello"}}\n',
        '{"type":"text","part":{"type":"text","text":"world"}}\n',
        '{"type":"step_finish","part":{"reason":"stop"}}\n',
      ];
      for (const chunk of chunks) {
        await ctx.onLog("stdout", chunk);
        observedTimestamps.push(new Date().toISOString());
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "ok",
        provider: "test",
        model: "test-model",
      };
    });

    await heartbeat.resumeQueuedRuns();
    const run = await waitForTerminal(runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe("succeeded");

    // The run's lastOutputAt must be a real timestamp (not null) and the seq
    // must be at least the number of chunks we emitted (the heartbeat service
    // may also write a couple of pre-adapter log entries). This is the
    // regression assertion for RUD-985: a >60s debounce would either leave
    // lastOutputAt null OR pin it to the first chunk's time.
    expect(run!.lastOutputAt).not.toBeNull();
    expect(run!.lastOutputSeq).toBeGreaterThanOrEqual(observedTimestamps.length);
    expect(run!.lastOutputStream).toBe("stdout");
    expect(run!.lastOutputBytes).toBeGreaterThan(0);
  });

  it("does not propagate transient DB errors from the output-progress flush to the run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();
    await seedAgentAndIssue({ companyId, agentId, issueId, now });

    const heartbeat = heartbeatService(db);
    const wakeRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "update" },
      contextSnapshot: { issueId, source: "issue.update" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });
    expect(wakeRun).not.toBeNull();
    const runId = wakeRun!.id;

    // Mock adapter: emit chunks, then succeed. The run should finish
    // successfully even if a transient DB error happens during the flush.
    mockAdapterExecute.mockImplementation(async (ctx: { onLog: (s: "stdout" | "stderr", c: string) => Promise<void> }) => {
      const chunks = [
        '{"type":"text","part":{"type":"text","text":"a"}}\n',
        '{"type":"text","part":{"type":"text","text":"b"}}\n',
        '{"type":"text","part":{"type":"text","text":"c"}}\n',
      ];
      for (const chunk of chunks) {
        await ctx.onLog("stdout", chunk);
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "ok",
        provider: "test",
        model: "test-model",
      };
    });

    // Wrap db.update so the first heartbeatRuns-targeted progress flush
    // throws. The run-finalize force flush (with a fresh pending state
    // after chunks have been processed) should still be able to write
    // the final cursor, and the run should reach a terminal state.
    const originalUpdate = db.update.bind(db);
    const spy = vi.spyOn(db, "update");
    let injectedOnce = false;
    spy.mockImplementation((target: unknown, ...rest: unknown[]) => {
      const chain = (originalUpdate as unknown as (...a: unknown[]) => { set: (v: unknown) => unknown })(target, ...rest);
      if (injectedOnce) return chain;
      const tbl = target as { _?: { name?: string } } | undefined;
      if (tbl && tbl._ && tbl._.name === "heartbeat_runs") {
        // Defer injection until first .set() so we don't kill unrelated
        // updates (like the wakeup row's own update). The first
        // heartbeatRuns-targeted .set() will throw once.
        const originalSet = chain.set.bind(chain);
        chain.set = (v: unknown) => {
          if (!injectedOnce) {
            injectedOnce = true;
            throw new Error("simulated transient DB error");
          }
          return originalSet(v);
        };
      }
      return chain;
    });

    try {
      await heartbeat.resumeQueuedRuns();
      const run = await waitForTerminal(runId, 15_000);
      expect(run).not.toBeNull();
      expect(["succeeded", "failed", "cancelled"]).toContain(run!.status);
    } finally {
      spy.mockRestore();
    }
  });
});
