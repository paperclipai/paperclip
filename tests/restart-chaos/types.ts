/** Shared types for the control-plane restart chaos harness (plan §5). */

export const FAULT_KINDS = ["K1", "K2", "K4", "K6"] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];
/** A task's planned fault. "K13" (restart storm) tasks have none of their own; the wave's storm crosses them. */
export type TaskFaultKind = FaultKind | "K13";

export const WORKLOAD_IDS = ["A1", "B1", "B5", "C1"] as const;
export type WorkloadId = (typeof WORKLOAD_IDS)[number];

export const ADAPTER_IDS = ["codex", "claude", "opencode"] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

export const TRIGGER_IDS = ["time", "comment", "retry", "queued", "tool", "result"] as const;
export type TriggerId = (typeof TRIGGER_IDS)[number];

export const ENVIRONMENT_KINDS = ["local", "daytona"] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

export interface WaveOptions {
  env: EnvironmentKind;
  adapters: AdapterId[];
  workloads: WorkloadId[];
  faults: FaultKind[];
  triggers?: TriggerId[];
  concurrency: number;
  tasks: number;
  seed: number;
  /** Company budget hard cap in cents; the product hard-stops at this value. */
  budgetCents: number;
  /** Poll interval for the observer, 2–5 s per plan §5. */
  pollMs: number;
  /** `--env daytona`: the immutable runner image (registry/repository@sha256:…). */
  daytonaImage?: string;
  /** `--env daytona`: vCPU per sandbox (see seed.ts chaosDaytonaShape). */
  daytonaCpu?: number;
  /** `--k4-hold-max-seconds`: upper end of the seeded K4 hold (default 300 s, cap 600 s). */
  k4HoldMaxMs?: number;
  /**
   * Known product signatures this wave deliberately masks. "rc06" keeps the
   * company budget amount but disables its hard stop, so a stuck
   * accounting row (RC-06) cannot wedge every later task. Spend is still
   * recorded per wave. Absent on plans written before masks existed.
   */
  masks?: string[];
  /**
   * K13 restart storm: fire faults drawn from `faults` every 2–4 minutes for
   * this many minutes, keeping `concurrency` tasks in flight, then drain.
   */
  stormMinutes?: number;
  /**
   * Runner lifecycle forced onto every seeded agent (`--lifecycle`). Absent
   * keeps the catalog profile's own setting.
   */
  lifecycle?: "per_turn" | "warm" | "default";
  /**
   * Crash-point suite (`--crash-point <name>[:<nth>][,...]`): no external
   * fault is scheduled. One server serves every listed point in turn: each
   * point's batch of tasks launches, then the point is armed and the server
   * SIGKILLs itself at its nth hit and is restarted like K1.
   */
  crashPoint?: string;
}

export interface StormFault {
  kind: FaultKind;
  holdMs: number;
  /** Wait this long after the previous storm fault settled (or the storm started). */
  gapMs: number;
}

export interface StormPlan {
  durationMs: number;
  faults: StormFault[];
}

export interface TaskPlan {
  taskId: string;
  index: number;
  workload: WorkloadId;
  adapter: AdapterId;
  fault: TaskFaultKind;
  /** Fire the fault this long after the task's issue is created. */
  fireAfterMs: number;
  /** Outage hold between stop and restart. 0 for K1/K2. */
  holdMs: number;
  trigger?: TriggerId;
  triggerDelayMs?: number;
  /** C1 only: post the follow-up comment this long after creation. */
  followUpAfterMs: number | null;
  /** Unique marker used by the deterministic T-oracle. */
  nonce: string;
  /**
   * Replay only: every fault that crossed this task in the source wave, with
   * its offset from the task's launch. Replaces the single planned fault.
   */
  replayFaults?: ScheduledFault[];
}

export interface ScheduledFault {
  kind: FaultKind; holdMs: number;
  atMs: number;
  trigger?: TriggerId;
  delayMs?: number;
}

export interface WavePlan {
  schema: "paperclip.restart-chaos.wave-plan/v1";
  waveId: string;
  seed: number;
  createdAt: string;
  options: WaveOptions;
  tasks: TaskPlan[];
  /** K13 only: the seeded storm fault sequence. */
  storm?: StormPlan;
  /** Present when this wave replays one task of an earlier wave. */
  replayOf?: { waveId: string; taskId: string };
}

export type Verdict = "pass" | "fail" | "n/a";
export interface RuleResult { verdict: Verdict; detail: string }
export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6";

export interface RunSample {
  id: string;
  status: string;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  retryOfRunId: string | null;
  wakeCommentIds: string[];
  livenessState: string | null;
  lastEvidenceAt?: string | null;
  /** A tool started with no matching end yet (a long `bench.sh` is quiet but live). */
  toolInFlight?: boolean;
  /** The run's recorded local runner process is still running with the same start time. */
  processAlive?: boolean;
}

export interface InterruptionSample {
  state: string;
  canRetry: boolean;
  retryWait: boolean;
  workspaceFailure: string | null;
  observedRunId: string | null;
  userAction: string | null;
}

/** One observer poll. Unreachable polls keep only the timestamp. */
export interface TaskSample {
  at: number;
  reachable: boolean;
  serverReady: boolean;
  issueStatus?: string;
  interruption?: InterruptionSample | null;
  activeRecoveryAction?: boolean;
  /** Owner of the active recovery action; "board" means it waits on a person. */
  recoveryOwner?: string | null;
  executionBlocker?: boolean;
  scheduledRetry?: boolean;
  runs?: RunSample[];
}

export interface RetryAttempt {
  at: number;
  acceptedAt?: number;
  observedRunId: string | null;
  httpStatus: number | null;
  accepted: boolean | null;
  error: string | null;
}

export interface FaultReceipt {
  faultId: string;
  kind: FaultKind;
  /** Task that scheduled the fault; every other running task is also exposed. */
  requestedBy: string;
  signal: "SIGKILL" | "SIGTERM";
  holdMs: number;
  requestedAt: number;
  startedAt: number;
  stoppedAt: number | null;
  restartedAt: number | null;
  healthyAt: number | null;
  readyAt: number | null;
  phases: Array<{ phase: string; at: number }>;
  trigger?: TriggerId;
  triggerDelayMs?: number;
  loadAvg1m?: number;
  crashLoop?: Array<{ pid: number | null; target: string; phase: string; at: number }>;
  /** Crash-point suite: the server killed itself at this named point (no external signal). */
  crashPoint?: { name: string; hit: number; pid: number; token?: string };
  serverLogOffsetAtStart: number;
  serverLogOffsetAtReady: number | null;
  error: string | null;
}

export interface OracleArtifacts {
  issueStatus: string | null;
  documents: Record<string, string | null>;
  agentComments: string[];
  files: Record<string, string | null>;
  commands: Record<string, { exitCode: number | null; stdout: string; stderr: string }>;
  workspacePath: string | null;
  /** B5: distinct `.bench/progress` values the harness itself saw while the task was live. */
  benchProgressObserved?: number;
}

export interface OracleResult { verdict: Exclude<Verdict, "n/a">; checks: Array<{ name: string; ok: boolean; detail?: string }> }

export interface RestSweep {
  activeRuns: string[];
  runningWorkspaceOperations: string[];
  activeRecoveryAction: boolean;
  /** `--env daytona`: orphaned sandboxes and held leases belonging to this task's runs. */
  daytonaLeaks?: string[];
  error: string | null;
}

export interface TaskRecord {
  plan: TaskPlan;
  issueId: string | null;
  identifier: string | null;
  createdAt: number | null;
  launchError: string | null;
  samples: TaskSample[];
  retry: RetryAttempt | null;
  restAt: number | null;
  finalStatus: string | null;
  deadlineAt: number | null;
  timedOut: boolean;
  followUp: { at: number; postedAt?: number; commentId: string | null; error: string | null; duringRun?: boolean } | null;
  faultIds: string[];
  sweep: RestSweep | null;
  /** Workspace files present just before the first fault that hit this task (R2). */
  preFaultFiles: string[] | null;
  preFaultWorkspacePath?: string;
  lastFaultAt?: number;
  restSnapshotError?: string;
  priorRetries?: RetryAttempt[];
  workspaceMovedTo?: string;
  /** Set when the pre-fault snapshot could not read the workspace; R2 then fails visibly. */
  preFaultSnapshotError?: string | null;
  /** Pre-fault files missing at rest; null when not checked. */
  lostFiles: string[] | null;
  /** B5: distinct bench progress values the observer read during polling. */
  benchProgressSeen?: string[];
  benchFirstSeenAt?: number | null;
  /** C1: first time the observer saw the run that received the follow-up propose or accept its result. */
  resultAcceptedAt?: number | null;
  /** The run whose result armed the `result` trigger; the fault fires only while it is still running. */
  resultRunId?: string | null;
  triggerMissed?: TriggerId[];
}

export interface TaskGrade {
  crossed: boolean;
  crossingFaults: string[];
  rules: Record<RuleId, RuleResult>;
  T: OracleResult;
  pass: boolean;
  signature: string | null;
}
