import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { expect, it } from "vitest";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { heartbeatService } from "../heartbeat.js";
import { instanceSettingsService } from "../instance-settings.js";
import { closeIdleWarmNativeSessionsForRestart } from "./native-session-executor.js";

it.skipIf(process.env.PAPERCLIP_LIVE_REFUSED_RETRY !== "true")("completes work through HTTP Retry after a refused automatic attempt", async () => {
  const home = createIsolatedTestHome();
  const keys = ["PAPERCLIP_HOME", "CODEX_HOME", "PAPERCLIP_API_URL", "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_TELEMETRY_DISABLED", "PAPERCLIP_RUNNER_STATE_DIR"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>> | undefined;
  let heartbeat: ReturnType<typeof heartbeatService> | undefined;
  let companyId: string | undefined;
  try {
    const codexHome = join(home.home, "codex");
    await mkdir(codexHome, { mode: 0o700 });
    await copyFile(join(process.env.PAPERCLIP_LIVE_CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), join(codexHome, "auth.json"));
    process.env.CODEX_HOME = codexHome;
    process.env.PAPERCLIP_HOME = join(home.home, "instance");
    process.env.PAPERCLIP_RUNNER_STATE_DIR = join(home.home, "runner-state");
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    process.env.PAPERCLIP_TELEMETRY_DISABLED = "1";
    server = await startRunnerApiTestServer({ deploymentMode: "authenticated", humanSessions: true });
    process.env.PAPERCLIP_API_URL = server.apiUrl;
    const f = await server.fixture({ connectionScenario: "fresh" }), db = server.db;
    companyId = f.companyId;
    heartbeat = heartbeatService(db);
    const preserved = randomUUID(), appended = randomUUID();
    await writeFile(join(f.workspace, "retry-proof.txt"), `${preserved}\n`);
    await db.update(companies).set({ defaultResponsibleUserId: f.userId }).where(eq(companies.id, f.companyId));
    await db.update(agents).set({ status: "idle", adapterConfig: { provider: "codex", model: "gpt-6.1-sol", modelReasoningEffort: "high",
      cwd: f.workspace, workspaceStrategy: { type: "project_primary" }, env: { CODEX_HOME: codexHome }, timeoutSec: 180, lifecycleMode: "per_turn" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, f.agentId));
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true, enableIsolatedWorkspaces: true });
    await db.update(issues).set({ status: "blocked", executionRunId: null, checkoutRunId: null, responsibleUserId: f.userId,
      executionWorkspaceSettings: { mode: "shared_workspace" }, title: "Complete one Retry turn",
      description: `Write exactly ${appended} and a newline once to retry-result.txt in the current workspace. Read the complete file. This is the only requested work. Finish with paperclip_finish, reportedWorkDisposition done. No external writes are needed.`, 
    }).where(eq(issues.id, f.issueId));
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: f.projectId,
      projectWorkspaceId: f.projectWorkspaceId, name: "Saved task workspace", mode: "shared_workspace",
      strategyType: "project_primary", cwd: f.workspace }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing" })
      .where(eq(issues.id, f.issueId));
    const now = Date.now();
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "legacy", nativeIssueId: null,
      issueId: f.issueId, errorCode: "setup_failed", executionStage: "preparing", createdAt: new Date(now - 3000),
      finishedAt: new Date(now - 2000), runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).where(eq(heartbeatRuns.id, f.runId));
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: f.runId,
      status: "resolved", outcome: "blocked", nextAction: "Continue after recovery.",
      evidence: { runId: f.runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } }).returning();
    const [refused] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, status: "cancelled", errorCode: "execution_reconciliation_required", retryOfRunId: f.runId,
      createdAt: new Date(now - 1000), finishedAt: new Date(now - 500), contextSnapshot: { issueId: f.issueId, retryOfRunId: f.runId },
      resultJson: { stopReason: "execution_reconciliation_required", timeoutSource: "stale_queued_run_gate",
        executionWait: { issueId: f.issueId, recoveryActionId: hold.id } } }).returning();
    const cookie = await server.humanSession(f.userId!);
    const idempotencyKey = randomUUID();
    const retry = () => fetch(`${server!.apiUrl}/api/issues/${f.issueId}/retry`, { method: "POST",
      headers: { "content-type": "application/json", cookie, origin: server!.apiUrl },
      body: JSON.stringify({ observedRunId: refused.id, idempotencyKey }) });
    const response = await retry();
    const receipt = await response.json() as { requestId: string; accepted: boolean };
    expect(response.status, JSON.stringify(receipt)).toBe(202);
    expect(receipt.accepted).toBe(true);
    await expect.poll(async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId)))[0].runId,
      { timeout: 30_000, interval: 250 }).toBeTruthy();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId));
    await expect.poll(async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!)))[0].status,
      { timeout: 240_000, interval: 500 }).toBe("succeeded");
    await heartbeat.drainActiveRunExecutions();
    expect(await readFile(join(f.workspace, "retry-proof.txt"), "utf8")).toBe(`${preserved}\n`);
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(successor.contextSnapshot).toMatchObject({ previousRunId: refused.id,
      explicitUserContinuation: { previousRunId: refused.id, taskRetryRequestId: receipt.requestId } });
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task).toMatchObject({ status: "done", executionRunId: null, checkoutRunId: null });
    const [completedWorkspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, task.executionWorkspaceId!));
    expect(await readFile(join(completedWorkspace.cwd!, "retry-result.txt"), "utf8")).toBe(`${appended}\n`);
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, successor.id));
    expect(coordinator.phase).toBe("committed");
    const repeated = await retry();
    expect(await repeated.json()).toMatchObject({ accepted: true, requestId: receipt.requestId });
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.runtimeMode, "native"))))
      .toHaveLength(1);
    const evidence = { passed: true, platform: `${process.platform}-${process.arch}`, model: "gpt-6.1-sol", effort: "high",
      sourceRunId: f.runId, refusedRunId: refused.id, successorRunId: successor.id, sourceFilePreserved: true, outputFileLines: 1,
      taskStatus: task.status, locksCleared: true, finalization: coordinator.phase, duplicateClickReused: true };
    if (process.env.PAPERCLIP_LIVE_EVIDENCE_PATH) await writeFile(process.env.PAPERCLIP_LIVE_EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(evidence));
  } catch (error) {
    if (server && companyId && process.env.PAPERCLIP_LIVE_EVIDENCE_PATH) {
      const runs = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      await writeFile(`${process.env.PAPERCLIP_LIVE_EVIDENCE_PATH}.failure.json`, JSON.stringify({ error: String(error),
        runs: runs.map(run => ({ id: run.id, status: run.status, error: run.error, result: run.resultJson })),
      }, null, 2));
    }
    throw error;
  } finally {
    await heartbeat?.drainActiveRunExecutions();
    await closeIdleWarmNativeSessionsForRestart();
    await server?.close();
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    home.cleanup();
  }
}, 360_000);
