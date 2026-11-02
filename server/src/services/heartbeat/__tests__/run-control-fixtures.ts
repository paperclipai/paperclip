import type { Db } from "@paperclipai/db";
import { agents, companies, createDb, applyPendingMigrations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, vi, type Mock } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../../__tests__/helpers/external-test-database.js";
import { runningProcesses } from "../../../adapters/index.js";
import { terminateLocalService } from "../../local-service-supervisor.js";
import { createHeartbeatRunState } from "../run-state.js";
import { createHeartbeatRunPreparation } from "../run-preparation.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "../run-lifecycle.js";
import type { HeartbeatRunControlDependencies } from "../run-control.js";

type TestCallbacks = HeartbeatRunControlDependencies & ReturnType<typeof createHeartbeatLifecycle> & {
  getRun: Mock<HeartbeatRunControlDependencies["getRun"]>;
  getAgent: Mock<HeartbeatRunControlDependencies["getAgent"]>;
  getRunCleanupState: Mock<HeartbeatRunControlDependencies["getRunCleanupState"]>;
  setRunStatusFromLive: Mock<HeartbeatRunControlDependencies["setRunStatusFromLive"]>;
  getSchedulingSuppression: Mock<HeartbeatRunControlDependencies["getSchedulingSuppression"]>;
  options: { closeWarmNativeSessionsForRun: Mock<NonNullable<HeartbeatRunControlDependencies["options"]["closeWarmNativeSessionsForRun"]>> };
};

/** Shared real lifecycle callbacks; each focused suite controls its provider mocks. */
export function callbacks(db: Db): TestCallbacks {
  const state = createHeartbeatRunState(db);
  const lifecycleDependencies = {
    ...state,
    ...createHeartbeatRunPreparation(db),
    issuesSvc: {
      addComment: vi.fn<HeartbeatLifecycleDependencies["issuesSvc"]["addComment"]>(),
      listReviewAttention: vi.fn<HeartbeatLifecycleDependencies["issuesSvc"]["listReviewAttention"]>(),
    },
    recovery: { escalateStrandedAssignedIssue: vi.fn<HeartbeatLifecycleDependencies["recovery"]["escalateStrandedAssignedIssue"]>() },
    companySkills: { completeTestRunForIssue: vi.fn<HeartbeatLifecycleDependencies["companySkills"]["completeTestRunForIssue"]>() },
    budgets: { getInvocationBlock: vi.fn(async () => null) },
    treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    enqueueWakeup: vi.fn<HeartbeatLifecycleDependencies["enqueueWakeup"]>(),
    getCurrentUserRedactionOptions: vi.fn(async () => ({})),
    getAgentInvokability: vi.fn<HeartbeatLifecycleDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    emitTerminalAgentTaskRun: vi.fn<HeartbeatLifecycleDependencies["emitTerminalAgentTaskRun"]>(),
    budgetHooks: {},
  } satisfies HeartbeatLifecycleDependencies;
  const lifecycle = createHeartbeatLifecycle(db, lifecycleDependencies);
  return {
    ...state,
    ...lifecycle,
    getRun: vi.fn(state.getRun),
    getRunCleanupState: vi.fn(state.getRunCleanupState),
    getAgent: vi.fn(state.getAgent),
    setRunStatusFromLive: vi.fn(lifecycle.setRunStatusFromLive),
    setRunStatus: vi.fn(lifecycle.setRunStatus),
    setWakeupStatus: vi.fn(lifecycle.setWakeupStatus),
    appendRunEvent: vi.fn(lifecycle.appendRunEvent),
    finalizeAgentStatus: vi.fn<HeartbeatRunControlDependencies["finalizeAgentStatus"]>(),
    options: { closeWarmNativeSessionsForRun: vi.fn(async () => ({ closed: 1, busy: 0, failed: 0 })) },
    envOrchestrator: { releaseForRun: vi.fn<HeartbeatRunControlDependencies["envOrchestrator"]["releaseForRun"]>(async () => ({ released: [], errors: [] })) },
    enqueueWakeup: lifecycleDependencies.enqueueWakeup,
    startNextQueuedRunForAgent: vi.fn<HeartbeatRunControlDependencies["startNextQueuedRunForAgent"]>(),
    sweepPendingCleanupLeases: vi.fn<HeartbeatRunControlDependencies["sweepPendingCleanupLeases"]>(),
    timerClaimWasFirstHeartbeat: vi.fn<HeartbeatRunControlDependencies["timerClaimWasFirstHeartbeat"]>(() => undefined),
    wakeQueue: { releaseIssueExecution: vi.fn<HeartbeatRunControlDependencies["wakeQueue"]["releaseIssueExecution"]>(async () => ({ outcome: { kind: "released" }, postCommitEffects: [] })) },
    applyWakeQueuePostCommitEffects: vi.fn(async () => undefined),
    getSchedulingSuppression: vi.fn(async () => ({ suppressed: false })),
    activeRunExecutions: new Set<string>(),
    processRunCancellationSettlements: new Map<string, { settled: Promise<void>; failed: boolean; error?: unknown }>(),
    failedProcessRunCancellations: new Map<string, { settled: Promise<void>; failed: boolean; error?: unknown }>(),
  } satisfies HeartbeatRunControlDependencies;
}
const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RUN_CONTROL_TEST_DATABASE_URL");
export const runControlPostgresSupport = externalTestDatabaseUrl ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
if (!runControlPostgresSupport.supported) console.warn(`Skipping run-control database tests: ${runControlPostgresSupport.reason}`);

export function setupRunControlDatabase(name: string, ready: (db: Db) => void) {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (externalTestDatabaseUrl) await applyPendingMigrations(externalTestDatabaseUrl);
    else database = await startEmbeddedPostgresTestDatabase(name);
    db = createDb(externalTestDatabaseUrl ?? database!.connectionString);
    ready(db);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    vi.mocked(terminateLocalService).mockReset().mockResolvedValue(undefined);
    await db.execute(sql`truncate table companies restart identity cascade`);
  });
  afterEach(() => runningProcesses.clear());

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Run control", issuePrefix: "RC" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Controlled agent", adapterType: "codex_local" }).returning();
    return { company, agent };
  }
  async function liveRun(companyId: string, agentId: string) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "legacy", runtimeModeResolvedAt: new Date() }).returning();
    runningProcesses.set(run.id, { child: { pid: 424242 } as never, graceSec: 4, processGroupId: 424242 });
    return run;
  }
  return { fixture, liveRun };
}
