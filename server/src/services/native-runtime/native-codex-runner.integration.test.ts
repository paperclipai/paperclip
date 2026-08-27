import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  runnerPrpWebSocketInternals,
  setupRunnerPrpWebSocketServer,
} from "../../realtime/runner-prp-ws.js";
import { executeNativeCodexRunner } from "./native-codex-runner.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping native Codex vertical-slice test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const runnerWorkspace = resolve(
  import.meta.dirname,
  "../../../../packages/paperclip-runner/runner",
);
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const runnerBinary = resolve(
  runnerWorkspace,
  "target",
  "release",
  `paperclip-runnerd${executableSuffix}`,
);
const fakeCodexBinary = resolve(
  runnerWorkspace,
  "target",
  "release",
  `fake-codex-app-server${executableSuffix}`,
);

function ensureRunnerTestBinaries(): void {
  const liveCodex = process.env.PAPERCLIP_LIVE_CODEX_NATIVE_RESUME === "1";
  if (!liveCodex && existsSync(runnerBinary) && existsSync(fakeCodexBinary)) return;
  execFileSync("cargo", [
    "build",
    "--release",
    "--locked",
    "-p",
    "paperclip-runner-core",
    "--bin",
    "paperclip-runnerd",
    "--bin",
    "fake-codex-app-server",
  ], {
    cwd: runnerWorkspace,
    stdio: "inherit",
    timeout: 180_000,
  });
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

describeEmbeddedPostgres("native Codex server vertical slice", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let runtimeRoot: string | null = null;
  let server: Server | null = null;

  beforeAll(async () => {
    ensureRunnerTestBinaries();
    temporary = await startEmbeddedPostgresTestDatabase("native-codex-vertical-slice-");
    runtimeRoot = await mkdtemp(resolve(tmpdir(), "native-codex-runtime-"));
    server = createServer();
    await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    setupRunnerPrpWebSocketServer(server, {
      apiUrl: `http://127.0.0.1:${address.port}`,
    });
  }, 240_000);

  afterAll(async () => {
    runnerPrpWebSocketInternals.resetForTests();
    await closeServer(server);
    await temporary?.cleanup();
    if (runtimeRoot && process.env.PAPERCLIP_LIVE_CODEX_NATIVE_RESUME !== "1") {
      await rm(runtimeRoot, { recursive: true, force: true });
    } else if (runtimeRoot) {
      console.log("NATIVE_CODEX_RESUME_RUNTIME", runtimeRoot);
    }
  });

  it("returns a durable result and resumes the provider session on the next run", async () => {
    if (!temporary || !runtimeRoot) throw new Error("Vertical-slice fixture was not initialized");
    const db = createDb(temporary.connectionString);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Native Codex vertical slice",
      issuePrefix: "NCV",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native Codex",
      role: "engineer",
      status: "active",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "NCV-1",
      title: "Complete the native Codex vertical slice",
      description: "Return a bound structured completion result.",
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    const [run] = await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId },
    }).returning();
    if (!run) throw new Error("Failed to seed native run");
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));

    const native = await prepareNativeHeartbeatRun({
      db,
      run,
      issue: {
        id: issueId,
        title: "Complete the native Codex vertical slice",
        description: "Return a bound structured completion result.",
        reviewPolicy: null,
      },
      environmentLeaseId: "lease-native-codex-e2e",
    });
    const logs: string[] = [];
    const runnerPids: number[] = [];
    const providerPids: number[] = [];
    const liveCodex = process.env.PAPERCLIP_LIVE_CODEX_NATIVE_RESUME === "1";
    const requestedModel = liveCodex ? "gpt-5.6-sol" : "test-model";
    let semanticCallId: string | null = null;
    let resolveRestart!: () => void;
    const restarted = new Promise<void>((resolve) => {
      resolveRestart = resolve;
    });
    const execute = executeNativeCodexRunner({
      db,
      companyId,
      issueId,
      runId,
      agentId,
      runnerInstanceId: native.runnerInstanceId,
      environmentLeaseId: native.environmentLeaseId,
      normalizedSessionId: native.normalizedSessionId,
      turnId: native.turnId,
      itemId: native.itemId,
      cwd: tmpdir(),
      prompt: liveCodex
        ? "Call report_progress exactly once with body 'Native resume completed one semantic effect.' and idempotencyKey 'native-resume-proof-1'. Then briefly state that the progress update is complete. Do not call any other tool."
        : "Complete the fake native Codex turn.",
      model: requestedModel,
      resumeProviderSessionId: null,
      completionContract: native.completionContract,
      timeoutMs: liveCodex ? 180_000 : 30_000,
      environment: {},
      runnerBinary,
      runtimeRoot,
      ...(liveCodex ? {} : {
        providerLaunch: {
          command: fakeCodexBinary,
          args: [
            "--state-file",
            resolve(runtimeRoot, "fake-codex-state.json"),
            "--call-log",
            resolve(runtimeRoot, "fake-codex-calls.log"),
            "--emit-semantic-tool",
          ],
          providerVersion: "fake-codex-v1",
        },
      }),
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      onSemanticToolInputCommitted: async ({ callId, operationId }) => {
        semanticCallId = callId;
        if (liveCodex) console.log("NATIVE_CODEX_RESUME_SEMANTIC_INPUT", callId);
        if (!liveCodex) expect(callId).toBe("semantic-call-1");
        expect(operationId).toBe("report_progress");
        const firstPid = runnerPids[0];
        if (!firstPid) throw new Error("First Runner D process was not recorded");
        process.kill(process.platform === "win32" ? firstPid : -firstPid, "SIGKILL");
        await restarted;
      },
      onSpawn: async ({ pid }) => {
        runnerPids.push(pid);
        if (liveCodex) console.log("NATIVE_CODEX_RESUME_RUNNER", pid);
        if (runnerPids.length === 2) resolveRestart();
      },
      onProviderSpawn: async ({ pid }) => {
        providerPids.push(pid);
        if (liveCodex) console.log("NATIVE_CODEX_RESUME_PROVIDER", pid);
      },
    });
    const result = await execute.catch((error) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${logs.join("")}`,
      );
    });

    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "codex",
      resultJson: {
        nativeRunner: {
          result: {
            schema: "paperclip.run_result.v1",
            completionClaim: {
              contractRevision: "1",
              objectiveSatisfied: true,
              criteria: [{ criterionId: "objective", status: "satisfied" }],
            },
          },
          terminal: {
            schema: "paperclip.prp.terminal.v1",
            runTerminalState: "succeeded",
          },
        },
      },
    });
    if (!liveCodex) {
      expect(result).toMatchObject({
        sessionParams: { sessionId: "codex-thread-1" },
        summary: "Codex completed the fake turn.",
      });
    }
    expect(logs.join("\n")).not.toContain("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET");
    expect(runnerPids).toHaveLength(2);
    expect(new Set(runnerPids).size).toBe(2);
    if (liveCodex) {
      expect(providerPids).toHaveLength(1);
      expect(new Set(providerPids).size).toBe(1);
    }

    const [persistedResult] = await db
      .select()
      .from(nativeRunResults)
      .where(eq(nativeRunResults.runId, runId));
    expect(persistedResult).toMatchObject({ schemaStatus: "accepted" });
    const [finalization] = await db
      .select()
      .from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, runId));
    expect(finalization).toMatchObject({ phase: "workspace_finalizing" });
    const nativeEvents = await db
      .select({
        eventType: heartbeatRunEvents.eventType,
        payload: heartbeatRunEvents.payload,
      })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    expect(nativeEvents.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "turn.completed",
      "run.result.proposed",
      "run.terminal",
      "semantic_tool.input",
      "semantic_tool.reconciled",
    ]));
    const semanticInputs = nativeEvents.filter(
      (event) => event.eventType === "semantic_tool.input",
    );
    expect(semanticInputs).toHaveLength(1);
    const semanticEvent = semanticInputs[0]?.payload?.prpEvent as
      | Record<string, unknown>
      | undefined;
    const semanticPayload = semanticEvent?.payload as
      | Record<string, unknown>
      | undefined;
    expect(
      (semanticPayload?.semantic_tool as Record<string, unknown>)?.callId,
    ).toBe(semanticCallId);
    const progressEffects = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issueId),
          eq(issueComments.createdByRunId, runId),
        ),
      );
    expect(progressEffects).toEqual([
      { body: "Native resume completed one semantic effect." },
    ]);

    const usageReports = nativeEvents
      .filter((event) => event.eventType === "usage.reported")
      .map((event) => event.payload?.prpEvent)
      .filter((event): event is Record<string, unknown> => Boolean(event));
    const finalUsagePayload = usageReports.at(-1)?.payload as
      | Record<string, unknown>
      | undefined;
    const finalCumulative = finalUsagePayload?.cumulative as
      | Record<string, unknown>
      | undefined;
    const providerTurnIds = nativeEvents
      .filter((event) => event.eventType === "turn.started")
      .map((event) => event.payload?.prpEvent)
      .filter((event): event is Record<string, unknown> => Boolean(event))
      .map((event) => event.payload as Record<string, unknown> | undefined)
      .map((payload) => payload?.providerTurnId)
      .filter((providerTurnId): providerTurnId is string => (
        typeof providerTurnId === "string" && providerTurnId.length > 0
      ));
    const providerCalls = new Set(providerTurnIds).size;
    expect(finalUsagePayload?.providerTurnId).toEqual(expect.any(String));
    expect(providerCalls).toBe(1);
    expect(result.model).toBe(requestedModel);
    expect(finalCumulative?.requests).toBeGreaterThanOrEqual(1);
    expect(finalCumulative?.providerCostStatus).toBe("unpriced");
    expect(finalCumulative?.providerCostUnavailableReason).toBe(
      "codex_app_server_does_not_report_per_turn_cost",
    );

    if (liveCodex) {
      console.log("NATIVE_CODEX_RESUME_PROOF", JSON.stringify({
        schema: "paperclip-runner/native-resume-live-gate/v1",
        appCommit: process.env.PAPERCLIP_LIVE_CODEX_APP_COMMIT ?? null,
        model: result.model,
        runId,
        providerSessionId: result.sessionParams?.sessionId ?? null,
        semanticCallId,
        runnerPids,
        providerPids,
        semanticInputCount: semanticInputs.length,
        semanticReconciledCount: nativeEvents.filter(
          (event) => event.eventType === "semantic_tool.reconciled",
        ).length,
        semanticResultCount: nativeEvents.filter(
          (event) => event.eventType === "semantic_tool.result",
        ).length,
        controlPlaneEffectCount: progressEffects.length,
        accounting: {
          providerCalls,
          providerRequests: finalCumulative?.requests ?? null,
          requestCountSource: finalCumulative?.requestCountSource ?? null,
          requestCountExact: finalCumulative?.requestCountExact ?? null,
          providerTurnId: finalUsagePayload?.providerTurnId ?? null,
          providerRequestId: finalUsagePayload?.providerRequestId ?? null,
          providerRequestIdUnavailableReason:
            finalUsagePayload?.providerRequestIdUnavailableReason ?? null,
          providerCostUsd: finalCumulative?.providerCostUsd ?? null,
          providerCostStatus: finalCumulative?.providerCostStatus ?? null,
          providerCostUnavailableReason:
            finalCumulative?.providerCostUnavailableReason ?? null,
          inputTokens: finalCumulative?.inputTokens ?? null,
          outputTokens: finalCumulative?.outputTokens ?? null,
          cacheReadTokens: finalCumulative?.cacheReadTokens ?? null,
          cacheWriteTokens: finalCumulative?.cacheWriteTokens ?? null,
        },
        usageReports,
      }));
      return;
    }

    const resumedRunId = randomUUID();
    const [resumedRun] = await db.insert(heartbeatRuns).values({
      id: resumedRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId },
    }).returning();
    if (!resumedRun) throw new Error("Failed to seed resumed native run");
    await db
      .update(issues)
      .set({ executionRunId: resumedRunId })
      .where(eq(issues.id, issueId));
    const resumedNative = await prepareNativeHeartbeatRun({
      db,
      run: resumedRun,
      issue: {
        id: issueId,
        title: "Complete the native Codex vertical slice",
        description: "Return a bound structured completion result.",
        reviewPolicy: null,
      },
      environmentLeaseId: "lease-native-codex-resume",
    });
    const resumed = await executeNativeCodexRunner({
      db,
      companyId,
      issueId,
      runId: resumedRunId,
      agentId,
      runnerInstanceId: resumedNative.runnerInstanceId,
      environmentLeaseId: resumedNative.environmentLeaseId,
      normalizedSessionId: resumedNative.normalizedSessionId,
      turnId: resumedNative.turnId,
      itemId: resumedNative.itemId,
      cwd: tmpdir(),
      prompt: "Continue the fake native Codex session.",
      model: "test-model",
      resumeProviderSessionId: "codex-thread-1",
      completionContract: resumedNative.completionContract,
      timeoutMs: 30_000,
      environment: {},
      runnerBinary,
      runtimeRoot,
      providerLaunch: {
        command: fakeCodexBinary,
        args: [
          "--state-file",
          resolve(runtimeRoot, "fake-codex-state.json"),
          "--call-log",
          resolve(runtimeRoot, "fake-codex-calls.log"),
        ],
        providerVersion: "fake-codex-v1",
      },
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      onSpawn: async () => undefined,
    });
    expect(resumed).toMatchObject({
      exitCode: 0,
      sessionParams: { sessionId: "codex-thread-1" },
    });
    const providerCallLog = await readFile(
      resolve(runtimeRoot, "fake-codex-calls.log"),
      "utf8",
    );
    expect(providerCallLog.match(/^thread\/start$/gm)).toHaveLength(1);
    expect(providerCallLog.match(/^thread\/resume$/gm)).toHaveLength(2);
    expect(providerCallLog.match(/^semantic_tool\/result$/gm)).toHaveLength(1);
  }, 240_000);
});
