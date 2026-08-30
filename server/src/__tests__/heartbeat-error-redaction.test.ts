import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentRuntimeState,
  agentTaskSessions,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { subscribeCompanyLiveEvents } from "../services/live-events.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const TEST_ADAPTER_TYPE = "heartbeat_error_redaction_test";
const CREDENTIAL_VALUE = "hap128-secret-value";
const CREDENTIAL_PREFIX = "hap128-secret-";
const CREDENTIAL_SUFFIX = "value";
const DIAGNOSTIC = "Provider rejected request";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat error-redaction tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat error redaction", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let throwAfterLog = false;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-error-redaction-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: TEST_ADAPTER_TYPE,
      execute: async ({ onLog }) => {
        // Adapter process streams have arbitrary chunk boundaries. Split both
        // the sensitive field name and value so per-chunk redaction cannot see
        // the credential. Keep stderr unterminated to prove completion flushes
        // the final buffered line before durable run finalization.
        await onLog("stdout", "adapter stdout api");
        await onLog("stdout", `Key: \"${CREDENTIAL_PREFIX}`);
        await onLog("stdout", `${CREDENTIAL_SUFFIX}\"\n`);
        // Some adapters fire-and-forget log callbacks. The heartbeat finalizer
        // must still serialize and drain both fragments before closing the log.
        void onLog("stderr", `adapter stderr apiKey: \"${CREDENTIAL_PREFIX}`);
        void onLog("stderr", `${CREDENTIAL_SUFFIX}\"`);
        if (throwAfterLog) {
          throw new Error(`${DIAGNOSTIC} apiKey: \"${CREDENTIAL_VALUE}\" (request_id=req-42)`);
        }
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `${DIAGNOSTIC} apiKey: \"${CREDENTIAL_VALUE}\" (request_id=req-42)`,
          errorCode: "adapter_failed",
          sessionId: "session-hap-128",
        };
      },
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    throwAfterLog = false;
    await heartbeat.drainActiveRunExecutions();
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_task_sessions",
        "agent_runtime_state",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    unregisterServerAdapter(TEST_ADAPTER_TYPE);
    await tempDb?.cleanup();
  });

  it.each([
    { path: "returned adapter failure", throws: false },
    { path: "thrown adapter failure", throws: true },
  ])("redacts split adapter credentials on the $path path", async ({ throws }) => {
    throwAfterLog = throws;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const taskKey = "hap-128-task";
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Heartbeat Redaction Test",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Redaction Test Agent",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });

    const liveLogEvents: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.type === "heartbeat.run.log") liveLogEvents.push(event);
    });

    try {
      const queued = await heartbeat.invoke(agentId, "on_demand", { taskKey }, "manual");
      expect(queued).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, queued!.id);
      expect(finished?.status).toBe("failed");
      // A terminal run status is written before all dependent agent/session writes.
      // Await the service's durable execution barrier rather than an arbitrary delay.
      await heartbeat.drainActiveRunExecutions();

      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      const [taskSession] = await db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.agentId, agentId), eq(agentTaskSessions.taskKey, taskKey)));
      const [runtimeState] = await db
        .select()
        .from(agentRuntimeState)
        .where(eq(agentRuntimeState.agentId, agentId));
      const storedLog = await heartbeat.readLog(queued!.id);

      expect(run?.error).toContain(DIAGNOSTIC);
      expect(run?.stdoutExcerpt).toContain("adapter stdout");
      expect(run?.stderrExcerpt).toContain("adapter stderr");
      expect(agent).toMatchObject({ status: "error" });
      expect(agent?.errorReason).toContain(DIAGNOSTIC);
      if (throws) {
        expect(taskSession).toBeUndefined();
      } else {
        expect(taskSession?.lastError).toContain(DIAGNOSTIC);
      }
      expect(runtimeState?.lastError).toContain(DIAGNOSTIC);
      expect(storedLog.content).toContain("adapter stdout");
      expect(storedLog.content).toContain("adapter stderr");
      expect(liveLogEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            companyId,
            type: "heartbeat.run.log",
            payload: expect.objectContaining({
              runId: queued!.id,
              stream: "stdout",
              chunk: expect.stringContaining("adapter stdout"),
            }),
          }),
          expect.objectContaining({
            companyId,
            type: "heartbeat.run.log",
            payload: expect.objectContaining({
              runId: queued!.id,
              stream: "stderr",
              chunk: expect.stringContaining("adapter stderr"),
            }),
          }),
        ]),
      );

      for (const durableValue of [run, agent, taskSession, runtimeState, storedLog]) {
        const serialized = JSON.stringify(durableValue);
        expect(serialized ?? "").not.toContain(CREDENTIAL_VALUE);
        expect(serialized ?? "").not.toContain(CREDENTIAL_PREFIX);
      }
      const serializedLiveLogEvents = JSON.stringify(liveLogEvents);
      expect(serializedLiveLogEvents).not.toContain(CREDENTIAL_VALUE);
      expect(serializedLiveLogEvents).not.toContain(CREDENTIAL_PREFIX);
    } finally {
      unsubscribe();
    }
  });
});
