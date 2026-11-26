import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { expect, it } from "vitest";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { heartbeatService } from "../heartbeat.js";
import { issueService } from "../issues.js";
import { instanceSettingsService } from "../instance-settings.js";
import { withReleasedNativeRunProcess } from "../native-local-process-stop.js";
import { nativeSha256 } from "./canonical.js";
import { closeIdleWarmNativeSessionsForRestart } from "./native-session-executor.js";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

it.skipIf(process.env.PAPERCLIP_LIVE_QUARANTINED_RETRY !== "true")("starts a fresh real Codex turn through task Retry after inherited quarantine", async () => {
  const home = createIsolatedTestHome();
  const keys = ["PAPERCLIP_HOME", "CODEX_HOME", "PAPERCLIP_API_URL", "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_TELEMETRY_DISABLED", "PAPERCLIP_RUNNER_STATE_DIR"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>> | undefined;
  let heartbeat: ReturnType<typeof heartbeatService> | undefined;
  let companyId: string | undefined;
  try {
    const codexHome = join(home.home, "codex"), stateBase = join(home.home, "runner-state");
    await mkdir(codexHome, { mode: 0o700 });
    await copyFile(join(process.env.PAPERCLIP_LIVE_CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), join(codexHome, "auth.json"));
    process.env.CODEX_HOME = codexHome;
    process.env.PAPERCLIP_HOME = join(home.home, "instance");
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    process.env.PAPERCLIP_TELEMETRY_DISABLED = "1";
    server = await startRunnerApiTestServer({ deploymentMode: "authenticated", humanSessions: true });
    process.env.PAPERCLIP_API_URL = server.apiUrl;
    const f = await server.fixture({ connectionScenario: "fresh" }), db = server.db;
    companyId = f.companyId;
    const markers = [randomUUID(), randomUUID()];
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ status: "todo", executionRunId: null, executionWorkspaceSettings: { mode: "shared_workspace" },
      title: "Preserve work through task Retry", description: "Follow the latest human comment. Use the task workspace. Complete only that requested file step and finish with paperclip_finish, reportedWorkDisposition done. This is a local file task; no external writes are needed.",
    }).where(eq(issues.id, f.issueId));
    await db.update(companies).set({ defaultResponsibleUserId: f.userId }).where(eq(companies.id, f.companyId));
    await db.update(agents).set({ adapterConfig: { provider: "codex", model: "gpt-6.1-sol", modelReasoningEffort: "high",
      cwd: f.workspace, workspaceStrategy: { type: "project_primary" }, env: { CODEX_HOME: codexHome }, timeoutSec: 180, lifecycleMode: "per_turn" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
    }).where(eq(agents.id, f.agentId));
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true, enableIsolatedWorkspaces: true });
    heartbeat = heartbeatService(db);
    const service = issueService(db);
    const first = await service.addComment(f.issueId, `Write exactly ${markers[0]} and a newline to retry-proof.txt. Read it, then finish.`, { userId: f.userId! });
    const run = await heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: f.userId,
      payload: { issueId: f.issueId, commentId: first.id },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeCommentId: first.id, skipIssueComment: true },
    });
    expect(run?.id).toBeTruthy();
    await heartbeat.drainActiveRunExecutions();
    await closeIdleWarmNativeSessionsForRestart();
    const [original] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect({ status: original.status, error: original.error }).toMatchObject({ status: "succeeded", error: null });
    expect(await readFile(join(f.workspace, "retry-proof.txt"), "utf8")).toBe(`${markers[0]}\n`);
    const owner = await withReleasedNativeRunProcess(db, original);
    expect(owner.processPid).toBeTruthy();
    const execution = parseNativeExecutionInput(owner.runnerProfileJson!.nativeExecutionInput);
    const root = join(stateBase, nativeSha256({ schema: "paperclip.native-session-scope.v2", companyId: f.companyId, agentId: f.agentId,
      workspace: { kind: "managed", executionWorkspaceId: execution.binding.executionWorkspaceId },
      provider: { driverKind: "codex_app_server", identity: { kind: "codex" } }, normalizedSessionId: owner.nativeSessionId }));
    const controlPath = join(root, "control-plane/control-plane-state.json"), providerPath = join(root, "runner/codex-provider-state.json");
    const control = JSON.parse(await readFile(controlPath, "utf8")), provider = JSON.parse(await readFile(providerPath, "utf8"));
    control.commands.push({ commandId: "unacknowledged-result", status: "pending", payload: { commandType: "tool.result", result: "Retain this uncertain command without replay." } });
    provider.lifecycle = "session_open";
    await writeFile(controlPath, JSON.stringify(control));
    await writeFile(providerPath, JSON.stringify(provider));
    const retainedBytes = await readFile(controlPath, "utf8"), sourceId = randomUUID();
    const retryComment = await service.addComment(f.issueId, `Read retry-proof.txt and preserve its existing line. Append exactly ${markers[1]} and a newline once. Never repeat the earlier file step. Read the complete file and finish.`, { userId: f.userId! });
    const oldFingerprint = `sha256:${"1".repeat(64)}`;
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...owner.runnerProfileJson, nativeToolContractFingerprint: oldFingerprint } }).where(eq(heartbeatRuns.id, owner.id));
    await db.insert(heartbeatRuns).values({ id: sourceId, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      nativeIssueId: f.issueId, runtimeMode: "native", nativeSessionId: owner.nativeSessionId, runnerInstanceId: owner.runnerInstanceId,
      processPid: owner.processPid, processGroupId: owner.processGroupId, processStartedAt: owner.processStartedAt,
      status: "failed", finishedAt: new Date(), errorCode: "native_session_cleanup_quarantined", responsibleUserId: f.userId,
      contextSnapshot: { issueId: f.issueId, commentId: retryComment.id, wakeCommentId: retryComment.id, wakeCommentIds: [retryComment.id] }, runnerProfileJson: { ...owner.runnerProfileJson,
        nativeExecutionInput: { ...execution, binding: { ...execution.binding, runId: sourceId },
          task: { ...execution.task, prompt: retryComment.body } }, nativeToolContractFingerprint: oldFingerprint },
    });
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: sourceId, phase: "terminal_failure" });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      cause: "native_session_cleanup_quarantined", fingerprint: sourceId, status: "resolved", outcome: "blocked",
      nextAction: "Automatic recovery stopped.", evidence: { runId: sourceId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    await db.update(issues).set({ status: "blocked", executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issueId));
    const cookie = await server.humanSession(f.userId!);
    const response = await fetch(`${server.apiUrl}/api/issues/${f.issueId}/retry`, { method: "POST",
      headers: { "content-type": "application/json", cookie, origin: server.apiUrl },
      body: JSON.stringify({ observedRunId: sourceId, idempotencyKey: randomUUID() }),
    });
    const receipt = await response.json() as { requestId: string; accepted: boolean };
    expect(response.status, JSON.stringify(receipt)).toBe(202);
    expect(receipt.accepted).toBe(true);
    await expect.poll(async () => {
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId));
      return wake.runId;
    }, { timeout: 30_000, interval: 250 }).toBeTruthy();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId));
    await expect.poll(async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!)))[0].status,
      { timeout: 240_000, interval: 500 }).toBe("succeeded");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(successor.nativeSessionId).not.toBe(owner.nativeSessionId);
    expect(successor.sessionIdAfter).not.toBe(owner.sessionIdAfter);
    expect(successor.contextSnapshot).toMatchObject({ previousRunId: sourceId, forceFreshSession: true });
    expect(await readFile(join(f.workspace, "retry-proof.txt"), "utf8")).toBe(markers.join("\n") + "\n");
    expect(await readFile(controlPath, "utf8")).toBe(retainedBytes);
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task).toMatchObject({ status: "done", executionRunId: null, checkoutRunId: null });
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, successor.id));
    expect(coordinator.phase).toBe("committed");
    const proof = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, sourceId), eq(heartbeatRunEvents.eventType, "native.stopped_conversation_verified")));
    expect(proof).toHaveLength(1);
    const evidence = { passed: true, platform: `${process.platform}-${process.arch}`, model: "gpt-6.1-sol", effort: "high",
      ownerRunId: owner.id, sourceRunId: sourceId, successorRunId: successor.id, freshSession: true,
      priorJournalPreserved: true, fileLines: 2, taskStatus: task.status, locksCleared: true, finalization: coordinator.phase };
    if (process.env.PAPERCLIP_LIVE_EVIDENCE_PATH) await writeFile(process.env.PAPERCLIP_LIVE_EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(evidence));
  } catch (error) {
    if (server && companyId && process.env.PAPERCLIP_LIVE_EVIDENCE_PATH) {
      const runs = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      await writeFile(`${process.env.PAPERCLIP_LIVE_EVIDENCE_PATH}.failure.json`, JSON.stringify({ error: String(error),
        runs: runs.map(run => ({ id: run.id, status: run.status, error: run.error, result: run.resultJson,
          execution: (run.runnerProfileJson?.nativeExecutionInput as { workspace?: unknown } | undefined)?.workspace,
          continuation: run.contextSnapshot?.executionContinuation })),
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
}, 600_000);
