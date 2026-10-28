import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentTaskRun = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentTaskRun: mockTrackAgentTaskRun,
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-release tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// An agent is flipped to status="running" at execution-start and used to have
// no path back to "idle" unless its run completed the full teardown. A SIGTERM
// during a run, or a run finalized by a recovery path, left the agent pinned on
// "running" forever. These tests pin the release behaviour at the terminal-run
// write so the leak cannot come back unnoticed.
describeEmbeddedPostgres("agent release after terminal run", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-agent-release-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentWithRun(opts: {
    agentStatus: "running" | "paused";
    runStatus: "running" | "queued";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: opts.agentStatus,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      status: "claimed",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: opts.runStatus,
      wakeupRequestId,
    });

    return { companyId, agentId, runId };
  }

  async function readAgentStatus(agentId: string) {
    const row = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    return row?.status ?? null;
  }

  it("releases a running agent to idle when its last run reaches a terminal status", async () => {
    const { agentId, runId } = await seedAgentWithRun({
      agentStatus: "running",
      runStatus: "running",
    });

    // Terminalize through the lease-release path on purpose: that is the
    // teardown that does NOT call finalizeAgentStatus, so it exercises the
    // release fallback rather than the normal completion bookkeeping.
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);
    await heartbeat.terminalizeRunOnLeaseRelease(run);

    await vi.waitFor(async () => {
      expect(await readAgentStatus(agentId)).toBe("idle");
    });
  });

  it("keeps the agent running while another run is still live", async () => {
    const { companyId, agentId, runId } = await seedAgentWithRun({
      agentStatus: "running",
      runStatus: "running",
    });

    const secondRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: secondRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
    });

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);
    await heartbeat.terminalizeRunOnLeaseRelease(run);

    // Give the background release a chance to (incorrectly) fire.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await readAgentStatus(agentId)).toBe("running");
  });

  it("does not resurrect a paused agent that owns the finished run", async () => {
    const { agentId, runId } = await seedAgentWithRun({
      agentStatus: "paused",
      runStatus: "running",
    });

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);
    await heartbeat.terminalizeRunOnLeaseRelease(run);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await readAgentStatus(agentId)).toBe("paused");
  });
});
