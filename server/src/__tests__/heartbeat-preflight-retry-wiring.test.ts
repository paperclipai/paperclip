import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * DB-backed integration coverage for the FUL-6386 wiring of the FUL-6364 G2
 * preflight + G3 retry-suppression modules into the heartbeat hot path.
 *
 * The adapter is mocked so `execute()` returns a controlled result, which lets
 * us drive each G3 failure class deterministically through the real
 * `executeRun` lifecycle (claim -> preflight -> spawn -> failure handler) and
 * assert the observable issue/run state:
 *   - deterministic failure (auth/config/...) -> issue blocked after ONE
 *     failure, no retry scheduled;
 *   - quota/rate failure -> deferred (bounded retry scheduled), issue NOT
 *     blocked;
 *   - transient/unknown failure -> existing behavior preserved (no block, no
 *     deterministic defer);
 *   - clean path -> adapter is actually spawned and the run succeeds (proves
 *     preflight does not false-positive on a well-configured run).
 */

const adapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    sessionParams: { sessionId: "session-1" },
    sessionDisplayId: "session-1",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      type: "codex_local",
      supportsLocalAgentJwt: false,
      execute: adapterExecute,
    })),
    listAdapterModelProfiles: async () => [],
    runningProcesses: new Map(),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres preflight/retry wiring tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

/**
 * `executeRun` is fire-and-forget: the run row reaches a terminal status BEFORE
 * the post-failure handler (G3 classification, issue block/defer, run events)
 * finishes. The acquired Local environment lease is released in the outer
 * finally only after all of that completes, so waiting for the lease to release
 * is a reliable "run fully settled" signal and avoids racing teardown.
 */
async function waitForRunSettled(
  db: ReturnType<typeof createDb>,
  runId: string,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const leases = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.heartbeatRunId, runId));
    if (leases.length > 0 && leases.every((lease) => lease.status !== "active")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeEmbeddedPostgres("heartbeat preflight + retry-policy wiring (FUL-6386)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-preflight-retry-wiring-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    adapterExecute.mockReset();
    adapterExecute.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionParams: { sessionId: "session-1" },
      sessionDisplayId: "session-1",
      provider: "test",
      model: "test-model",
    });
    // TRUNCATE ... CASCADE avoids FK-ordering races against any background
    // run post-processing that is still settling at teardown time.
    await db.execute(sql.raw('TRUNCATE TABLE "companies" CASCADE'));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRunnableIssue(
    adapterConfig: Record<string, unknown> = {},
  ): Promise<{
    companyId: string;
    agentId: string;
    issueId: string;
  }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      // Default: no `env` bindings -> empty secret manifest -> preflight has
      // nothing to block on (the reachable clean path). Tests that exercise a
      // secret-resolution hard-fail pass an `adapterConfig` with a secret_ref
      // env binding.
      adapterConfig,
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Wiring integration fixture",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function driveRun(agentId: string, issueId: string) {
    const queued = await heartbeat.invoke(agentId, "assignment", { issueId }, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    // Wait for the async post-failure handler (block/defer + events) to finish
    // before asserting on issue/run state.
    await waitForRunSettled(db, queued!.id);
    return finished;
  }

  async function scheduledRetryRunsForAgent(agentId: string) {
    const rows = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    return rows.filter((row) => row.status === "scheduled_retry");
  }

  it("hard-fails preflight (secret unbound) and blocks WITHOUT spawning the adapter (FUL-6404)", async () => {
    // Agent requires an env secret bound to a secret_ref that does not exist.
    // resolveExecutionRunAdapterConfig -> resolveAdapterConfigForRuntime then
    // throws on resolution; the G2 preflight wiring must translate that into a
    // `preflight_secret_unbound` hard-fail (block, no spawn, no retry) instead
    // of letting it fall through to a generic adapter_failed setup error.
    const { agentId, issueId } = await seedRunnableIssue({
      env: {
        REQUIRED_API_KEY: { type: "secret_ref", secretId: randomUUID(), version: "latest" },
      },
    });

    const queued = await heartbeat.invoke(agentId, "assignment", { issueId }, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("failed");

    // The block happens in the async post-failure handler that runs after the
    // run row reaches its terminal status. NOTE: we deliberately do NOT use
    // waitForRunSettled here — that waits for a Local environment lease to
    // release, but the hard-fail preflight blocks the run UPSTREAM of any lease
    // acquisition, so no lease is ever created. Poll the issue status instead.
    const deadline = Date.now() + 5_000;
    let issueStatus: string | null = null;
    while (Date.now() < deadline) {
      issueStatus = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]?.status ?? null);
      if (issueStatus === "blocked") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // The adapter child must never be spawned: the run is blocked at preflight,
    // upstream of any adapter.execute() call.
    expect(adapterExecute).not.toHaveBeenCalled();

    const failedRun = await db
      .select({ errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, finished!.id))
      .then((rows) => rows[0] ?? null);
    expect(failedRun?.errorCode).toBe("preflight_secret_unbound");

    expect(issueStatus).toBe("blocked");

    // Hard-fail is non-retryable: no bounded retry is scheduled.
    const retries = await scheduledRetryRunsForAgent(agentId);
    expect(retries).toHaveLength(0);
  }, 15_000);

  it("blocks the issue after one deterministic (auth) adapter failure and schedules no retry", async () => {
    const { agentId, issueId } = await seedRunnableIssue();
    adapterExecute.mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "adapter_failed",
      errorMessage: "401 unauthorized: invalid api key",
      provider: "test",
      model: "test-model",
    });

    const finished = await driveRun(agentId, issueId);
    expect(finished?.status).toBe("failed");
    expect(adapterExecute).toHaveBeenCalledTimes(1);

    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const retries = await scheduledRetryRunsForAgent(agentId);
    expect(retries).toHaveLength(0);
  });

  it("defers (schedules a bounded retry) on a quota failure and does NOT block the issue", async () => {
    const { agentId, issueId } = await seedRunnableIssue();
    adapterExecute.mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "adapter_failed",
      errorMessage: "insufficient quota for billing window",
      provider: "test",
      model: "test-model",
    });

    const finished = await driveRun(agentId, issueId);
    expect(finished?.status).toBe("failed");

    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).not.toBe("blocked");

    const retries = await scheduledRetryRunsForAgent(agentId);
    expect(retries.length).toBeGreaterThanOrEqual(1);
    expect(retries[0]?.scheduledRetryReason ?? "").toContain("retry_deferred_quota");
  });

  it("preserves existing behavior on a transient failure (no deterministic block, no defer)", async () => {
    const { agentId, issueId } = await seedRunnableIssue();
    adapterExecute.mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "adapter_failed",
      errorMessage: "ECONNRESET: connection reset by peer",
      provider: "test",
      model: "test-model",
    });

    const finished = await driveRun(agentId, issueId);
    expect(finished?.status).toBe("failed");

    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    // Transient failures are NOT deterministically blocked by G3.
    expect(issue?.status).not.toBe("blocked");

    // And they are not deferred under the quota/rate cooldown reason.
    const retries = await scheduledRetryRunsForAgent(agentId);
    for (const retry of retries) {
      expect(retry.scheduledRetryReason ?? "").not.toContain("retry_deferred");
    }
  });

  it("spawns the adapter (preflight does not false-block a well-configured run)", async () => {
    const { agentId, issueId } = await seedRunnableIssue();
    // Default mock returns exitCode 0. We only assert the adapter was actually
    // spawned and preflight did not block the run; we deliberately do NOT assert
    // a stable terminal status here, because a successful run triggers the
    // separate finish-successful-run handoff path (out of scope for this test).
    await driveRun(agentId, issueId);
    expect(adapterExecute.mock.calls.length).toBeGreaterThanOrEqual(1);

    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).not.toBe("blocked");
  });
});
