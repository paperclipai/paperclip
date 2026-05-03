import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
  workspaceLocks,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// Controllable mock adapter: each call resolves only when test code calls `releaseAdapter()`.
// This lets us hold a heartbeat run in `running` state long enough to deterministically
// race a second heartbeat against the same workspace cwd.
type Deferred = { promise: Promise<void>; resolve: () => void };
function defer(): Deferred {
  let resolveFn!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

const adapterDeferreds: Deferred[] = [];

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "workspace mutex test run",
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat workspace-mutex tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitFor<T>(fn: () => Promise<T | null | false | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result as T;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const last = await fn();
  if (!last) throw new Error("waitFor timed out");
  return last as T;
}

describeEmbeddedPostgres("heartbeat per-cwd workspace mutex (RUN-21)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let sharedCwd!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-mutex-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    sharedCwd = await mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-mutex-"));
  }, 30_000);

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
    if (sharedCwd) {
      await rm(sharedCwd, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("serializes two heartbeats targeting the same project workspace cwd", async () => {
    // Each adapter execution gets its own deferred; tests resolve them in order to control timing.
    adapterDeferreds.length = 0;
    mockAdapterExecute.mockImplementation(async () => {
      const slot = defer();
      adapterDeferreds.push(slot);
      await slot.promise;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "workspace mutex test run",
        provider: "test",
        model: "test-model",
      };
    });

    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Mutex Co",
      slug: `mutex-${companyId.slice(0, 8)}`,
    });

    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Shared Site" });

    const projectWorkspaceId = randomUUID();
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Shared Workspace",
      sourceType: "local_path",
      cwd: sharedCwd,
      isPrimary: true,
    });

    const agentA = randomUUID();
    const agentB = randomUUID();
    await db.insert(agents).values([
      {
        id: agentA,
        companyId,
        name: "AgentA",
        role: "engineer",
        status: "active",
        adapterType: "noop",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
      {
        id: agentB,
        companyId,
        name: "AgentB",
        role: "engineer",
        status: "active",
        adapterType: "noop",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
    ]);

    const issueA = randomUUID();
    const issueB = randomUUID();
    await db.insert(issues).values([
      {
        id: issueA,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Issue A",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentA,
      },
      {
        id: issueB,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Issue B",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentB,
      },
    ]);

    // Wake AgentA first; it'll claim the workspace lock and block on the deferred adapter.
    const wakeA = await heartbeat.wakeup(agentA, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issueA, projectId, projectWorkspaceId },
      contextSnapshot: {
        issueId: issueA,
        projectId,
        projectWorkspaceId,
        wakeReason: "issue_assigned",
      },
    });
    expect(wakeA).not.toBeNull();

    // Wait until AgentA's adapter has been entered (proves the lock is held).
    await waitFor(async () => adapterDeferreds.length >= 1);
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(workspaceLocks).then((r) => r[0]?.n))
      .toBe(1);

    // Wake AgentB on the SAME cwd; it must defer.
    const wakeB = await heartbeat.wakeup(agentB, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issueB, projectId, projectWorkspaceId },
      contextSnapshot: {
        issueId: issueB,
        projectId,
        projectWorkspaceId,
        wakeReason: "issue_assigned",
      },
    });
    expect(wakeB).not.toBeNull();

    // The adapter for AgentB should NEVER have been entered.
    const failedRunB = await waitFor(async () => {
      const row = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wakeB!.id))
        .then((rows) => rows[0] ?? null);
      return row && row.status === "failed" ? row : null;
    });
    expect(failedRunB.errorCode).toBe("workspace_busy");
    expect(failedRunB.error).toContain("is held by run");

    // A deferred wake row should be present for AgentB's cwd.
    const deferredWake = await waitFor(async () => {
      const row = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.status, "deferred_workspace_lock"),
            sql`${agentWakeupRequests.payload} ->> 'cwdPath' = ${sharedCwd}`,
          ),
        )
        .then((rows) => rows[0] ?? null);
      return row;
    });
    expect(deferredWake.agentId).toBe(agentB);
    expect(adapterDeferreds.length).toBe(1);

    // Release AgentA's run; the workspace lock should drop and the deferred wake should be promoted.
    adapterDeferreds[0].resolve();

    // AgentA's run should reach `succeeded`.
    await waitFor(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wakeA!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded" ? run : null;
    });

    // The lock row should be gone.
    await waitFor(async () => {
      const n = await db.select({ n: sql<number>`count(*)::int` }).from(workspaceLocks).then((r) => r[0]?.n);
      return n === 0 ? true : null;
    });

    // The deferred wake should have been promoted (status no longer `deferred_workspace_lock`)
    // and a fresh wakeupRequest with reason `workspace_lock_released` should have been created.
    await waitFor(async () => {
      const promoted = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredWake.id))
        .then((rows) => rows[0]?.status ?? null);
      return promoted === "promoted" ? true : null;
    });

    const followUpWake = await waitFor(async () => {
      const row = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.agentId, agentB),
            eq(agentWakeupRequests.reason, "workspace_lock_released"),
          ),
        )
        .orderBy(asc(agentWakeupRequests.requestedAt))
        .then((rows) => rows[0] ?? null);
      return row;
    });
    expect(followUpWake.payload).toMatchObject({
      cwdPath: sharedCwd,
      releasedByRunId: wakeA!.id,
      issueId: issueB,
    });

    // The promoted wake schedules AgentB's next run; release its adapter and verify it succeeds.
    await waitFor(async () => adapterDeferreds.length >= 2);
    adapterDeferreds[1].resolve();

    const followUpRun = await waitFor(async () => {
      const row = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.agentId, agentB),
            sql`${heartbeatRuns.id} <> ${wakeB!.id}`,
          ),
        )
        .orderBy(asc(heartbeatRuns.createdAt))
        .then((rows) => rows[rows.length - 1] ?? null);
      return row && row.status === "succeeded" ? row : null;
    });
    expect(followUpRun.status).toBe("succeeded");

    // No leftover locks at the end.
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(workspaceLocks).then((r) => r[0]?.n))
      .toBe(0);

    // No per-test row cleanup — afterAll() drops the embedded postgres instance.
  }, 30_000);
});
