/** Shared types for the control-plane restart chaos harness (plan §5). */
import type { ProviderFaultEvent, ProviderFaultKind, ProviderFaultRule, ProviderMessage, ProviderRestartKind } from "./provider-faults.js";
import type { QuestionArtifacts, QuestionRecord } from "./question-handoff.js";
import type { RepeatedRestartRecord, RestartStep } from "./repeated-restarts.js";
import type { TimeFaultRecord } from "./time-faults.js";

/**
 * K14 (upgrade mid-run): a graceful stop, then the replacement starts from the current build (`--upgrade-from`).
 * K15 (redeploy, redeploy.ts): a graceful stop, then the replacement starts in a new emulated process space with a new
 * Railway-shaped deployment id on the same volume, as a hosted deploy replaces the server's container.
 * TM1–TM3 (time faults, time-faults.ts): freeze the server, sleep with aged rows, or an aged outage.
 * RR1–RR3 (repeated restarts, repeated-restarts.ts): a K1, then more restarts while the replacement recovers.
 * MS1–MS3 (two servers, one database, multi-server.ts): a second server beside the first.
 */
export const FAULT_KINDS = ["K1", "K2", "K4", "K6", "K14", "K15", "TM1", "TM2", "TM3", "RR1", "RR2", "RR3", "MS1", "MS2", "MS3"] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];
/** The shortest seeded K4 outage (scheduler.ts K4_HOLD_RANGE_MS), also the K4 hold after a provider fault. */
export const K4_MIN_HOLD_MS = 120_000;
/**
 * A task's planned fault. "K13" (restart storm) tasks have none of their own; the wave's storm crosses them.
 * PV1–PV3 (provider message faults, provider-faults.ts) restart nothing: the task's rule is armed in the Codex shim.
 * "K0" is a `--matrix` baseline cell: the same journey with no fault.
 */
export type TaskFaultKind = FaultKind | "K13" | "K0" | ProviderFaultKind;

/**
 * G1: an approval-gated action across a restart. H1: a budget hard stop crossed mid-run with a restart (its own wave).
 * Q1: a saved question (question-handoff.ts). Q2, Q3: journeys.ts.
 * L1: high-output, high-accounting run for database contention (contention.ts).
 * F1: an absolute symlink pointing out of the repository workspace, kept at rest (staging save-back class F).
 */
export const WORKLOAD_IDS = ["A1", "B1", "B5", "C1", "M1", "G1", "H1", "R1", "S1", "Q1", "L1", "Q2", "Q3", "F1"] as const;
export type WorkloadId = (typeof WORKLOAD_IDS)[number];

export const ADAPTER_IDS = ["codex", "claude", "opencode"] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

/** `asked` and `answered`: the journey boundaries of Q1–Q3 (journeys.ts, question-handoff.ts). */
export const TRIGGER_IDS = ["time", "comment", "retry", "queued", "tool", "result", "approval", "paused", "stop", "asked", "answered"] as const;
/** `provider` is not a `--triggers` choice: `--provider-fault-restart` schedules it (K1 after a provider fault applied). */
export type TriggerId = (typeof TRIGGER_IDS)[number] | "provider";

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
  /** `--daytona-reuse-lease`: the chaos environment keeps its sandboxes between turns (a per-turn run stops and keeps its sandbox). */
  daytonaReuseLease?: boolean;
  /** `--daytona-warm`: the reusable warm Daytona environment fixture. */
  daytonaWarm?: boolean;
  /** `--daytona-inherit`: a Daytona environment that inherits the lifecycle and leaves lease reuse unset. */
  daytonaInherit?: boolean;
  /** `--k4-hold-max-seconds`: upper end of the seeded K4 hold (default 300 s, cap 600 s). */
  k4HoldMaxMs?: number;
  faultAfterMs?: number;
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
  /** Crash-point suite: hold the control plane down this long after each self-kill (K4-style). */
  crashPointHoldMs?: number;
  /**
   * K14 upgrade mid-run (`--upgrade-from <dir>`): an older, prepared checkout. The wave's server starts
   * from it; the first K14 stops it gracefully and starts the current checkout on the same database
   * and instance directory. Later K14 faults restart the current build, like K2.
   */
  upgradeFrom?: string;
  workspaceRepo?: string;
  storage?: "s3";
  storageFaults?: Array<import("./storage-chaos.js").StorageFaultKind>;
  storageFaultMs?: [number, number];
  storageWindows?: import("./storage-chaos.js").StorageFaultWindow[];
  storageTrigger?: import("./storage-trigger.js").StorageTriggerTarget;
  nativeTrigger?: import("./native-trigger.js").NativeTriggerSpec;
  workspaceCommit?: string;
  workspaceGitUrl?: string;
  /** Provider message faults from `--faults` (PV1 delay, PV2 drop, PV3 duplicate); see provider-faults.ts. */
  providerFaults?: ProviderFaultKind[];
  providerFaultMessage?: ProviderMessage;
  /** `--provider-fault-message S1=interrupt_ack,...`: a workload's own message, over `providerFaultMessage`. */
  providerFaultMessageByWorkload?: Partial<Record<WorkloadId, ProviderMessage>>;
  /** PV1 delays, cycled across tasks (`--provider-fault-delays`). */
  providerFaultDelaysMs?: number[];
  /** `--db-pressure <writers>`: harness-owned writers touching the wave's running run rows back to back (contention.ts). */
  dbPressure?: number;
  /** `--matrix`: one task per workload × adapter × (K0, or each fault at each of the workload's triggers). */
  matrix?: boolean;
  /** `--server-from <dir>`: every server of the wave runs from this prepared checkout (for example a pre-fix commit). */
  serverFrom?: string;
  /** TM2/TM3: how far every database timestamp is shifted back (`--time-age-hours`, default 26 h). */
  timeAgeMs?: number;
  /** `--provider-fault-restart K1`: each PV1/PV2 task also restarts the control plane after its fault applied. */
  providerFaultRestart?: ProviderRestartKind;
  /** `--provider-fault-restart K2,K4,K1`: restart kinds cycled across PV1/PV2 tasks (the first is `providerFaultRestart`). */
  providerFaultRestartKinds?: ProviderRestartKind[];
  providerFaultRestartAfterMs?: number;
  /** RR1–RR3: the gap from a replacement's health to the next stop (`--rr-gap-seconds`); absent keeps each kind's default. */
  rrGapMs?: [number, number];
  /** RR1–RR3 (`--rr-stop-on recovering`): stop each replacement on its first `recovering` status instead of after a gap. */
  rrStopOn?: "recovering";
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
  /** PV1–PV3 tasks: the provider message rule armed for this task's nonce. */
  providerFault?: ProviderFaultRule;
  /** RR1–RR3: the seeded restarts after the first kill. */
  restartSteps?: RestartStep[];
}

export interface ScheduledFault {
  kind: FaultKind; holdMs: number;
  atMs: number;
  trigger?: TriggerId;
  delayMs?: number;
  /** RR1–RR3: the restarts after the first kill. */
  restartSteps?: RestartStep[];
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
  /** Bounded code naming why a generic `errorCode` (such as `adapter_failed`) failed, e.g. `40001`. */
  failureCause?: string | null;
  retryOfRunId: string | null;
  wakeCommentIds: string[];
  livenessState: string | null;
  lastEvidenceAt?: string | null;
  /** A tool started with no matching end yet (a long `bench.sh` is quiet but live). */
  toolInFlight?: boolean;
  /** The run's recorded local runner process is still running with the same start time. */
  processAlive?: boolean;
  /** A provider turn started and has no turn terminal yet. */
  providerTurnActive?: boolean;
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
  via?: "ui" | "api";
  bannerText?: string | null;
  diagnostics?: { screenshot: string | null; dom: string | null } | null;
  dismissedDialogs?: string[];
}

export const UI_RETRY_BUTTON_MISSING = "ui_retry_button_missing";
export const UI_RETRY_NO_REQUEST = "ui_retry_no_request";
export const UI_RETRY_BLOCKED_BY_MODAL = "ui_retry_blocked_by_modal";

export interface FaultReceipt {
  faultId: string;
  kind: FaultKind;
  /** Task that scheduled the fault; every other running task is also exposed. */
  requestedBy: string;
  /** "none": MS1 sends no signal to the primary server. */
  signal: "SIGKILL" | "SIGTERM" | "SIGSTOP" | "none";
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
  /** K14: the build the stopped server ran and the build its replacement runs. */
  upgrade?: { fromRoot: string; fromSha: string | null; toRoot: string; toSha: string | null; switched: boolean };
  /** K15: the deploy generation, emulated host name and deployment id before and after. */
  redeploy?: ReturnType<typeof import("./redeploy.js").redeployReceipt>;
  /** TM1–TM3: what was frozen and which rows were aged. */
  timeFault?: TimeFaultRecord;
  /** RR1–RR3: every stop and replacement of the sequence, the first kill included. */
  repeatedRestart?: RepeatedRestartRecord;
  /** MS1–MS3: the second server and what happened to the first. */
  multiServer?: import("./multi-server.js").MultiServerRecord;
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
  stop?: { runId: string | null; runStatus: string | null; runsStartedBeforeContinue: string[]; continuePosted: boolean; missed?: boolean };
  children?: Array<{ id: string; title?: string | null; status: string | null; assigneeAgentId: string | null; documents: Record<string, string | null> }>;
  childStalls?: Array<{ childIssueId: string; recoveryActionId: string | null }>;
  stallWakes?: Array<{ stalledIssueId: string | null; recoveryActionId: string | null }>;
  /** G1: approvals linked to the task. */
  approvals?: Array<{ id: string; status: string; title: string | null }>;
  /** G1 and H1: the board's actions and what the observer saw around them. */
  governance?: GovernanceRecord;
  /** Q1: the saved question and the task's runs. */
  question?: QuestionArtifacts;
  /** PV1–PV3: the shim's log lines for this task. */
  providerFaultEvents?: ProviderFaultEvent[];
  /** L1: accounting and run-log evidence read from the wave database at rest. */
  contention?: import("./contention.js").ContentionEvidence;
  /** Q2, Q3: what the board did and what the task, its runs and the harness's app saw. */
  journey?: import("./journeys.js").JourneyArtifacts;
}

/** What the board did for a governance task (G1, H1), and what the observer saw. */
export interface GovernanceRecord {
  /** G1: first time the observer saw the task's approval pending. */
  approvalSeenAt?: number | null;
  approvalId?: string | null;
  /** G1: the board's decision, made once the task's faults fired and the server was ready. */
  decision?: { kind: "approve" | "reject"; at: number; httpStatus: number | null; error: string | null;
    /** The approval was still pending when the board decided (it survived the restart). */
    pendingWhenDecided: boolean; afterFault: boolean };
  /** H1: the company budget the harness set before launch, in cents (observed spend + 1). */
  budgetSetCents?: number | null;
  budgetSetError?: string | null;
  /** H1: first time the observer saw the company paused for its budget. */
  budgetPausedAt?: number | null;
  /** H1: runs of the task that started while the company was paused (must be none). */
  runsStartedWhilePaused?: string[];
  /** H1: the board's raise-and-resume, made once the task's faults fired and the pause held. */
  resume?: { at: number; amount: number | null; incidentId: string | null; httpStatus: number | null; error: string | null; afterFault: boolean;
    /** When the resume request returned: the pause window ends here. */
    doneAt?: number };
  /** H1: the company was active again at rest. */
  companyActiveAtRest?: boolean;
  /** H1: the pause cleared on its own (before the board resumed it). */
  pauseLostAt?: number | null;
  /** G1: subtasks named after the nonce that existed before the board decided (must be 0). */
  childrenBeforeDecision?: number | null;
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
  followUp: { at: number; sentAt?: number; postedAt?: number; commentId: string | null; error: string | null; duringRun?: boolean } | null;
  stop?: { at: number; runId: string | null; httpStatus: number | null; error: string | null; missed?: boolean };
  faultIds: string[];
  sweep: RestSweep | null;
  /** Workspace files present just before the first fault that hit this task (R2). */
  preFaultFiles: string[] | null;
  preFaultWorkspacePath?: string;
  lastFaultAt?: number;
  restSnapshotError?: string;
  priorRetries?: RetryAttempt[];
  childStalls?: Array<{ childIssueId: string; recoveryActionId: string | null }>;
  childRetries?: Array<RetryAttempt & { childIssueId: string }>;
  workspaceMovedTo?: string;
  /** Set when the pre-fault snapshot could not read the workspace; R2 then fails visibly. */
  preFaultSnapshotError?: string | null;
  remoteWorkspace?: boolean;
  remoteFiles?: Record<string, string | null>;
  remoteFileErrors?: Record<string, string>;
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
  governance?: GovernanceRecord;
  /** K14 waves: the build serving when the task launched. */
  serverBuildAtLaunch?: "upgrade_from" | "current";
  /** Q1: the saved question and the board's answer. */
  question?: QuestionRecord;
  /** Q2, Q3: the board's journey actions (journey-driver.ts). */
  journey?: import("./journeys.js").JourneyRecord;
  /** PV with `--provider-fault-restart`: when the shim logged the task's fault (arms the `provider` trigger). */
  providerFaultAppliedAt?: number;
}

export interface TaskGrade {
  crossed: boolean;
  crossingFaults: string[];
  rules: Record<RuleId, RuleResult>;
  T: OracleResult;
  /** Universal checks U1–U4 (universal.ts); absent on grades written before them. */
  universal?: import("./universal.js").UniversalGrade;
  pass: boolean;
  signature: string | null;
}
