import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { completionContracts, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { expect } from "vitest";
import { createRunDispatch } from "../../modules/run-dispatch/index.js";
import { prepareNativeHeartbeatRun } from "../../services/native-runtime/prepare-native-run.js";
import { buildNativeExecutionInput } from "../../services/native-runtime/native-execution-input.js";
import { buildNativeCompletionContract } from "../../services/native-runtime/completion-contracts.js";
import { nativeRuntimeContextFixture } from "../../services/native-runtime/runtime-context.test-fixture.js";
import { materializeAsset } from "../../services/native-runtime/runtime-context.js";
import { executePaperclipNativeSession } from "../../services/native-runtime/native-session-executor.js";
import { reconcileNativeFinalizations } from "../../services/native-runtime/native-finalization-reconciler.js";
import { canonicalNativeRuntimeContextDigest, createNativeSessionBackend, createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "../../vendor/paperclip-runner/index.js";
import { registerLocalRuntimeApiServer } from "../../runtime-api.js";
import { registerRunnerPrpAuthority, runnerPrpWebSocketInternals, setupRunnerPrpWebSocketServer } from "../../realtime/runner-prp-ws.js";

async function prepare(db: Db, runId: string, cwd: string, environmentLeaseId: string) {
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  const [issue] = await db.select().from(issues).where(eq(issues.id, run.nativeIssueId ?? String(run.contextSnapshot?.issueId)));
  await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, issue.id));
  const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId });
  const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issue.id));
  const runtimeContext = nativeRuntimeContextFixture();
  runtimeContext.instructions.bundle = await materializeAsset([{ path: "AGENTS.md", mode: 0o444,
    content: Buffer.from("Complete the saved task once.\n") }]);
  runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
  const execution = buildNativeExecutionInput({ companyId: run.companyId, agentId: run.agentId, runId, issue,
    taskPrompt: "Preserve the saved file and complete the task once.", provider: "codex",
    workspace: { id: issue.executionWorkspaceId!, cwd, repoUrl: null, repoRef: null, branchName: null },
    normalizedSessionId: native.normalizedSessionId, runtimeContext,
    completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
      contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
  });
  const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson, ...current.runnerProfileJson, nativeExecutionInput: execution } })
    .where(eq(heartbeatRuns.id, runId));
  return { run: current, native, execution };
}

export async function recordHistoricalListenerFailure(input: {
  db: Db; connectionString: string; runId: string; cwd: string; environmentId: string; leaseId: string;
}) {
  await input.db.update(heartbeatRuns).set({ status: "running", finishedAt: null, error: null, errorCode: null })
    .where(eq(heartbeatRuns.id, input.runId));
  const { execution, native } = await prepare(input.db, input.runId, input.cwd, input.leaseId);
  await input.db.insert(nativeRunFinalizations).values({ runId: input.runId, companyId: execution.binding.companyId,
    issueId: execution.binding.issueId, phase: "observed" });
  const child = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"),
    resolve(import.meta.dirname, "native-drain-controller.test-worker.ts")], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: process.env });
  const logs: string[] = [];
  child.stdout?.on("data", data => logs.push(String(data)));
  child.stderr?.on("data", data => logs.push(String(data)));
  const exited = new Promise(resolveExit => child.once("exit", resolveExit));
  try {
    const result = await new Promise((resolveResult, reject) => {
      const timeout = setTimeout(() => reject(new Error(logs.join("").slice(-3000))), 60_000);
      child.once("error", reject);
      child.on("message", (message: { ready?: boolean; done?: boolean; error?: string }) => {
        if (message.ready) child.send({ connectionString: input.connectionString, options: { execution,
          runnerInstanceId: native.runnerInstanceId, useRunnerd: true,
          runnerExecutionTarget: { kind: "remote", transport: "sandbox", environmentId: input.environmentId,
            leaseId: input.leaseId, remoteCwd: input.cwd } } });
        if (message.done || message.error) { clearTimeout(timeout); message.error ? reject(new Error(message.error)) : resolveResult(message); }
      });
    });
    expect(result).toMatchObject({ commands: 0, errorMessage: "local_runtime_api_listener_unavailable" });
    expect(await exited).toBe(0);
    const [failed] = await input.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, input.runId));
    expect(failed).toMatchObject({ phase: "terminal_failure", attempt: 1, failureCode: "native_session_interrupted",
      failureDetail: { message: "local_runtime_api_listener_unavailable", recoveryMode: "ambiguous_state",
        providerSessionEstablished: false, providerEventsExist: false, checkpointExists: false } });
  } finally { child.kill("SIGKILL"); await exited; }
}

export async function completeHistoricalListenerSuccessor(input: { db: Db; runId: string; root: string;
  prepareWorkspace: () => Promise<{ cwd: string; finalize: () => Promise<void> }> }) {
  const [scheduled] = await input.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
  const dispatch = createRunDispatch(input.db);
  expect(await dispatch.promoteScheduledRetry({ companyId: scheduled.companyId, runId: scheduled.id,
    now: new Date(scheduled.scheduledRetryAt!.getTime() + 1) })).toMatchObject({ outcome: "promoted" });
  expect(await dispatch.cancelStaleQueuedRun({ companyId: scheduled.companyId, runId: scheduled.id, expectedStatus: "queued" }))
    .toMatchObject({ outcome: "not_stale" });
  await input.db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native",
    nativeIssueId: String(scheduled.contextSnapshot?.issueId) }).where(eq(heartbeatRuns.id, scheduled.id));
  await input.db.update(issues).set({ executionRunId: scheduled.id }).where(eq(issues.id, String(scheduled.contextSnapshot?.issueId)));
  const workspace = await input.prepareWorkspace();
  const { execution, native } = await prepare(input.db, scheduled.id, workspace.cwd, `controlled-${scheduled.id}`);
  await input.db.insert(nativeRunFinalizations).values({ runId: scheduled.id, companyId: scheduled.companyId,
    issueId: execution.binding.issueId, phase: "observed" });
  const home = join(input.root, "codex-home"), report = join(input.root, "result.json"), calls = join(input.root, "calls.log");
  await mkdir(home, { recursive: true });
  await writeFile(report, JSON.stringify({ schema: "paperclip.run_result.v1", reportedWorkDisposition: "done",
    summary: "Saved task completed after historical controller failure.", completionClaim: {
      contractRevision: execution.completionContract.contract.revision, objectiveSatisfied: true,
      criteria: execution.completionContract.contract.criteria.map(criterion => ({ criterionId: criterion.id, status: "satisfied", evidenceRefs: [] })),
      remainingWork: [] }, evidence: [], verification: [], artifacts: [], attentionRequests: [] }));
  const server = createServer();
  registerLocalRuntimeApiServer(server);
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP listener required");
  setupRunnerPrpWebSocketServer(server, { apiUrl: `http://127.0.0.1:${address.port}` });
  const bundle = createRunnerdCodexTransport({ runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: resolve(import.meta.dirname, "../../../../packages/paperclip-runner/runner/target/debug/fake-codex-app-server"),
    codexArgs: ["--state-file", join(input.root, "provider.json"), "--terminal-result-file", report, "--call-log", calls, "--record-process-start"],
    stateDirectory: input.root, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    runtimeContext: execution.runtimeContext, runnerRuntimeContext: execution.runtimeContext,
    sourceCodexHome: home, environment: { CODEX_HOME: home, PATH: process.env.PATH },
    prpIdentity: { runnerInstanceId: native.runnerInstanceId, environmentLeaseId: native.environmentLeaseId,
      runId: scheduled.id, normalizedSessionId: native.normalizedSessionId, turnId: native.turnId, itemId: native.itemId },
    controlPlaneRegistration: authority => registerRunnerPrpAuthority({ companyId: scheduled.companyId, runId: scheduled.id, authority }),
  });
  const backend = createNativeSessionBackend(execution, { runnerInstanceId: native.runnerInstanceId,
    environment: { CODEX_HOME: home, PATH: process.env.PATH }, codexTransportFactory: () => bundle.transport });
  try {
    expect(await executePaperclipNativeSession({ db: input.db, execution, backend, useRunnerd: true,
      runnerInstanceId: native.runnerInstanceId, turnTimeoutMs: 15_000 })).toMatchObject({ exitCode: 0, timedOut: false });
    await workspace.finalize();
    await reconcileNativeFinalizations(input.db, [scheduled.id]);
    const [finished] = await input.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, scheduled.id));
    expect(finished, JSON.stringify(finished.failureDetail)).toMatchObject({ phase: "committed", attempt: 2 });
    expect(await input.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, scheduled.id)))
      .toMatchObject([{ schemaStatus: "accepted" }]);
    expect((await readFile(calls, "utf8")).split("\n").filter(line => line === "process-start")).toHaveLength(1);
    expect(await readFile(join(workspace.cwd, "saved.txt"), "utf8")).toBe("work survives a failed provider session\n");
  } finally {
    await bundle.transport.close(); runnerPrpWebSocketInternals.resetForTests();
    server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
}
