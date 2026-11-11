import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  closeRegisteredClients,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { AgentDirectoryOperationBusyError } from "../services/agent-directory-working-copies.js";
import { AGENT_DIRECTORY_BUSY_ERROR_CODE, AGENT_DIRECTORY_BUSY_RETRY_REASON } from "../services/heartbeat/agent-directory-busy.js";

const busyPrepares = vi.hoisted(() => ({ remaining: 0, calls: 0 }));
vi.mock("../services/agent-instruction-working-copies.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/agent-instruction-working-copies.js")>();
  return {
    ...actual,
    agentInstructionWorkingCopyService: (...args: Parameters<typeof actual.agentInstructionWorkingCopyService>) => {
      const service = actual.agentInstructionWorkingCopyService(...args);
      return {
        ...service,
        prepare: async (input: Parameters<typeof service.prepare>[0]) => {
          busyPrepares.calls++;
          if (busyPrepares.remaining > 0) {
            busyPrepares.remaining--;
            throw new AgentDirectoryOperationBusyError();
          }
          return service.prepare(input);
        },
      };
    },
  };
});

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const support = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
const ADAPTER = "agent_directory_busy_test";

describeEmbeddedPostgres("a new run that meets a busy agent directory", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const executedRunIds: string[] = [];

  beforeAll(async () => {
    if (externalTestDatabaseUrl) db = createDb(externalTestDatabaseUrl);
    else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-agent-directory-busy-");
      db = createDb(tempDb.connectionString);
    }
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: ADAPTER,
      supportsInstructionsBundle: true,
      execute: async input => {
        executedRunIds.push(input.runId);
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType: ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 20_000);

  afterAll(async () => {
    unregisterServerAdapter(ADAPTER);
    if (externalTestDatabaseUrl) await closeRegisteredClients(externalTestDatabaseUrl);
    await db.$client.end();
    await tempDb?.cleanup();
  });

  it("defers the first run of a task instead of failing it, then runs it", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "busy-directory-user" });
    await db.insert(authUsers).values({ id: "busy-directory-user", name: "Responsible user", email: "busy-directory@example.test",
      createdAt: now, updatedAt: now }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "busy-directory-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "BusyCoder", role: "engineer", status: "idle", adapterType: ADAPTER,
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Daily repair", status: "in_progress", priority: "medium",
      responsibleUserId: "busy-directory-user", assigneeAgentId: agentId, issueNumber: 1 });
    busyPrepares.remaining = 1;
    busyPrepares.calls = 0;

    const run = await heartbeat.invoke(agentId, "assignment", { issueId, wakeReason: "issue_assigned" }, "system");
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();

    const first = await heartbeat.getRun(run!.id);
    expect(first).toMatchObject({ status: "cancelled", errorCode: AGENT_DIRECTORY_BUSY_ERROR_CODE });
    expect(busyPrepares.calls).toBe(1);
    expect(executedRunIds).not.toContain(run!.id);
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: AGENT_DIRECTORY_BUSY_RETRY_REASON, scheduledRetryAttempt: 1 });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "in_progress", executionRunId: retry!.id });

    const afterDue = new Date(new Date(retry!.scheduledRetryAt!).getTime() + 1_000);
    expect((await heartbeat.promoteDueScheduledRetries(afterDue)).runIds).toContain(retry!.id);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect((await heartbeat.getRun(retry!.id))?.status).toBe("succeeded");
    expect(executedRunIds).toContain(retry!.id);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issueId)))
      .filter(row => row.status === "failed")).toEqual([]);
  });
});
