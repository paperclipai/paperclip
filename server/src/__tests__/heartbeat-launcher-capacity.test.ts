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
import { isLauncherCapacityFailure } from "@paperclipai/adapter-utils/launcher-capacity";

const remoteRestore = vi.hoisted(() => ({ error: null as Error | null, calls: 0 }));
vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return { ...actual,
    ensureAdapterExecutionTargetCommandResolvable: async () => {},
    ensureAdapterExecutionTargetRuntimeCommandInstalled: async () => {},
    resolveAdapterExecutionTargetCommandForLogs: async (command: string) => command,
    startAdapterExecutionTargetPaperclipBridge: async () => null,
    prepareAdapterExecutionTargetRuntime: async () => ({
      target: { kind: "remote", transport: "ssh" }, workspaceRemoteDir: "/remote/workspace",
      runtimeRootDir: "/remote/runtime", assetDirs: { home: "/remote/runtime/home" },
      restoreWorkspace: async () => { remoteRestore.calls += 1; if (remoteRestore.error) throw remoteRestore.error; },
    }),
    // Execute only the local synthetic launcher; never contact an SSH/provider endpoint.
    runAdapterExecutionTargetProcess: (...args: Parameters<typeof actual.runAdapterExecutionTargetProcess>) => {
      args[1] = null;
      return actual.runAdapterExecutionTargetProcess(...args);
    },
  };
});

// Setup and remote transport are synthetic. Launcher, adapter teardown, persistence,
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
        return executeCodex({ ...context,
          ...(remoteRestore.error ? { executionTarget: undefined, executionTransport: { remoteExecution: {
            host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/remote/workspace",
            remoteCwd: "/remote/workspace", privateKey: "fixture", knownHosts: "fixture", strictHostKeyChecking: true,
          } } } : {}),
          config: { engine: "cli", launcherCapacityRecovery: true,
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

  it.each([
    ["restore_unsafe_archive", "Daytona syncOut refusing tarball link whose target escapes the extraction dir: artifact -> /outside"],
    ["restore_unsafe_archive", "Kubernetes syncOut refusing tarball link whose target escapes the extraction dir: artifact -> /outside"],
    ["restore_failed", "workspace copy-back failed"],
  ])("does not create a capacity successor after the real adapter reports %s", async (classification, message) => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Restore test", issuePrefix: `R${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "test-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Restore test", role: "engineer", status: "idle",
      adapterType, adapterConfig: {}, permissions: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Restore failure", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: "test-user" });
    remoteRestore.error = new Error(message);
    remoteRestore.calls = 0;
    try {
      const run = await heartbeat.invoke(agentId, "on_demand", { issueId, wakeReason: "issue_assigned" }, "manual");
      await heartbeat.drainActiveRunExecutions();
      const failed = await heartbeat.getRun(run!.id);
      expect(remoteRestore.calls, JSON.stringify(failed)).toBe(1);
      expect(failed).toMatchObject({ status: "failed", errorCode: "workspace_restore_failed", resultJson: {
        stdout: "", workspaceRestoreFailure: classification,
        executionBeforeRestore: { errorCode: "launcher_capacity_unavailable", exitCode: 5 },
      } });
      expect(failed?.resultJson?.stderr).toContain("launcher: no free slot");
      expect(isLauncherCapacityFailure(failed!)).toBe(false);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id))).toHaveLength(0);
      if (classification === "restore_unsafe_archive") {
        expect(await heartbeat.scheduleBoundedRetry(run!.id))
          .toMatchObject({ outcome: "not_scheduled", errorCode: "legacy_execution_requires_reconciliation" });
        const recovery = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
        expect(recovery).toHaveLength(1);
        expect(recovery[0]).toMatchObject({ status: "active", ownerType: "board",
          evidence: { runId: run!.id, workspaceRestoreFailure: classification } });
      }
    } finally {
      await heartbeat.drainActiveRunExecutions();
      remoteRestore.error = null;
    }
  }, 30_000);
});
