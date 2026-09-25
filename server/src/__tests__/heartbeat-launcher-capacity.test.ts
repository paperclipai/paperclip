import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, issueRecoveryActions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { execute as executeCodex } from "../../../packages/adapters/codex-local/src/server/execute.js";

// Only setup is synthetic. The launcher process, adapter parsing, persistence,
// scheduler, issue ownership and admission transactions run their real code.
vi.mock("../../../packages/adapters/codex-local/src/server/runtime-config.js", () => ({
  prepareCodexRuntimeConfig: async () => ({ cleanup: async () => {}, notes: ["Managed MCP setup complete."] }),
}));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => ({ track: () => {}, hashPrivateRef: () => "test-ref" }) }));

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Embedded Postgres unavailable: ${support.reason}`);

suite("launcher capacity through durable recovery", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let scratch: string;
  const adapterType = "launcher_capacity_test";
  const launches: string[] = [];
  const issueOwnersAtLaunch: Array<string | null> = [];

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_CODEX_AUTH_CACHE", "false");
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-capacity-launcher-"));
    await fs.writeFile(path.join(scratch, "launcher"), `#!${process.execPath}
const nonce = process.env.PAPERCLIP_LAUNCHER_NONCE;
delete process.env.PAPERCLIP_LAUNCHER_NONCE;
process.stderr.write('launcher: no free slot\\n');
process.stderr.write('paperclip-launcher:v1:capacity_unavailable:' + nonce + '\\n');
process.exit(5);
`, { mode: 0o755 });
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-launcher-capacity-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({ type: adapterType,
      execute: async (context) => {
        launches.push(context.runId);
        const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, context.agent.companyId),
          eq(issues.id, String(context.context.issueId))));
        issueOwnersAtLaunch.push(issue?.executionRunId ?? null);
        return executeCodex({ ...context, config: { engine: "cli", launcherCapacityRecovery: true,
          command: path.join(scratch, "launcher"), cwd: scratch, outputInactivityTimeoutMs: null,
          env: { CODEX_HOME: path.join(scratch, "codex-home"), OPENAI_API_KEY: "test-only" } } });
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  });

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await tempDb?.cleanup();
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("keeps setup logs, cools queued retries, admits each once and exhausts the existing two-retry budget", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Capacity test", issuePrefix: "CAP",
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "test-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Capacity test", role: "engineer",
      status: "idle", adapterType, adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 3 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Keep task ownership", status: "todo",
      priority: "medium", assigneeAgentId: agentId, responsibleUserId: "test-user",
      issueNumber: 1, identifier: "CAP-1" });
    const context = { issueId, wakeReason: "issue_assigned", taskPayload: { instruction: "Retain me" } };
    let run = await heartbeat.invoke(agentId, "on_demand", context, "manual");
    expect(run).not.toBeNull();
    const peer = heartbeatService(db);

    for (let attempt = 0; attempt <= 2; attempt += 1) {
      await heartbeat.drainActiveRunExecutions();
      await peer.drainActiveRunExecutions();
      const failed = await heartbeat.getRun(run!.id);
      expect(failed).toMatchObject({ status: "failed", exitCode: 5, errorCode: "launcher_capacity_unavailable",
        scheduledRetryAttempt: attempt, resultJson: { stdout: "", executionRecovery: {
          kind: "bootstrap", providerWorkStarted: false, launcher: { version: 1, outcome: "capacity_unavailable" },
        } } });
      expect(failed?.stdoutExcerpt).toContain("Managed MCP setup complete.");
      expect(failed?.resultJson?.errorFamily).toBeUndefined();
      expect(launches.filter((id) => id === run!.id)).toHaveLength(1);
      const children = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
      if (attempt === 2) {
        expect(children).toHaveLength(0);
        expect(await heartbeat.scheduleBoundedRetry(run!.id)).toMatchObject({ outcome: "retry_exhausted" });
        break;
      }
      expect(children).toHaveLength(1);
      const retry = children[0]!;
      expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]?.status).toBe("idle");
      expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: attempt + 1,
        contextSnapshot: { issueId, taskPayload: context.taskPayload } });
      expect(retry.contextSnapshot).not.toHaveProperty("codexTransientFallbackMode");
      await Promise.all([heartbeat.scheduleBoundedRetry(run!.id), peer.scheduleBoundedRetry(run!.id)]);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id))).toHaveLength(1);
      const due = new Date(retry.scheduledRetryAt!.getTime() + 1);
      await Promise.all([heartbeat.promoteDueScheduledRetries(due), peer.promoteDueScheduledRetries(due)]);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      expect((await heartbeat.getRun(retry.id))?.status).toBe("queued");
      expect(launches).not.toContain(retry.id);
      // Move only durable history past cooldown; preserve retry and wake identity.
      await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 60_000) })
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "failed")));
      await Promise.all([heartbeat.resumeQueuedRuns(), peer.resumeQueuedRuns()]);
      run = await heartbeat.getRun(retry.id);
    }
    expect(launches).toHaveLength(3);
    expect(issueOwnersAtLaunch).toEqual(launches);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.executionRunId).toBeNull();
    const recovery = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({ status: "active", ownerType: "board", cause: "legacy_execution_requires_reconciliation",
      evidence: { runId: run!.id, originalFailureCode: "launcher_capacity_unavailable", attempt: 3 } });
    expect(recovery[0]?.nextAction).toBeTruthy();
  }, 30_000);
});
