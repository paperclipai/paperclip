import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres lease-release terminalization tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("heartbeat terminalizeRunOnLeaseRelease", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lease-release-terminal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: { issueStatus: string; runStatus: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Terminalize on lease release",
      status: input.issueStatus,
      priority: "high",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: input.runStatus,
      invocationSource: "manual",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);

    return { companyId, agentId, issueId, runId, run };
  }

  it("forces a still-running run to succeeded when the issue already reached done", async () => {
    // This reproduces the defect: the agent PATCHed the issue to done, but the
    // teardown released the environment lease before the run-terminal write.
    const { issueId, runId, run } = await seed({ issueStatus: "done", runStatus: "running" });

    const heartbeat = heartbeatService(db);
    const terminal = await heartbeat.terminalizeRunOnLeaseRelease(run);

    expect(terminal.status).toBe("succeeded");

    const runStatus = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.status);
    expect(runStatus).toBe("succeeded");

    const issueStatus = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]?.status);
    expect(issueStatus).toBe("done");

    const event = await db
      .select({ message: heartbeatRunEvents.message, payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .then((rows) => rows[0]);
    expect(event?.message).toContain("lease release");
    expect((event?.payload as { terminalStatus?: string } | null)?.terminalStatus).toBe("succeeded");
  });

  it("forces a still-running run to interrupted when the issue is not terminal", async () => {
    const { runId, run } = await seed({ issueStatus: "in_progress", runStatus: "running" });

    const heartbeat = heartbeatService(db);
    const terminal = await heartbeat.terminalizeRunOnLeaseRelease(run);

    expect(terminal.status).toBe("interrupted");

    const row = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("interrupted");
    expect(row?.errorCode).toBe("lease_released_before_terminal");
  });

  it("forces a still-queued run to interrupted when the lease releases before it starts", async () => {
    // A queued run holds a lease but never reached "running". The teardown
    // released the lease, so the run must not stay queued and show a phantom
    // live run. A running-only update would miss it.
    const { runId, run } = await seed({ issueStatus: "in_progress", runStatus: "queued" });

    const heartbeat = heartbeatService(db);
    const terminal = await heartbeat.terminalizeRunOnLeaseRelease(run);

    expect(terminal.status).toBe("interrupted");

    const row = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("interrupted");
    expect(row?.errorCode).toBe("lease_released_before_terminal");
  });

  it("forces a still-queued run to succeeded when the issue already reached done", async () => {
    const { runId, run } = await seed({ issueStatus: "done", runStatus: "queued" });

    const heartbeat = heartbeatService(db);
    const terminal = await heartbeat.terminalizeRunOnLeaseRelease(run);

    expect(terminal.status).toBe("succeeded");

    const runStatus = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.status);
    expect(runStatus).toBe("succeeded");
  });

  it("keeps an already-terminal run authoritative and records no new event", async () => {
    const { runId, run } = await seed({ issueStatus: "done", runStatus: "failed" });

    const heartbeat = heartbeatService(db);
    const terminal = await heartbeat.terminalizeRunOnLeaseRelease(run);

    expect(terminal.status).toBe("failed");

    const runStatus = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.status);
    expect(runStatus).toBe("failed");

    const eventCount = await db
      .select({ id: heartbeatRunEvents.id })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .then((rows) => rows.length);
    expect(eventCount).toBe(0);
  });
});
