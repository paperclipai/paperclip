import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { vi, type Mock, type Mocked } from "vitest";
import { createRunDispatch } from "../../modules/run-dispatch/index.js";
import type { createWakeQueue } from "../../modules/wake-queue/index.js";
import { createHeartbeatRunState } from "../../services/heartbeat/run-state.js";
import { createHeartbeatRunPreparation } from "../../services/heartbeat/run-preparation.js";
import type { HeartbeatQueueDependencies } from "../../services/heartbeat/queue.js";

type Run = typeof heartbeatRuns.$inferSelect;
type MockedCallback = "getAgent" | "setRunStatus" | "setWakeupStatus" | "appendRunEvent" | "finalizeAgentStatus" | "getAgentInvokability" | "getWorktreeExecutionCutoff" | "applyRunDispatchPostCommitEffects" | "getSchedulingSuppression" | "canStartNewExternalBotWork" | "executeRun" | "applyWakeQueuePostCommitEffects" | "releaseIssueExecutionAndPromote" | "publishRunLifecyclePluginEvent" | "cancelRunInternal" | "cancelActiveForAgentInternal" | "resumeExecutionWaitComments" | "readmitUnblockedExecutionWaits" | "resumeQueuedCommentInterrupt" | "resumeSavedLegacyComments" | "sweepPendingCleanupLeases";
type QueueTestDependencies = HeartbeatQueueDependencies & { [K in MockedCallback]: Mock<HeartbeatQueueDependencies[K]> } & {
  issuesSvc: Mocked<HeartbeatQueueDependencies["issuesSvc"]>;
  treeControlSvc: Mocked<HeartbeatQueueDependencies["treeControlSvc"]>;
  budgets: Mocked<HeartbeatQueueDependencies["budgets"]>;
  instanceSettings: Mocked<HeartbeatQueueDependencies["instanceSettings"]>;
  wakeQueue: Mocked<HeartbeatQueueDependencies["wakeQueue"]>;
  liveRunExecutions: Mocked<HeartbeatQueueDependencies["liveRunExecutions"]>;
};

export function createHeartbeatQueueTestDependencies(db: Db): QueueTestDependencies {
  const state = createHeartbeatRunState(db);
  const preparation = createHeartbeatRunPreparation(db);
  return {
    ...preparation,
    ...state,
    getAgent: vi.fn<HeartbeatQueueDependencies["getAgent"]>(async () => { throw new Error("Unexpected agent lookup"); }),
    options: {},
    setRunStatus: vi.fn<HeartbeatQueueDependencies["setRunStatus"]>(async (id, status, patch) =>
      db.update(heartbeatRuns).set({ ...patch, status }).where(eq(heartbeatRuns.id, id)).returning().then(rows => rows[0] ?? null)),
    setWakeupStatus: vi.fn<HeartbeatQueueDependencies["setWakeupStatus"]>(async () => undefined),
    appendRunEvent: vi.fn<HeartbeatQueueDependencies["appendRunEvent"]>(async () => undefined),
    finalizeAgentStatus: vi.fn<HeartbeatQueueDependencies["finalizeAgentStatus"]>(async () => undefined),
    getAgentInvokability: vi.fn<HeartbeatQueueDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    getWorktreeExecutionCutoff: vi.fn<HeartbeatQueueDependencies["getWorktreeExecutionCutoff"]>(async () => null),
    applyRunDispatchPostCommitEffects: vi.fn<HeartbeatQueueDependencies["applyRunDispatchPostCommitEffects"]>(),
    issuesSvc: {
      getDependencyReadiness: vi.fn<HeartbeatQueueDependencies["issuesSvc"]["getDependencyReadiness"]>(),
      listDependencyReadiness: vi.fn(async () => new Map()),
    },
    treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    budgets: { getInvocationBlock: vi.fn(async () => null) },
    instanceSettings: { getExperimental: vi.fn<HeartbeatQueueDependencies["instanceSettings"]["getExperimental"]>() },
    runDispatch: createRunDispatch(db),
    wakeQueue: {
      createAdmissionTransactionScope: vi.fn<ReturnType<typeof createWakeQueue>["createAdmissionTransactionScope"]>(),
      admitWakeBehindIssueExecution: vi.fn<ReturnType<typeof createWakeQueue>["admitWakeBehindIssueExecution"]>(),
    },
    activeRunExecutions: new Set<string>(),
    activeRunExecutionPromises: new Set<Promise<void>>(),
    activeWakeupPromises: new Set<Promise<unknown>>(),
    liveRunExecutions: { has: vi.fn(() => false) },
    isHeartbeatRunTerminalStatus: (status: string | null | undefined) => ["succeeded", "failed", "cancelled", "timed_out"].includes(status ?? ""),
    isSameTaskScope: (left: string | null, right: string | null) => left === right,
    runTaskKey: (run: Run) => typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null,
    filterZombieCoalesceTarget: <T extends { id: string; status: string }>(run: T | null) => run,
    getSchedulingSuppression: vi.fn<HeartbeatQueueDependencies["getSchedulingSuppression"]>(async () => ({ suppressed: false, reason: null } as Awaited<ReturnType<HeartbeatQueueDependencies["getSchedulingSuppression"]>>)),
    canStartNewExternalBotWork: vi.fn<HeartbeatQueueDependencies["canStartNewExternalBotWork"]>(async () => true),
    executeRun: vi.fn<HeartbeatQueueDependencies["executeRun"]>(async () => undefined),
    applyWakeQueuePostCommitEffects: vi.fn<HeartbeatQueueDependencies["applyWakeQueuePostCommitEffects"]>(async () => undefined),
    releaseIssueExecutionAndPromote: vi.fn<HeartbeatQueueDependencies["releaseIssueExecutionAndPromote"]>(async () => undefined),
    publishRunLifecyclePluginEvent: vi.fn<HeartbeatQueueDependencies["publishRunLifecyclePluginEvent"]>(),
    cancelRunInternal: vi.fn<HeartbeatQueueDependencies["cancelRunInternal"]>(async () => undefined),
    cancelActiveForAgentInternal: vi.fn<HeartbeatQueueDependencies["cancelActiveForAgentInternal"]>(async () => undefined),
    resumeExecutionWaitComments: vi.fn<HeartbeatQueueDependencies["resumeExecutionWaitComments"]>(async () => undefined),
    readmitUnblockedExecutionWaits: vi.fn<HeartbeatQueueDependencies["readmitUnblockedExecutionWaits"]>(async () => undefined),
    resumeQueuedCommentInterrupt: vi.fn<HeartbeatQueueDependencies["resumeQueuedCommentInterrupt"]>(async () => undefined),
    resumeSavedLegacyComments: vi.fn<HeartbeatQueueDependencies["resumeSavedLegacyComments"]>(async () => undefined),
    formatIssueIdentifierLink: (_identifier: string | null, fallback: string) => fallback,
    sweepPendingCleanupLeases: vi.fn<HeartbeatQueueDependencies["sweepPendingCleanupLeases"]>(),
  } satisfies HeartbeatQueueDependencies;
}
