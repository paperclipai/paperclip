import { recoveryPostgresSupport, startRecoveryPostgres } from "./recovery-postgres.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { afterAll, beforeAll, describe, it } from "vitest";
import { defaultCapabilityRunnerdBinary } from "../../vendor/paperclip-runner/index.js";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { registerRunnerPrpAuthority, runnerPrpWebSocketInternals, setupRunnerPrpWebSocketServer } from "../../realtime/runner-prp-ws.js";
import { readProcessStartedAt } from "../../services/hot-restart.js";
import { prepareNativeHeartbeatRun } from "../../services/native-runtime/prepare-native-run.js";
import { createIsolatedTestHome } from "./isolated-test-home.js";
import { type NativeControllerIdentity } from "../../services/native-runtime/native-restart-recovery.js";

// An explicitly supplied disposable database also permits qualification on hosts
// where native Postgres cannot allocate semaphores. Never fall back silently.
export const describeEmbeddedPostgres: typeof describe.skip = recoveryPostgresSupport.supported ? describe : describe.skip;

export const fakeCodexAppServer = resolve(
  import.meta.dirname,
  "../../../../packages/paperclip-runner/runner/target/debug/fake-codex-app-server",
);
const binariesAvailable =
  existsSync(defaultCapabilityRunnerdBinary()) && existsSync(fakeCodexAppServer);
export const realProcessIt: typeof it.skip = binariesAvailable ? it : it.skip;

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

export function processAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForCondition(
  description: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function stopOwnedProcessGroup(
  pid: number | null,
  expectedStateRoot: string,
): Promise<void> {
  if (!pid || !processAlive(pid)) return;
  const command = await import("node:child_process").then(
    ({ execFileSync }) =>
      execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
      }).trim(),
  );
  if (!command.includes(expectedStateRoot)) {
    throw new Error(`Refusing to signal process ${pid}; ownership changed`);
  }
  if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
  else process.kill(pid, "SIGKILL");
  await waitForCondition(`owned process ${pid} to exit`, () => !processAlive(pid));
}

export function nativeRestartFixture() {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let runtimeRoot: string;
  let paperclipHome: string;
  let server: Server | null = null;
  let apiUrl: string;
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  let isolatedHome: ReturnType<typeof createIsolatedTestHome>;

  const companyId = randomUUID();
  const agentId = randomUUID();
  let successor: NativeControllerIdentity;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("native-runner-restart-recovery-");
    runtimeRoot = await mkdtemp(resolve(tmpdir(), "native-restart-runtime-"));
    isolatedHome = createIsolatedTestHome();
    paperclipHome = isolatedHome.home;
    process.env.PAPERCLIP_HOME = paperclipHome;
    const controllerStartedAt = await readProcessStartedAt(process.pid);
    successor = {
      bootId: randomUUID(),
      pid: process.pid,
      processStartedAt: controllerStartedAt
        ? new Date(controllerStartedAt)
        : new Date(),
    };
    server = createServer();
    await new Promise<void>((resolveListen) =>
      server!.listen(0, "127.0.0.1", resolveListen),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected restart recovery TCP listener");
    }
    apiUrl = `http://127.0.0.1:${address.port}`;
    setupRunnerPrpWebSocketServer(server, { apiUrl });

    const db = createDb(temporary.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Native restart recovery",
      issuePrefix: "NRR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native restart runner",
      role: "engineer",
      status: "active",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
      runtimeConfig: {},
      permissions: {},
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    runnerPrpWebSocketInternals.resetForTests();
    await closeServer(server);
    await temporary?.cleanup();
    if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
    isolatedHome?.cleanup();
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
  });

  async function seedRun(
    label: string,
    existingDb?: ReturnType<typeof createDb>,
  ) {
    const db = existingDb ?? createDb(temporary.connectionString);
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `NRR-${label}`,
      title: `Recover ${label}`,
      status: "in_progress",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        runtimeMode: "native",
        nativeIssueId: issueId,
        invocationSource: "assignment",
        triggerDetail: "system",
        contextSnapshot: { issueId },
      })
      .returning();
    if (!run) throw new Error("Failed to seed native restart run");
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({
      db,
      run,
      issue: {
        id: issueId,
        title: `Recover ${label}`,
        description: null,
        reviewPolicy: null,
      },
      environmentLeaseId: `lease-${label}`,
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId,
      phase: "observed",
    });
    const [preparedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return { db, issueId, runId, native, preparedProfile: preparedRun.runnerProfileJson };
  }

  function transportOptions(
    fixture: Awaited<ReturnType<typeof seedRun>>,
    stateDirectory: string,
  ) {
    return {
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodexAppServer,
      codexArgs: [
        "--state-file",
        resolve(stateDirectory, "fake-codex-state.json"),
        "--call-log",
        resolve(stateDirectory, "fake-codex-calls.log"),
      ],
      stateDirectory,
      lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
      prpIdentity: {
        runnerInstanceId: fixture.native.runnerInstanceId,
        environmentLeaseId: fixture.native.environmentLeaseId,
        runId: fixture.runId,
        normalizedSessionId: fixture.native.normalizedSessionId,
        turnId: fixture.native.turnId,
        itemId: fixture.native.itemId,
      },
      controlPlaneRegistration: (authority: Parameters<typeof registerRunnerPrpAuthority>[0]["authority"]) =>
        registerRunnerPrpAuthority({
          companyId,
          runId: fixture.runId,
          authority,
        }),
    };
  }

  return { seedRun, transportOptions, get current() { return { temporary, runtimeRoot, paperclipHome, apiUrl, companyId, agentId, successor }; } };
}

export function remotePreparedWorkspace() {
  return { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
    descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
    workspaceId: randomUUID(), leaseId: randomUUID(), providerLeaseId: randomUUID(),
    remoteCwd: "/workspace", resourceDisposition: "destroy" };
}
