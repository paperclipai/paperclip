import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { DURABLE_WRITE_DENIED_ERROR_CODE } from "../services/agent-run-authority.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses } from "../adapters/index.ts";

/**
 * Lets a test act during the adapter's execution, which is the only moment that
 * matters here: a route denial lands while the run is live, and finalization
 * reads the run afterwards.
 */
const adapterHooks = vi.hoisted(() => ({
  duringExecute: null as null | ((runId: string) => Promise<void>),
}));

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (input: { runId: string }) => {
    await adapterHooks.duringExecute?.(input.runId);
    // A clean exit, on purpose. The adapter never inspected the HTTP responses
    // its session got, so as far as it knows the turn went fine.
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Durable write denial finalization test run.",
      provider: "test",
      model: "test-model",
    };
  }),
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
    `Skipping embedded Postgres durable-write denial finalization tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * FAI-9983 / FAI-9903 — a heartbeat that was refused its durable writes must
 * finalize as a failure.
 *
 * Denying the write is only half the contract. FAI-9903 is the other half: an
 * agent whose every comment and status PATCH was rejected still finished as a
 * `succeeded` run, because finalization reads the adapter's exit code and an
 * adapter that never noticed the 403s exits 0. So the exit code cannot be the
 * only evidence — a recorded denial has to outrank it.
 */
describeEmbeddedPostgres("heartbeat finalization after a denied durable write", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-durable-write-denial-finalization-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    adapterHooks.duringExecute = null;
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // Post-run bookkeeping can still write for a moment after a run reaches a
    // terminal status, so a single sweep can hit a foreign-key violation when a
    // late insert lands between two deletes. Retry until it goes through clean.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
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
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function waitForRunToFinish(runId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await db
        .select({ status: heartbeatRuns.status, error: heartbeatRuns.error, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }

  it("fails a run whose durable write was denied, even though the adapter exited 0", async () => {
    const { agentId } = await seedCompanyAndAgent();
    // Stands in for the route denial: while the run is live, a mutation it
    // attempted is refused and the refusal is recorded against it.
    adapterHooks.duringExecute = async (runId) => {
      await db
        .update(heartbeatRuns)
        .set({ errorCode: DURABLE_WRITE_DENIED_ERROR_CODE, updatedAt: new Date() })
        .where(eq(heartbeatRuns.id, runId));
    };

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(queued!.id);
    expect(finished, "run never reached a terminal status").not.toBeNull();
    expect(finished?.status).toBe("failed");
    // The terminal state has to say why, or the failure is just as unactionable
    // as the false success it replaced.
    expect(finished?.errorCode).toBe(DURABLE_WRITE_DENIED_ERROR_CODE);
    expect(finished?.error).toBeTruthy();
  }, 30_000);

  it("still succeeds a clean run when nothing was denied", async () => {
    const { agentId } = await seedCompanyAndAgent();

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(queued!.id);
    expect(finished?.status).toBe("succeeded");
    expect(finished?.errorCode).toBeNull();
  }, 30_000);
});
