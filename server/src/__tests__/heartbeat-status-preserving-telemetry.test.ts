import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({
  track: vi.fn(),
  hashPrivateRef: vi.fn((value: string) => `hashed:${value}`),
}));
vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

import { heartbeatService } from "../services/heartbeat.ts";

function agentTaskRunCalls(fromIndex: number) {
  return mockTelemetryClient.track.mock.calls
    .slice(fromIndex)
    .filter((call) => call[0] === "agent.task_run");
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres status-preserving telemetry tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres(
  "heartbeat status-preserving run writes do not re-emit agent.task_run",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
      null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "heartbeat-status-preserving-telemetry-",
      );
      db = createDb(tempDb.connectionString);
    }, 60_000);

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    it("does not re-emit agent.task_run when a native ownership-unverified write keeps a failed run's status unchanged", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const issueId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Status Preserving Telemetry",
        issuePrefix,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Native worker",
        adapterType: "paperclip_runner",
        status: "running",
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Native ownership fixture",
        status: "in_progress",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
      // The run is already terminal ("failed") before reapOrphanedRuns runs.
      // Its process id is this test process's own pid, so isProcessAlive()
      // reports it as still alive, which is the condition that routes
      // reapOrphanedRuns into markNativeOwnershipUnverified.
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "failed",
        runtimeMode: "native",
        nativeIssueId: issueId,
        processPid: process.pid,
        contextSnapshot: { issueId },
      });
      await db.insert(nativeRunFinalizations).values({
        runId,
        companyId,
        issueId,
        phase: "retryable_failure",
        attempt: 0,
      });

      const heartbeat = heartbeatService(db);
      const callsBefore = mockTelemetryClient.track.mock.calls.length;
      await heartbeat.reapOrphanedRuns();

      const run = await db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);
      // The write only re-sets the status the run already had ("failed") while
      // patching in the ownership-unverified error fields — a status-preserving
      // update, not a new terminal transition.
      expect(run).toEqual({
        status: "failed",
        errorCode: "native_execution_ownership_unverified",
      });
      expect(agentTaskRunCalls(callsBefore)).toHaveLength(0);
    });
  },
);
