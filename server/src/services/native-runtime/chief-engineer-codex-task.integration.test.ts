/**
 * Integration test: a "Chief Engineer" agent (paperclip_runner + codex provider)
 * completes a simple assigned issue task via the fake Codex binary.
 *
 * Modeled on native-codex-runner.integration.test.ts but scoped to the
 * "chief engineer completes a simple task" scenario.
 *
 * - Seeds company + Chief Engineer agent + throwaway issue + heartbeat run.
 * - Calls prepareNativeHeartbeatRun + executeNativeCodexRunner.
 * - Asserts the run succeeds, persists a durable result, and records the
 *   expected run-log events.
 *
 * Skipped on hosts without embedded Postgres support.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
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
    `Skipping Chief Engineer Codex task test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

/**
 * Verify the prebuilt runner test binaries exist. The release binaries
 * (`paperclip-runnerd`, `fake-codex-app-server`) are built by
 * `cargo build --release --locked -p paperclip-runner-core` and checked in
 * under `packages/paperclip-runner/runner/target/release/`. This helper
 * asserts they are present so the test can run without a Rust toolchain.
 */
function ensureRunnerTestBinaries(): void {
  if (!existsSync(runnerBinary)) {
    throw new Error(
      `paperclip-runnerd binary not found at ${runnerBinary}. ` +
      `Run: cargo build --release --locked -p paperclip-runner-core ` +
      `--bin paperclip-runnerd --bin fake-codex-app-server`,
    );
  }
  if (!existsSync(fakeCodexBinary)) {
    throw new Error(
      `fake-codex-app-server binary not found at ${fakeCodexBinary}. ` +
      `Run: cargo build --release --locked -p paperclip-runner-core ` +
      `--bin paperclip-runnerd --bin fake-codex-app-server`,
    );
  }
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

describeEmbeddedPostgres("Chief Engineer completes a simple task using Codex", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let runtimeRoot: string | null = null;
  let server: Server | null = null;

  beforeAll(async () => {
    ensureRunnerTestBinaries();
    temporary = await startEmbeddedPostgresTestDatabase("chief-engineer-codex-");
    runtimeRoot = await mkdtemp(resolve(tmpdir(), "chief-engineer-codex-runtime-"));
    server = createServer();
    await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    setupRunnerPrpWebSocketServer(server, {
      apiUrl: `http://127.0.0.1:${address.port}`,
    });
  }, 660_000);

  afterAll(async () => {
    runnerPrpWebSocketInternals.resetForTests();
    await closeServer(server);
    await temporary?.cleanup();
    if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
  });

  it("Chief Engineer agent completes a simple assigned issue task via Codex", async () => {
    if (!temporary || !runtimeRoot) throw new Error("Fixture was not initialized");
    const db = createDb(temporary.connectionString);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    // Seed: company
    await db.insert(companies).values({
      id: companyId,
      name: "Chief Engineer Test Co",
      issuePrefix: "CET",
      requireBoardApprovalForNewAgents: false,
    });

    // Seed: Chief Engineer agent (paperclip_runner + codex provider)
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Chief Engineer",
      role: "engineer",
      status: "active",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
      runtimeConfig: {},
      permissions: {},
    });

    // Seed: simple throwaway issue assigned to Chief Engineer
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "CET-1",
      title: "Write a one-line status summary",
      description: "Summarise the project status in one sentence.",
      status: "in_progress",
      priority: "low",
      workMode: "standard",
      assigneeAgentId: agentId,
    });

    // Seed: heartbeat run (assignment-triggered)
    const [run] = await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId },
    }).returning();
    if (!run) throw new Error("Failed to seed heartbeat run");

    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));

    // Prepare the native run
    const native = await prepareNativeHeartbeatRun({
      db,
      run,
      issue: {
        id: issueId,
        title: "Write a one-line status summary",
        description: "Summarise the project status in one sentence.",
        reviewPolicy: null,
      },
      environmentLeaseId: "lease-chief-engineer-codex",
    });

    // Execute via the fake Codex binary
    const logs: string[] = [];
    const result = await executeNativeCodexRunner({
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
      prompt: "Write a one-line status summary for the project.",
      model: "test-model",
      resumeProviderSessionId: null,
      completionContract: native.completionContract,
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
    }).catch((error) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${logs.join("")}`,
      );
    });

    // Assert the run completed successfully
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "codex",
      sessionParams: { sessionId: "codex-thread-1" },
      summary: "Codex completed the fake turn.",
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

    // Assert a durable native run result was persisted
    const [persistedResult] = await db
      .select()
      .from(nativeRunResults)
      .where(eq(nativeRunResults.runId, runId));
    expect(persistedResult).toMatchObject({ schemaStatus: "accepted" });

    // Assert a finalization row was recorded
    const [finalization] = await db
      .select()
      .from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, runId));
    expect(finalization).toMatchObject({ phase: "workspace_finalizing" });

    // Assert the expected run-log event types were recorded
    const eventTypes = await db
      .select({ eventType: heartbeatRunEvents.eventType })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    expect(eventTypes.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "turn.completed",
        "run.result.proposed",
        "run.terminal",
      ]),
    );
  }, 60_000);
});
