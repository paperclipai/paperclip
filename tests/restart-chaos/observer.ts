import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChaosApiError, type ChaosApi } from "./api.js";
import { ACTIVE_RUN_STATUSES, isStalledSample, STALL_LIMIT_MS } from "./grader.js";
import type { ChaosLab } from "./seed.js";
import type { Timeline } from "./timeline.js";
import type {
  AdapterId, GovernanceRecord, InterruptionSample, OracleArtifacts, RestSweep, RetryAttempt, RunSample, ScheduledFault, TaskPlan, TaskRecord,
  TaskSample, TriggerId,
} from "./types.js";
import { restartProcessStartMatches } from "../runner-e2e/process-tree-owner.js";
import type { UiRetryClick } from "./board-ui.js";
import { runOracleCommand } from "./oracle-sandbox.js";
import { awaitingQuestionAnswer, collectQuestionArtifacts, questionStep } from "./question-handoff.js";
import { captureRemoteWorkspaceFiles, readRemoteWorkspaceFile } from "./remote-workspace-files.js";
import { taskFaultSchedule } from "./scheduler.js";
import { g1ChildTitle, g1Decision, workloadDefinitions, type WorkloadAgents } from "./workloads.js";
import { databaseUrlFromConfig, journeyDriverFor, type JourneyDriver } from "./journey-driver.js";

const IGNORED_DIRECTORIES = new Set([".git", ".bench", "__pycache__", "node_modules"]);
const MAX_SNAPSHOT_FILES = 2_000;

/** Relative paths of workspace files, excluding VCS and cache directories. */
export async function listWorkspaceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (relative: string) => {
    if (out.length >= MAX_SNAPSHOT_FILES) return;
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(child); }
      else if (entry.isFile()) out.push(child);
      if (out.length >= MAX_SNAPSHOT_FILES) return;
    }
  };
  await walk("");
  return out.sort();
}

export const QUEUED_TRIGGER_MAX_EMPTY_SAMPLES = 3;

function stillQueued(runs: readonly RunSample[]): boolean {
  return runs.some(run => run.status === "queued" && !run.startedAt) && !runs.some(run => run.startedAt || run.status === "running");
}
export const TRIGGER_LATE_MS = 10_000;
/** The run settles soon after acceptance; arming on the proposal keeps the window reachable. */
const RESULT_TRIGGER_EVENTS = new Set(["run.result.proposed", "run.result.accepted"]);

/** Rest must hold for this long before the observer acts on it. */
export const REST_CONFIRM_MS = 12_000;
export const CHILD_WAKE_GRACE_MS = 60_000;
export const CHILD_STALL_CHECK_MS = 10_000;
export const STOP_CONTINUE_AFTER_MS = 20_000;

type ChildSpeedTask = { issueId: string; adapter: AdapterId; samples: Array<{ runs?: RunSample[] }> };

export async function childSpeedTasksInTurn(observers: ReadonlyArray<{ childSpeedTasks(): Promise<ChildSpeedTask[]> }>): Promise<ChildSpeedTask[]> {
  const tasks: ChildSpeedTask[] = [];
  for (const observer of observers) tasks.push(...await observer.childSpeedTasks());
  return tasks;
}

export function childrenPending(children: ReadonlyArray<{ status: string | null }> | null): boolean {
  return !children || children.some(child => !["done", "cancelled", "blocked"].includes(child.status ?? ""));
}
/** Extra time granted after a Retry click before R3 is graded as timed out. */
export const RETRY_BUDGET_MS = 15 * 60_000;
/** H1: how long the pause must hold with the server ready before the board resumes. */
export const BUDGET_PAUSE_HOLD_MS = 30_000;
/** H1: the raised budget's headroom above observed spend, in cents. */
export const BUDGET_RESUME_HEADROOM_CENTS = 3_000;
const DECISION_NOTE = "Restart chaos harness: board decision after a control-plane restart.";

type Json = Record<string, any>;

export function toRunSample(run: Json): RunSample {
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  const wake = new Set([...list(run.wakeCommentIds), ...(typeof run.wakeCommentId === "string" ? [run.wakeCommentId] : [])]);
  return {
    id: String(run.runId ?? run.id), status: String(run.status), createdAt: run.createdAt ?? null, startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null, errorCode: run.errorCode ?? null, retryOfRunId: run.retryOfRunId ?? null,
    wakeCommentIds: [...wake], livenessState: run.livenessState ?? null,
    lastEvidenceAt: latestIso([run.startedAt, run.lastUsefulActionAt, run.execution?.lastConfirmedActivityAt]),
  };
}

interface RunEventCursor {
  seq: number;
  lastAt: string | null;
  /** Tool starts minus tool ends. PRP item ids are not unique per tool call, so this counts. */
  openTools: number;
  /** The run's latest recorded local runner process, until recovery reports it stopped. */
  process: { pid: number; startedAt: string } | null;
}

/** R5 liveness: a tool in flight, or a recorded local runner process. */
export function noteLivenessEvent(cursor: RunEventCursor, event: Json) {
  const payload = (event.payload ?? {}) as Json;
  switch (event.eventType) {
    case "tool.execution.started": cursor.openTools += 1; break;
    case "tool.execution.completed": cursor.openTools = Math.max(0, cursor.openTools - 1); break;
    case "native.process_identity_recorded":
      if (payload.targetKind === "local" && Number.isSafeInteger(payload.processPid) && typeof payload.processStartedAt === "string") {
        // A replacement runner cannot finish a tool its predecessor started.
        if (cursor.process && cursor.process.pid !== payload.processPid) cursor.openTools = 0;
        cursor.process = { pid: payload.processPid, startedAt: payload.processStartedAt };
      }
      break;
    case "native.local_process_stopped":
      // A stopped runner's in-flight tools can never send their completion.
      if (cursor.process && payload.processPid === cursor.process.pid) { cursor.process = null; cursor.openTools = 0; }
      break;
  }
}

/** Alive only when the PID still runs with the recorded start time, so a recycled PID never counts. */
export function localProcessAlive(pid: number, startedAt: string): boolean {
  if (process.platform === "win32") return false;
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeout: 5_000 });
  const started = Date.parse(result.stdout?.trim() ?? "");
  return Number.isFinite(started) && restartProcessStartMatches(new Date(started).toISOString(), startedAt);
}

export function latestIso(values: ReadonlyArray<unknown>): string | null {
  let best: number | null = null;
  for (const value of values) {
    const at = typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(at) && (best === null || at > best)) best = at;
  }
  return best === null ? null : new Date(best).toISOString();
}

export const RUN_EVENT_PAGE = 500;

/** G1: an approval this task asked for (its title names the nonce; a redacted title still counts). */
export function approvalTitleMatches(approval: Json, nonce: string): boolean {
  const title = approval.payload?.title;
  return typeof title !== "string" || title.includes(nonce);
}

/** H1: runs that started at or after `since` and before `until` (epoch ms), across every sample. */
export function runsStartedAfter(samples: readonly TaskSample[], since: number, until = Number.POSITIVE_INFINITY): string[] {
  const started = new Set<string>();
  for (const sample of samples) for (const run of sample.runs ?? []) {
    const at = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
    if (Number.isFinite(at) && at >= since && at < until) started.add(run.id);
  }
  return [...started];
}

export function toInterruption(value: Json | null | undefined): InterruptionSample | null {
  if (!value) return null;
  return { state: String(value.state), canRetry: value.canRetry === true, retryWait: Boolean(value.retryWait),
    workspaceFailure: value.workspaceFailure?.message ?? null, observedRunId: value.observedRunId ?? null, userAction: value.userAction ?? null };
}

/** Rest = no live run and nothing the system itself is still doing. */
export function isResting(sample: TaskSample): boolean {
  if (!sample.reachable || !sample.serverReady) return false;
  if ((sample.runs ?? []).some(run => ACTIVE_RUN_STATUSES.has(run.status))) return false;
  if (sample.scheduledRetry) return false;
  // A board-owned recovery waits on a person: that is a resting state.
  if (sample.activeRecoveryAction && sample.recoveryOwner !== "board") return false;
  const interruption = sample.interruption;
  if (interruption && (interruption.state === "working" || interruption.state === "retry_scheduled" || interruption.retryWait)) return false;
  // Unexplained idle work is a possible stall, not a rest: keep watching it so
  // the task can still resume and R5 can measure the stall.
  if (isStalledSample(sample)) return false;
  return true;
}

/** Stop watching an unexplained idle task once it exceeds the R5 stall limit. */
export const STALL_GIVE_UP_MS = STALL_LIMIT_MS + 15_000;

export class TaskObserver {
  readonly record: TaskRecord;
  issue: Json | null = null;
  private restCandidateSince: number | null = null;
  private childrenSettledAt: number | null = null;
  private childStallCheckedAt: number | null = null;
  private stallSince: number | null = null;
  /** First sample of the current stretch with the server ready (H1 holds the pause across it). */
  private readySince: number | null = null;
  private readonly faultSchedule: ScheduledFault[];
  private readonly pendingFaults: ScheduledFault[];
  done = false;

  /** Replaceable in tests. A Daytona run's process is remote, so only local runs are checked. */
  processAlive = (pid: number, startedAt: string) => this.lab.environmentKind === "local" && localProcessAlive(pid, startedAt);

  constructor(readonly plan: TaskPlan, private readonly api: ChaosApi, private readonly lab: ChaosLab,
    private readonly timeline: Timeline,
    private readonly supervisor: { serverReady: boolean; faultInProgress: boolean; serverBuild?: "upgrade_from" | "current"; paths?: { configPath: string } },
    /** Paths oracle commands may not read: the operator's home, the instance root (secrets key, database) and results. */
    private readonly protectedRoots: readonly string[] = [os.homedir()],
    private readonly board: { clickRetry(identifier: string, issueId: string): Promise<UiRetryClick> } | null = null) {
    this.record = { plan, issueId: null, identifier: null, createdAt: null, launchError: null, samples: [], retry: null,
      restAt: null, finalStatus: null, deadlineAt: null, timedOut: false, followUp: null, faultIds: [], sweep: null,
      preFaultFiles: null, lostFiles: null };
    this.faultSchedule = taskFaultSchedule(plan);
    this.pendingFaults = [...this.faultSchedule];
    this.journey = journeyDriverFor({ plan, api, lab, timeline, record: this.record,
      databaseUrl: () => databaseUrlFromConfig(supervisor.paths?.configPath) });
  }

  /** Q1–Q3: the board's side of the journey (journey-driver.ts). */
  readonly journey: JourneyDriver | null;

  get definition() { return workloadDefinitions[this.plan.workload]; }

  /**
   * Crash-point suite: create the issue without an assignee, so no wake is
   * queued yet. `release` assigns it once the batch's point is armed.
   */
  async stage(): Promise<void> { await this.launch({ assign: false }); }

  /**
   * Assigns a staged issue, which queues its wake. An earlier task of the same
   * batch can crash the server meanwhile, so retry until the replacement
   * answers; setting the same assignee again is idempotent.
   */
  async release(deadlineMs = 10 * 60_000): Promise<void> {
    if (this.done || !this.record.issueId) return;
    const until = Date.now() + deadlineMs;
    for (;;) {
      try {
        await this.api.patch(`/api/issues/${this.record.issueId}`, { assigneeAgentId: this.journey?.assigneeAgentId ?? this.lab.agents[this.plan.adapter].id });
        break;
      } catch (error) {
        const transient = error instanceof ChaosApiError && (error.status === null || error.status >= 500);
        if (!transient || Date.now() > until) {
          this.record.launchError = error instanceof Error ? error.message : String(error);
          this.done = true;
          this.timeline.add("task_launch_failed", { taskId: this.plan.taskId, error: this.record.launchError });
          return;
        }
        await delay(1_000);
      }
    }
    this.record.createdAt = Date.now();
    this.record.deadlineAt = this.record.createdAt + this.definition.budgetMs;
    this.timeline.add("task_released", { taskId: this.plan.taskId, issueId: this.record.issueId });
  }

  async launch(options: { assign?: boolean } = {}): Promise<void> {
    const definition = this.definition;
    const assign = options.assign !== false;
    if (this.plan.workload === "H1") await this.lowerBudgetToSpend();
    try {
      // Q3: connect the harness's app and hire its agent; a failed setup is a failed launch.
      await this.journey?.prepare();
      const issue = await this.api.post<Json>(`/api/companies/${this.lab.companyId}/issues`, {
        title: definition.title(this.plan.nonce),
        description: definition.description(this.plan.nonce, this.workloadAgents()),
        status: "todo",
        priority: "medium",
        ...(assign ? { assigneeAgentId: this.journey?.assigneeAgentId ?? this.lab.agents[this.plan.adapter].id } : {}),
        ...(definition.usesRepository ? { projectId: this.lab.projectId } : {}),
      });
      this.record.issueId = String(issue.id);
      this.record.identifier = issue.identifier ?? null;
      // K14: which build launched the task, so a replay starts it on the same one.
      if (this.supervisor.serverBuild) this.record.serverBuildAtLaunch = this.supervisor.serverBuild;
      this.record.createdAt = Date.now();
      this.record.deadlineAt = this.record.createdAt + definition.budgetMs;
      this.timeline.add("task_launched", { taskId: this.plan.taskId, issueId: issue.id, identifier: issue.identifier,
        workload: this.plan.workload, adapter: this.plan.adapter, faults: this.faultSchedule });
    } catch (error) {
      this.record.launchError = error instanceof Error ? error.message : String(error);
      this.done = true;
      this.timeline.add("task_launch_failed", { taskId: this.plan.taskId, error: this.record.launchError });
    }
  }

  /** The next scheduled fault once it is due and the task has not rested yet. */
  faultDue(now: number): ScheduledFault | null {
    if (this.done || this.record.createdAt === null) return null;
    for (const fault of [...this.pendingFaults]) {
      const armedAt = this.triggerArmedAt(fault);
      if (armedAt === null) continue;
      const dueAt = armedAt === "missed" ? 0 : armedAt + (fault.delayMs ?? 0);
      if (armedAt !== "missed" && now < dueAt) continue;
      this.pendingFaults.splice(this.pendingFaults.indexOf(fault), 1);
      const triggered = fault.trigger !== undefined && fault.trigger !== "time";
      if (armedAt === "missed" || (triggered && !this.triggerWindowOpen(fault, now, dueAt))) {
        this.noteTriggerMissed(fault);
        continue;
      }
      return fault;
    }
    return null;
  }

  private triggerWindowOpen(fault: ScheduledFault, now: number, dueAt: number): boolean {
    if (now - dueAt > TRIGGER_LATE_MS) return false;
    if (fault.trigger === "result") return this.resultRunStillRunning(this.latestReachableRuns());
    if (fault.trigger !== "queued") return true;
    const latest = [...this.record.samples].reverse().find(sample => sample.reachable);
    return stillQueued(latest?.runs ?? []);
  }

  async confirmTrigger(fault: ScheduledFault, now: number): Promise<boolean> {
    if (!fault.trigger || fault.trigger === "time") return true;
    const armedAt = this.triggerArmedAt(fault);
    let open = typeof armedAt === "number" && now - (armedAt + (fault.delayMs ?? 0)) <= TRIGGER_LATE_MS;
    if (open && fault.trigger === "result") {
      const runs = await this.api.get<Json[]>(`/api/issues/${this.record.issueId}/runs`, 5_000)
        .then(rows => (rows ?? []).map(toRunSample)).catch(() => null);
      open = runs !== null && this.resultRunStillRunning(runs);
    }
    if (open && fault.trigger === "queued") {
      const runs = await this.api.get<Json[]>(`/api/issues/${this.record.issueId}/runs`, 5_000)
        .then(rows => (rows ?? []).map(toRunSample)).catch(() => null);
      open = runs !== null && stillQueued(runs);
    }
    if (!open) this.noteTriggerMissed(fault);
    return open;
  }

  private latestReachableRuns(): RunSample[] {
    return [...this.record.samples].reverse().find(sample => sample.reachable)?.runs ?? [];
  }

  /** A `result` fault outside the accepted-but-unsettled window would test a different boundary. */
  private resultRunStillRunning(runs: readonly RunSample[]): boolean {
    return runs.some(run => run.id === this.record.resultRunId && run.status === "running");
  }

  /** A due fault the wave decided not to fire (for example, the storm ended during its checks). */
  markTriggerMissed(fault: ScheduledFault) {
    if (fault.trigger && fault.trigger !== "time") this.noteTriggerMissed(fault);
  }

  private noteTriggerMissed(fault: ScheduledFault) {
    const trigger = fault.trigger ?? "time";
    (this.record.triggerMissed ??= []).push(trigger);
    this.timeline.add("trigger_missed", { taskId: this.plan.taskId, trigger, fault: fault.kind });
  }

  private triggerArmedAt(fault: ScheduledFault): number | null | "missed" {
    const createdAt = this.record.createdAt!;
    switch (fault.trigger ?? "time") {
      case "time": return createdAt + fault.atMs;
      case "comment": {
        const followUp = this.record.followUp;
        if (!followUp) return null;
        return followUp.commentId && followUp.duringRun ? followUp.postedAt ?? followUp.at : "missed";
      }
      case "retry": {
        const retry = this.record.retry;
        if (!retry) return null;
        return retry.accepted ? retry.acceptedAt ?? retry.at : "missed";
      }
      case "queued": {
        const first = this.record.samples.find(sample => sample.reachable && (sample.runs ?? []).length > 0);
        if (!first) return this.record.samples.filter(sample => sample.reachable).length >= QUEUED_TRIGGER_MAX_EMPTY_SAMPLES ? "missed" : null;
        const queued = (first.runs ?? []).some(run => run.status === "queued" && !run.startedAt);
        const started = (first.runs ?? []).some(run => run.startedAt || run.status === "running");
        return queued && !started ? first.at : "missed";
      }
      case "tool": return this.record.benchFirstSeenAt ?? null;
      case "provider": return this.record.providerFaultAppliedAt ?? null;
      case "approval": return this.record.governance?.approvalSeenAt ?? null;
      case "paused": return this.record.governance?.budgetPausedAt ?? null;
      // Q1 keeps its own record (question-handoff.ts); Q2 and Q3 use the journey driver.
      case "asked": return this.journey ? this.journey.armedAt("asked") : this.record.question?.seenAt ?? null;
      case "answered": {
        if (this.journey) return this.journey.armedAt("answered");
        const answer = this.record.question?.answer;
        return answer ? (answer.error ? "missed" : answer.at) : null;
      }
      case "stop": {
        const stop = this.record.stop;
        if (!stop) return null;
        return stop.error || stop.missed ? "missed" : stop.at;
      }
      case "result": {
        // B8: the run that received the follow-up has accepted its result but
        // has not settled yet. A follow-up posted at rest cannot cross it.
        const followUp = this.record.followUp;
        if (!followUp) return null;
        if (!followUp.commentId || !followUp.duringRun) return "missed";
        return this.record.resultAcceptedAt ?? null;
      }
    }
  }

  private closeUnfiredTriggers() {
    for (const fault of this.pendingFaults.splice(0)) if (fault.trigger && fault.trigger !== "time") this.noteTriggerMissed(fault);
  }

  /**
   * B5: read bench.sh's progress file while the task is live. The harness sees
   * the values change over minutes, which a computed answer cannot produce.
   */
  private async observeBenchProgress(): Promise<void> {
    if (this.plan.workload !== "B5") return;
    const cwd = (this.issue?.currentExecutionWorkspace as Json | null | undefined)?.cwd;
    if (typeof cwd !== "string") return;
    const value = (await readFile(path.join(cwd, ".bench", "progress"), "utf8").catch(() => "")).trim();
    if (!value) return;
    const seen = this.record.benchProgressSeen ??= [];
    if (!seen.includes(value)) seen.push(value);
    this.record.benchFirstSeenAt ??= Date.now();
  }

  /** R2: remember which workspace files existed before the first fault hit this task. */
  async snapshotBeforeFault(): Promise<void> {
    if (this.record.preFaultFiles !== null || this.done) return;
    // One task's snapshot failure must not end the wave; R2 fails with the reason.
    try {
      const workspace = await this.workspacePath();
      if (workspace && this.lab.environmentKind !== "local" && !await access(workspace).then(() => true, () => false)) {
        this.record.remoteWorkspace = true;
      } else if (workspace) {
        this.record.preFaultFiles = await listWorkspaceFiles(workspace); this.record.preFaultWorkspacePath = workspace;
      }
    } catch (error) {
      this.record.preFaultSnapshotError = error instanceof Error ? error.message : String(error);
      this.timeline.add("pre_fault_snapshot_failed", { taskId: this.plan.taskId, error: this.record.preFaultSnapshotError });
    }
  }

  noteFault(faultId: string, startedAt?: number) {
    if (!this.record.faultIds.includes(faultId)) this.record.faultIds.push(faultId);
    if (startedAt !== undefined) this.record.lastFaultAt = Math.max(this.record.lastFaultAt ?? 0, startedAt);
  }

  markUnfinished() {
    if (this.done) return;
    const last = this.record.samples.at(-1);
    this.record.timedOut = true;
    this.record.finalStatus = last?.issueStatus ?? this.record.finalStatus;
    this.done = true;
    this.timeline.add("task_unfinished_at_interrupt", { taskId: this.plan.taskId, status: this.record.finalStatus });
  }

  /** Outages extend the deadline: R1 allows budget plus outage time. */
  extendDeadline(ms: number) { if (this.record.deadlineAt !== null) this.record.deadlineAt += ms; }

  async poll(now = Date.now()): Promise<void> {
    if (this.done || !this.record.issueId) return;
    const sample = await this.sample(now);
    this.record.samples.push(sample);
    await this.captureRemoteFilesAtDone(sample);
    this.readySince = sample.reachable && sample.serverReady ? (this.readySince ?? now) : null;
    await this.observeBenchProgress();
    await this.governanceStep(sample, now);
    if (this.journey && await this.journey.step({ sample, now, pendingFaults: this.pendingFaults,
      quiet: sample.reachable && sample.serverReady && !this.supervisor.faultInProgress })) this.restCandidateSince = null;
    if (await this.observeChildStalls(now)) {
      this.restCandidateSince = null;
      this.childrenSettledAt = null;
    }
    if (await this.maybeStop(sample, now)) {
      this.restCandidateSince = null;
      return;
    }
    if (await this.maybeFollowUp(sample, now)) {
      // The comment response is not the agent's answer: require fresh samples.
      this.restCandidateSince = null;
      return;
    }
    // A task waiting on the board (G1's approval, H1's paused company) is in a named wait, not a stall.
    this.stallSince = isStalledSample(sample) && !this.awaitingBoard() ? (this.stallSince ?? now) : null;
    if (this.stallSince !== null && now - this.stallSince > STALL_GIVE_UP_MS) {
      this.record.restAt = this.stallSince;
      this.record.finalStatus = sample.issueStatus ?? null;
      this.done = true;
      this.timeline.add("task_stalled", { taskId: this.plan.taskId, status: sample.issueStatus, idleMs: now - this.stallSince });
      return;
    }
    if (!isResting(sample) || this.supervisor.faultInProgress) {
      this.restCandidateSince = null;
    } else {
      this.restCandidateSince ??= now;
      if (now - this.restCandidateSince >= REST_CONFIRM_MS) {
        await this.onRest(sample, now);
        // A task still waiting (for the board, or on a Retry it just got) keeps its deadline.
        if (this.done) return;
      }
    }
    if (this.record.deadlineAt !== null && now > this.record.deadlineAt && !this.supervisor.faultInProgress) {
      this.record.timedOut = true;
      this.record.finalStatus = sample.issueStatus ?? this.record.finalStatus;
      this.done = true;
      this.timeline.add("task_timed_out", { taskId: this.plan.taskId, status: sample.issueStatus });
    }
  }

  private readonly runEventCursors = new Map<string, RunEventCursor>();

  private async runEvidence(run: RunSample): Promise<RunSample> {
    if (run.status !== "running") return run;
    const cursor = this.runEventCursors.get(run.id) ?? { seq: 0, lastAt: null, openTools: 0, process: null };
    for (let page = 0; page < 3; page += 1) {
      const events = await this.api.get<Json[]>(`/api/heartbeat-runs/${run.id}/events?afterSeq=${cursor.seq}&limit=${RUN_EVENT_PAGE}`, 5_000).catch(() => null);
      if (!events?.length) break;
      for (const event of events) {
        if (typeof event.seq === "number" && event.seq > cursor.seq) cursor.seq = event.seq;
        if (RESULT_TRIGGER_EVENTS.has(String(event.eventType)) && this.record.followUp?.duringRun && !this.record.resultAcceptedAt) {
          this.record.resultAcceptedAt = Date.now();
          this.record.resultRunId = run.id;
        }
        cursor.lastAt = latestIso([cursor.lastAt, event.createdAt]);
        noteLivenessEvent(cursor, event);
      }
      if (events.length < RUN_EVENT_PAGE) break;
    }
    this.runEventCursors.set(run.id, cursor);
    return { ...run, lastEvidenceAt: latestIso([run.lastEvidenceAt, cursor.lastAt]),
      ...(cursor.openTools > 0 ? { toolInFlight: true } : {}),
      ...(cursor.process && this.processAlive(cursor.process.pid, cursor.process.startedAt) ? { processAlive: true } : {}) };
  }

  private async sample(now: number): Promise<TaskSample> {
    const serverReady = this.supervisor.serverReady && !this.supervisor.faultInProgress;
    try {
      const [issue, runs] = await Promise.all([
        this.api.get<Json>(`/api/issues/${this.record.issueId}`, 5_000),
        this.api.get<Json[]>(`/api/issues/${this.record.issueId}/runs`, 5_000),
      ]);
      this.issue = issue;
      return { at: now, reachable: true, serverReady, issueStatus: String(issue.status),
        interruption: toInterruption(issue.interruption), activeRecoveryAction: Boolean(issue.activeRecoveryAction),
        recoveryOwner: issue.activeRecoveryAction?.ownerType ?? null,
        executionBlocker: Boolean(issue.executionBlocker), scheduledRetry: Boolean(issue.scheduledRetry),
        runs: await Promise.all((runs ?? []).map(toRunSample).map(run => this.runEvidence(run))) };
    } catch {
      return { at: now, reachable: false, serverReady: false };
    }
  }

  private async maybeStop(sample: TaskSample, now: number): Promise<boolean> {
    if (!this.definition.stopBeforeFollowUp || this.record.stop || this.plan.followUpAfterMs === null || !sample.serverReady) return false;
    if (now < this.record.createdAt! + this.plan.followUpAfterMs) return false;
    const running = (sample.runs ?? []).find(run => run.status === "running");
    if (!running) {
      if (!isResting(sample)) return false;
      this.record.stop = { at: now, runId: null, httpStatus: null, error: null, missed: true };
      this.timeline.add("task_stop_missed", { taskId: this.plan.taskId, status: sample.issueStatus ?? null });
      return true;
    }
    const stop: NonNullable<TaskRecord["stop"]> = { at: now, runId: running.id, httpStatus: null, error: null };
    try {
      await this.api.post(`/api/heartbeat-runs/${running.id}/cancel`, { cancellationRequestId: randomUUID() });
      stop.httpStatus = 200;
    } catch (error) {
      stop.httpStatus = error instanceof ChaosApiError ? error.status : null;
      stop.error = error instanceof Error ? error.message : String(error);
    }
    this.record.stop = stop;
    this.timeline.add("task_stop_clicked", { taskId: this.plan.taskId, ...stop });
    return true;
  }

  private async maybeFollowUp(sample: TaskSample, now: number): Promise<boolean> {
    const definition = this.definition;
    if (!definition.followUp || this.record.followUp || this.plan.followUpAfterMs === null || !sample.reachable) return false;
    if (now < this.record.createdAt! + this.plan.followUpAfterMs) return false;
    if (definition.stopBeforeFollowUp) {
      const stop = this.record.stop;
      if (!stop || now - stop.at < STOP_CONTINUE_AFTER_MS || this.supervisor.faultInProgress) return false;
      if ((sample.runs ?? []).some(run => run.status === "running" || run.status === "queued")) return false;
    }
    // C1 targets a live run (B8); wait for one unless the task already rests.
    const running = (sample.runs ?? []).some(run => run.status === "running");
    if (!running && !definition.stopBeforeFollowUp && !isResting(sample)) return false;
    const sentAt = Math.max(now, Date.now());
    try {
      const comment = await this.api.post<Json>(`/api/issues/${this.record.issueId}/comments`, { body: definition.followUp(this.plan.nonce) });
      this.record.followUp = { at: now, sentAt, postedAt: Math.max(now, Date.now()), commentId: comment?.id ?? null, error: null, duringRun: running };
    } catch (error) {
      this.record.followUp = { at: now, sentAt, commentId: null, error: error instanceof Error ? error.message : String(error), duringRun: running };
    }
    this.timeline.add("task_follow_up", { taskId: this.plan.taskId, ...this.record.followUp });
    return true;
  }

  private async onRest(sample: TaskSample, now: number) {
    const status = sample.issueStatus ?? null;
    // The board has not acted yet: the task waits on it, so it has not rested (and gets no Retry).
    if (this.awaitingBoard()) { this.restCandidateSince = null; return; }
    if (this.plan.workload === "H1") {
      const company = await this.api.get<Json>(`/api/companies/${this.lab.companyId}`, 5_000).catch(() => null);
      (this.record.governance ??= {}).companyActiveAtRest = company?.status === "active";
    }
    // C1: a follow-up posted after rest must be served before the task counts as resting.
    if (this.definition.followUp && !this.record.followUp) return;
    const faultSinceRetry = this.record.retry !== null && (this.record.lastFaultAt ?? 0) > this.record.retry.at;
    if (status !== "done" && this.definition.collect.childDocuments && this.record.issueId) {
      const children = await this.collectChildren(this.record.issueId).catch(() => null);
      const pending = childrenPending(children);
      const blocked = (children ?? []).filter(child => child.status === "blocked").map(child => child.id);
      if (!pending && blocked.length && this.childrenSettledAt === null) {
        this.timeline.add("task_child_blocked", { taskId: this.plan.taskId, childIssueIds: blocked });
      }
      this.childrenSettledAt = pending ? null : (this.childrenSettledAt ?? now);
      if (pending || now - this.childrenSettledAt! < CHILD_WAKE_GRACE_MS) {
        this.restCandidateSince = null;
        return;
      }
    }
    if (status !== "done" && (!this.record.retry || faultSinceRetry) && sample.interruption?.canRetry) {
      if (this.record.retry) (this.record.priorRetries ??= []).push(this.record.retry);
      this.record.retry = await this.retry(sample, now);
      this.restCandidateSince = null;
      if (this.record.retry.accepted && this.record.deadlineAt !== null) this.record.deadlineAt = Math.max(this.record.deadlineAt, now + RETRY_BUDGET_MS);
      return;
    }
    this.record.restAt = this.restCandidateSince ?? now;
    this.record.finalStatus = status;
    this.done = true;
    this.timeline.add("task_rested", { taskId: this.plan.taskId, status, interruption: sample.interruption?.state ?? null,
      canRetry: sample.interruption?.canRetry ?? false, retried: Boolean(this.record.retry) });
  }

  /** Exactly one click, with the same body ui/src/hooks/useTaskRetry.ts sends. */
  private async observeChildStalls(now: number): Promise<boolean> {
    if (this.plan.workload !== "M1" || !this.record.issueId) return false;
    if (this.childStallCheckedAt !== null && now - this.childStallCheckedAt < CHILD_STALL_CHECK_MS) return false;
    this.childStallCheckedAt = now;
    const rows = await this.api.get<Json[]>(`/api/companies/${this.lab.companyId}/issues?view=index&parentIds=${encodeURIComponent(this.record.issueId)}&limit=20`)
      .catch(() => null);
    const blocked = (Array.isArray(rows) ? rows : []).filter(row => row.parentId === this.record.issueId && row.status === "blocked").map(row => String(row.id));
    const parent = await this.api.get<Json>(`/api/issues/${this.record.issueId}`).catch(() => null);
    if (!parent) this.childStallCheckedAt = null;
    const stalled = Array.isArray(parent?.stalledDependencies) ? parent.stalledDependencies as Json[] : [];
    for (const dependency of stalled) {
      if (dependency.relation !== "child" || typeof dependency.stalledIssueId !== "string") continue;
      const action = (dependency.recoveryAction ?? null) as Json | null;
      const childIssueId = dependency.stalledIssueId;
      const recoveryActionId = typeof action?.id === "string" ? action.id : null;
      const stalls = this.record.childStalls ??= [];
      if (!stalls.some(stall => stall.childIssueId === childIssueId && stall.recoveryActionId === recoveryActionId)) {
        stalls.push({ childIssueId, recoveryActionId });
        this.timeline.add("task_child_stalled", { taskId: this.plan.taskId, childIssueId, recoveryActionId });
      }
    }
    return this.retryBlockedChildren(blocked, now);
  }

  private stopArtifacts(stop: NonNullable<TaskRecord["stop"]>): NonNullable<OracleArtifacts["stop"]> {
    const runs = new Map<string, NonNullable<TaskSample["runs"]>[number]>();
    for (const sample of this.record.samples) for (const run of sample.runs ?? []) runs.set(run.id, run);
    const continueAt = this.record.followUp?.sentAt ?? this.record.followUp?.at ?? null;
    const continueCommentId = this.record.followUp?.commentId ?? null;
    const startedBeforeContinue = [...runs.values()].filter(run => run.id !== stop.runId && run.createdAt
      && !(continueCommentId && (run.wakeCommentIds ?? []).includes(continueCommentId))
      && Date.parse(run.createdAt) > stop.at && (continueAt === null || Date.parse(run.createdAt) < continueAt)).map(run => run.id);
    return { runId: stop.runId, runStatus: stop.runId ? runs.get(stop.runId)?.status ?? null : null, runsStartedBeforeContinue: startedBeforeContinue,
      continuePosted: Boolean(this.record.followUp?.commentId), ...(stop.missed ? { missed: true } : {}) };
  }

  private async retryBlockedChildren(childIds: readonly string[], now: number): Promise<boolean> {
    let clicked = false;
    for (const childIssueId of childIds) {
      if ((this.record.childRetries ?? []).some(attempt => attempt.childIssueId === childIssueId && attempt.accepted)) continue;
      const child = await this.api.get<Json>(`/api/issues/${childIssueId}`).catch(() => null);
      const interruption = child?.interruption as Json | null | undefined;
      if (interruption?.canRetry !== true) continue;
      const observedRunId = typeof interruption.observedRunId === "string" ? interruption.observedRunId : null;
      const childRef = typeof child?.identifier === "string" ? child.identifier : childIssueId;
      const attempt: RetryAttempt & { childIssueId: string } = { childIssueId, ...await this.clickRetry(childRef, childIssueId, observedRunId, now) };
      (this.record.childRetries ??= []).push(attempt);
      this.timeline.add("task_child_retry_clicked", { taskId: this.plan.taskId, ...attempt });
      clicked = clicked || attempt.accepted === true;
    }
    return clicked;
  }

  private async collectStallWakes(issueId: string): Promise<NonNullable<OracleArtifacts["stallWakes"]>> {
    const rows = await this.api.get<Json[]>(`/api/issues/${issueId}/activity`).catch(() => []);
    return (rows ?? []).filter(row => row.action === "issue.blocker_stalled_wake").map(row => {
      const details = (row.details ?? {}) as Json;
      return { stalledIssueId: typeof details.stalledIssueId === "string" ? details.stalledIssueId : null,
        recoveryActionId: typeof details.recoveryActionId === "string" ? details.recoveryActionId : null };
    });
  }

  private async retry(sample: TaskSample, now: number): Promise<RetryAttempt> {
    const observedRunId = sample.interruption?.observedRunId ?? (this.issue?.executionBlocker?.runId as string | undefined) ?? null;
    const attempt = await this.clickRetry(this.record.identifier ?? this.record.issueId!, this.record.issueId!, observedRunId, now);
    this.timeline.add("task_retry_clicked", { taskId: this.plan.taskId, ...attempt });
    return attempt;
  }

  private async clickRetry(issueRef: string, issueId: string, observedRunId: string | null, now: number): Promise<RetryAttempt> {
    const attempt: RetryAttempt = { at: now, observedRunId, httpStatus: null, accepted: null, error: null };
    if (this.board) {
      const click = await this.board.clickRetry(issueRef, issueId);
      Object.assign(attempt, { via: "ui", httpStatus: click.httpStatus, accepted: click.accepted, error: click.error, bannerText: click.bannerText });
      if (click.accepted) attempt.acceptedAt = Math.max(now, Date.now());
      return attempt;
    }
    attempt.via = "api";
    try {
      const result = await this.api.post<{ accepted?: boolean }>(`/api/issues/${issueId}/retry`, { idempotencyKey: randomUUID(), observedRunId });
      attempt.httpStatus = 200;
      attempt.accepted = result?.accepted === true;
      attempt.acceptedAt = Math.max(now, Date.now());
    } catch (error) {
      attempt.httpStatus = error instanceof ChaosApiError ? error.status : null;
      attempt.error = error instanceof Error ? error.message : String(error);
    }
    return attempt;
  }

  private async remoteWorkspaceFile(issueId: string, relative: string): Promise<string | null> {
    const captured = this.record.remoteFiles?.[relative];
    const text = typeof captured === "string" ? captured
      : await readRemoteWorkspaceFile(this.api, issueId, relative, { onError: message => this.noteRemoteFileError(relative, message) });
    if (text !== null) delete this.record.remoteFileErrors?.[relative];
    return text;
  }

  private async captureRemoteFilesAtDone(sample: TaskSample): Promise<void> {
    const wanted = this.definition.collect.files(this.plan.nonce);
    if (!wanted.length || this.lab.environmentKind === "local" || sample.issueStatus !== "done" || !this.record.issueId) return;
    await captureRemoteWorkspaceFiles(this.api, this.record.issueId, wanted, this.record.remoteFiles ??= {},
      (relative, message) => this.noteRemoteFileError(relative, message));
  }

  private noteRemoteFileError(relative: string, message: string): void {
    const errors = this.record.remoteFileErrors ??= {};
    if (errors[relative] === message) return;
    errors[relative] = message;
    this.timeline.add("remote_file_read_failed", { taskId: this.plan.taskId, path: relative, error: message });
  }

  async workspacePath(): Promise<string | null> {
    if (!this.definition.usesRepository) return null;
    const current = this.issue?.currentExecutionWorkspace as Json | null | undefined;
    if (typeof current?.cwd === "string") return current.cwd;
    const workspaceId = this.issue?.executionWorkspaceId;
    if (typeof workspaceId === "string") {
      const workspace = await this.api.get<Json>(`/api/execution-workspaces/${workspaceId}`).catch(() => null);
      if (typeof workspace?.cwd === "string") return workspace.cwd;
    }
    return null;
  }

  workloadAgents(): WorkloadAgents {
    const self = this.lab.agents[this.plan.adapter];
    const other = Object.values(this.lab.agents).find(agent => agent.id !== self.id) ?? self;
    return { self, other, companyId: this.lab.companyId };
  }

  /** G1 before the board's decision, or H1 while its company is paused and not yet resumed. */
  private awaitingBoard(): boolean {
    const governance = this.record.governance;
    if (this.journey) return this.journey.awaitingBoard();
    if (this.plan.workload === "G1") return Boolean(governance?.approvalSeenAt) && !governance?.decision;
    if (this.plan.workload === "H1") return Boolean(governance?.budgetPausedAt) && !governance?.resume && !governance?.pauseLostAt;
    if (this.plan.workload === "Q1") return awaitingQuestionAnswer(this.record);
    return false;
  }

  /** The board acts only after every fault this task planned has fired (or was missed), with the server ready. */
  private boardMayAct(sample: TaskSample, waitsForThisAction?: TriggerId): boolean {
    return sample.reachable && sample.serverReady && !this.supervisor.faultInProgress
      && this.pendingFaults.every(fault => waitsForThisAction !== undefined && fault.trigger === waitsForThisAction);
  }

  /**
   * H1: set the company budget to its observed spend plus one cent through the board's budget
   * route, so the task's first priced usage crosses the hard stop mid-run.
   */
  private async lowerBudgetToSpend(): Promise<void> {
    const governance = this.record.governance ??= {};
    try {
      const overview = await this.api.get<Json>(`/api/companies/${this.lab.companyId}/budgets/overview`, 10_000);
      const policy = ((overview?.policies ?? []) as Json[]).find(row => row.scopeType === "company");
      const observed = typeof policy?.observedAmount === "number" ? policy.observedAmount : 0;
      // The budget routes take whole cents; observed spend can be fractional.
      governance.budgetSetCents = Math.ceil(observed) + 1;
      await this.api.patch(`/api/companies/${this.lab.companyId}/budgets`, { budgetMonthlyCents: governance.budgetSetCents });
      this.timeline.add("governance_budget_set", { taskId: this.plan.taskId, budgetCents: governance.budgetSetCents, observedCents: observed });
    } catch (error) {
      governance.budgetSetError = error instanceof Error ? error.message : String(error);
      this.timeline.add("governance_budget_set_failed", { taskId: this.plan.taskId, error: governance.budgetSetError });
    }
  }

  /** G1 and H1: what the board sees and does, through the same routes the board UI uses. */
  private async governanceStep(sample: TaskSample, now: number): Promise<void> {
    if (!sample.reachable || !this.record.issueId) return;
    if (this.plan.workload === "G1") await this.approvalStep(sample, now);
    if (this.plan.workload === "H1") await this.budgetStep(sample, now);
    if (this.plan.workload === "Q1") {
      await questionStep({ api: this.api, issueId: this.record.issueId, nonce: this.plan.nonce, record: this.record, sample, now,
        // An `answered` fault waits for the answer, so the board may answer before it fires.
        boardMayAct: this.boardMayAct(sample, "answered"), note: (kind, data) => this.timeline.add(kind, { taskId: this.plan.taskId, ...data }) });
    }
  }

  private async approvalStep(sample: TaskSample, now: number): Promise<void> {
    const governance = this.record.governance ??= {};
    if (governance.decision) return;
    const approvals = await this.api.get<Json[]>(`/api/issues/${this.record.issueId}/approvals`, 5_000).catch(() => null);
    const pending = (approvals ?? []).find(approval => approval.status === "pending" && approvalTitleMatches(approval, this.plan.nonce));
    if (!pending) return;
    if (governance.approvalSeenAt == null) {
      governance.approvalSeenAt = now;
      governance.approvalId = String(pending.id);
      this.timeline.add("governance_approval_pending", { taskId: this.plan.taskId, approvalId: pending.id });
    }
    if (!this.boardMayAct(sample)) return;
    // The gated action must not exist before the board decides.
    const before = await this.collectChildren(this.record.issueId!).catch(() => null);
    governance.childrenBeforeDecision = before === null ? null
      : before.filter(child => (child.title ?? "").includes(g1ChildTitle(this.plan.nonce))).length;
    const kind = g1Decision(this.plan.nonce);
    const decision: NonNullable<GovernanceRecord["decision"]> = { kind, at: now, httpStatus: null, error: null,
      pendingWhenDecided: true, afterFault: (this.record.lastFaultAt ?? 0) > governance.approvalSeenAt };
    try {
      await this.api.post(`/api/approvals/${pending.id}/${kind}`, { decisionNote: DECISION_NOTE });
      // A rejected request also closes the task: the board cancels it.
      if (kind === "reject") await this.api.patch(`/api/issues/${this.record.issueId}`, { status: "cancelled" });
      decision.httpStatus = 200;
    } catch (error) {
      decision.httpStatus = error instanceof ChaosApiError ? error.status : null;
      decision.error = error instanceof Error ? error.message : String(error);
    }
    governance.decision = decision;
    this.restCandidateSince = null;
    this.timeline.add("governance_approval_decided", { taskId: this.plan.taskId, approvalId: pending.id, ...decision });
  }

  private async budgetStep(sample: TaskSample, now: number): Promise<void> {
    const governance = this.record.governance ??= {};
    if (governance.resume) return;
    const company = await this.api.get<Json>(`/api/companies/${this.lab.companyId}`, 5_000).catch(() => null);
    if (!company) return;
    const paused = company.status === "paused" && company.pauseReason === "budget";
    // A pause must hold until the board resumes it: one that clears on its own (a restart lost it)
    // is recorded, and the board does not resume what is no longer paused.
    if (!paused && governance.budgetPausedAt != null) {
      governance.pauseLostAt ??= now;
      this.timeline.add("governance_budget_pause_lost", { taskId: this.plan.taskId, status: company.status ?? null,
        pauseReason: company.pauseReason ?? null });
      return;
    }
    if (paused && governance.budgetPausedAt == null) {
      const recorded = typeof company.pausedAt === "string" ? Date.parse(company.pausedAt) : Number.NaN;
      governance.budgetPausedAt = Number.isFinite(recorded) ? Math.min(recorded, now) : now;
      this.timeline.add("governance_budget_paused", { taskId: this.plan.taskId, pausedAt: company.pausedAt ?? null });
    }
    if (governance.budgetPausedAt == null || !this.boardMayAct(sample)) return;
    if (this.readySince === null || now - this.readySince < BUDGET_PAUSE_HOLD_MS || now - governance.budgetPausedAt < BUDGET_PAUSE_HOLD_MS) return;
    // While paused nothing may start: every run that started after the pause is a violation.
    governance.runsStartedWhilePaused = runsStartedAfter(this.record.samples, governance.budgetPausedAt);
    const resume: NonNullable<GovernanceRecord["resume"]> = { at: now, amount: null, incidentId: null, httpStatus: null, error: null,
      afterFault: (this.record.lastFaultAt ?? 0) > governance.budgetPausedAt };
    try {
      const overview = await this.api.get<Json>(`/api/companies/${this.lab.companyId}/budgets/overview`, 10_000);
      const incident = ((overview?.activeIncidents ?? []) as Json[]).find(row => row.scopeType === "company");
      if (!incident) throw new Error("no active company budget incident to resolve");
      const policy = ((overview?.policies ?? []) as Json[]).find(row => row.scopeType === "company");
      const observed = Math.max(Number(incident.amountObserved) || 0, Number(policy?.observedAmount) || 0);
      resume.incidentId = String(incident.id);
      resume.amount = Math.ceil(observed) + BUDGET_RESUME_HEADROOM_CENTS;
      await this.api.post(`/api/companies/${this.lab.companyId}/budget-incidents/${incident.id}/resolve`,
        { action: "raise_budget_and_resume", amount: resume.amount, decisionNote: DECISION_NOTE });
      resume.httpStatus = 200;
    } catch (error) {
      resume.httpStatus = error instanceof ChaosApiError ? error.status : null;
      resume.error = error instanceof Error ? error.message : String(error);
    }
    // Never before the poll that decided to resume (the pause window cannot end before it starts).
    resume.doneAt = Math.max(Date.now(), now);
    governance.resume = resume;
    this.restCandidateSince = null;
    this.timeline.add("governance_budget_resumed", { taskId: this.plan.taskId, ...resume,
      runsStartedWhilePaused: governance.runsStartedWhilePaused });
  }

  async childSpeedTasks(): Promise<ChildSpeedTask[]> {
    if (!this.definition.collect.childDocuments || !this.record.issueId) return [];
    const rows = await this.api.get<Json[]>(`/api/companies/${this.lab.companyId}/issues?view=index&parentIds=${encodeURIComponent(this.record.issueId)}&limit=20`);
    const tasks: Array<{ issueId: string; adapter: AdapterId; samples: Array<{ runs?: RunSample[] }> }> = [];
    for (const row of (rows ?? []).filter(child => child.parentId === this.record.issueId)) {
      const adapter = (Object.entries(this.lab.agents) as Array<[AdapterId, { id: string }]>)
        .find(([, agent]) => agent.id === row.assigneeAgentId)?.[0];
      if (!adapter) continue;
      const runs = await this.api.get<Json[]>(`/api/issues/${row.id}/runs`, 15_000);
      tasks.push({ issueId: String(row.id), adapter, samples: [{ runs: (runs ?? []).map(toRunSample) }] });
    }
    return tasks;
  }

  async collectChildren(issueId: string): Promise<NonNullable<OracleArtifacts["children"]>> {
    const keys = this.definition.collect.childDocuments;
    if (!keys) return [];
    const rows = await this.api.get<Json[]>(`/api/companies/${this.lab.companyId}/issues?view=index&parentIds=${encodeURIComponent(issueId)}&limit=20`)
      .catch(() => []);
    const children: NonNullable<OracleArtifacts["children"]> = [];
    for (const row of (rows ?? []).filter(child => child.parentId === issueId)) {
      const documents: Record<string, string | null> = {};
      for (const key of keys) {
        const document = await this.api.get<Json>(`/api/issues/${row.id}/documents/${key}`).catch(() => null);
        documents[key] = typeof document?.body === "string" ? document.body : null;
      }
      children.push({ id: String(row.id), title: typeof row.title === "string" ? row.title : null,
        status: typeof row.status === "string" ? row.status : null,
        assigneeAgentId: typeof row.assigneeAgentId === "string" ? row.assigneeAgentId : null, documents });
    }
    return children;
  }

  async collectArtifacts(): Promise<OracleArtifacts> {
    const definition = this.definition;
    const issueId = this.record.issueId!;
    const issue = await this.api.get<Json>(`/api/issues/${issueId}`).catch(() => this.issue);
    if (issue) this.issue = issue;
    const documents: Record<string, string | null> = {};
    for (const key of definition.collect.documents) {
      const document = await this.api.get<Json>(`/api/issues/${issueId}/documents/${key}`).catch(() => null);
      documents[key] = typeof document?.body === "string" ? document.body : null;
    }
    const comments = await this.api.get<Json[]>(`/api/issues/${issueId}/comments`).catch(() => []);
    const workspacePath = await this.workspacePath();
    const snapshotPath = this.record.preFaultWorkspacePath ?? workspacePath;
    if (snapshotPath && this.record.preFaultFiles) {
      if (workspacePath && snapshotPath !== workspacePath) this.record.workspaceMovedTo = workspacePath;
      try {
        const present = new Set(await listWorkspaceFiles(snapshotPath));
        this.record.lostFiles = this.record.preFaultFiles.filter(file => !present.has(file));
      } catch (error) {
        this.record.restSnapshotError = error instanceof Error ? error.message : String(error);
      }
    }
    const files: Record<string, string | null> = {};
    const commands: OracleArtifacts["commands"] = {};
    const runCommands = async (cwd: string) => {
      for (const command of definition.collect.commands) {
        const argv = typeof command.argv === "function" ? command.argv(this.plan.nonce) : command.argv;
        commands[command.name] = await runOracleCommand(argv, cwd, { protectedRoots: this.protectedRoots,
          readableFiles: argv[0] === process.execPath ? [process.execPath] : [] });
      }
    };
    const wanted = definition.collect.files(this.plan.nonce);
    if (workspacePath && await access(workspacePath).then(() => true, () => false)) {
      for (const relative of wanted) files[relative] = await readFile(path.join(workspacePath, relative), "utf8").catch(() => null);
      await runCommands(workspacePath);
    } else if (workspacePath && wanted.length) {
      const staged = await mkdtemp(path.join(os.tmpdir(), "restart-chaos-oracle-"));
      try {
        for (const relative of wanted) {
          files[relative] = await this.remoteWorkspaceFile(issueId, relative);
          if (files[relative] === null) continue;
          await mkdir(path.dirname(path.join(staged, relative)), { recursive: true });
          await writeFile(path.join(staged, relative), files[relative]!);
        }
        await runCommands(staged);
      } finally {
        await rm(staged, { recursive: true, force: true });
      }
    }
    return {
      issueStatus: issue?.status ?? this.record.finalStatus,
      documents,
      agentComments: (comments ?? []).filter(comment => comment.authorAgentId).map(comment => String(comment.body ?? "")),
      files, commands, workspacePath,
      ...(this.plan.workload === "B5" ? { benchProgressObserved: this.record.benchProgressSeen?.length ?? 0 } : {}),
      ...(this.record.stop ? { stop: this.stopArtifacts(this.record.stop) } : {}),
      ...(definition.collect.childDocuments ? { children: await this.collectChildren(issueId),
        childStalls: this.record.childStalls ?? [], stallWakes: await this.collectStallWakes(issueId) } : {}),
      ...(this.plan.workload === "G1" ? { approvals: await this.collectApprovals(issueId) } : {}),
      ...(this.plan.workload === "H1" ? await this.finalPauseCheck(issueId) : {}),
      ...(this.record.governance ? { governance: this.record.governance } : {}),
      ...(this.plan.workload === "Q1" ? { question: await collectQuestionArtifacts(this.api, issueId, this.record) } : {}),
      ...(this.journey ? { journey: await this.journey.collect(issueId).finally(() => this.journey!.close()) } : {}),
    };
  }

  /**
   * H1: the pause window ends when the resume request returned, after the last poll before it. Read
   * the task's whole run history again, so a run that started in that gap is still caught.
   */
  private async finalPauseCheck(issueId: string): Promise<Record<string, never>> {
    const governance = this.record.governance;
    if (!governance?.budgetPausedAt) return {};
    const runs = await this.api.get<Json[]>(`/api/issues/${issueId}/runs`).then(rows => (rows ?? []).map(toRunSample)).catch(() => []);
    const history: TaskSample[] = [...this.record.samples, { at: Date.now(), reachable: true, serverReady: true, runs }];
    governance.runsStartedWhilePaused = runsStartedAfter(history, governance.budgetPausedAt,
      governance.resume?.doneAt ?? Number.POSITIVE_INFINITY);
    return {};
  }

  /** G1: every approval linked to the task, whatever its status. */
  private async collectApprovals(issueId: string): Promise<NonNullable<OracleArtifacts["approvals"]>> {
    const rows = await this.api.get<Json[]>(`/api/issues/${issueId}/approvals`).catch(() => []);
    return (rows ?? []).map(row => ({ id: String(row.id), status: String(row.status),
      title: typeof row.payload?.title === "string" ? row.payload.title : null }));
  }

  /** R6 sweep: nothing still pending once the wave is quiet. */
  async sweep(): Promise<RestSweep> {
    this.closeUnfiredTriggers();
    if (!this.record.issueId) return { activeRuns: [], runningWorkspaceOperations: [], activeRecoveryAction: false, error: null };
    try {
      const [issue, runs] = await Promise.all([
        this.api.get<Json>(`/api/issues/${this.record.issueId}`),
        this.api.get<Json[]>(`/api/issues/${this.record.issueId}/runs`),
      ]);
      const samples = runs.map(toRunSample);
      const operations: string[] = [];
      for (const run of samples) {
        // A failed read must not look like a clean rest: let it reach sweep.error.
        const rows = await this.api.get<Json[]>(`/api/heartbeat-runs/${run.id}/workspace-operations`);
        for (const row of rows ?? []) if (row.status === "running") operations.push(String(row.id));
      }
      return { activeRuns: samples.filter(run => ACTIVE_RUN_STATUSES.has(run.status)).map(run => run.id),
        runningWorkspaceOperations: operations, activeRecoveryAction: Boolean(issue.activeRecoveryAction), error: null };
    } catch (error) {
      return { activeRuns: [], runningWorkspaceOperations: [], activeRecoveryAction: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
