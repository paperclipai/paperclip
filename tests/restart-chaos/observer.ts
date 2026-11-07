import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChaosApiError, type ChaosApi } from "./api.js";
import { ACTIVE_RUN_STATUSES, isStalledSample, STALL_LIMIT_MS } from "./grader.js";
import type { ChaosLab } from "./seed.js";
import type { Timeline } from "./timeline.js";
import type {
  InterruptionSample, OracleArtifacts, RestSweep, RetryAttempt, RunSample, ScheduledFault, TaskPlan, TaskRecord, TaskSample,
} from "./types.js";
import { runOracleCommand } from "./oracle-sandbox.js";
import { taskFaultSchedule } from "./scheduler.js";
import { workloadDefinitions } from "./workloads.js";

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
/** Extra time granted after a Retry click before R3 is graded as timed out. */
export const RETRY_BUDGET_MS = 15 * 60_000;

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

export function latestIso(values: ReadonlyArray<unknown>): string | null {
  let best: number | null = null;
  for (const value of values) {
    const at = typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(at) && (best === null || at > best)) best = at;
  }
  return best === null ? null : new Date(best).toISOString();
}

export const RUN_EVENT_PAGE = 500;

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
  private stallSince: number | null = null;
  private readonly faultSchedule: ScheduledFault[];
  private readonly pendingFaults: ScheduledFault[];
  done = false;

  constructor(readonly plan: TaskPlan, private readonly api: ChaosApi, private readonly lab: ChaosLab,
    private readonly timeline: Timeline, private readonly supervisor: { serverReady: boolean; faultInProgress: boolean },
    /** Paths oracle commands may not read: the operator's home, the instance root (secrets key, database) and results. */
    private readonly protectedRoots: readonly string[] = [os.homedir()]) {
    this.record = { plan, issueId: null, identifier: null, createdAt: null, launchError: null, samples: [], retry: null,
      restAt: null, finalStatus: null, deadlineAt: null, timedOut: false, followUp: null, faultIds: [], sweep: null,
      preFaultFiles: null, lostFiles: null };
    this.faultSchedule = taskFaultSchedule(plan);
    this.pendingFaults = [...this.faultSchedule];
  }

  get definition() { return workloadDefinitions[this.plan.workload]; }

  async launch(): Promise<void> {
    const definition = this.definition;
    try {
      const issue = await this.api.post<Json>(`/api/companies/${this.lab.companyId}/issues`, {
        title: definition.title(this.plan.nonce),
        description: definition.description(this.plan.nonce),
        status: "todo",
        priority: "medium",
        assigneeAgentId: this.lab.agents[this.plan.adapter].id,
        ...(definition.usesRepository ? { projectId: this.lab.projectId } : {}),
      });
      this.record.issueId = String(issue.id);
      this.record.identifier = issue.identifier ?? null;
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
      if (workspace) { this.record.preFaultFiles = await listWorkspaceFiles(workspace); this.record.preFaultWorkspacePath = workspace; }
    } catch (error) {
      this.record.preFaultSnapshotError = error instanceof Error ? error.message : String(error);
      this.timeline.add("pre_fault_snapshot_failed", { taskId: this.plan.taskId, error: this.record.preFaultSnapshotError });
    }
  }

  noteFault(faultId: string, startedAt?: number) {
    if (!this.record.faultIds.includes(faultId)) this.record.faultIds.push(faultId);
    if (startedAt !== undefined) this.record.lastFaultAt = Math.max(this.record.lastFaultAt ?? 0, startedAt);
  }

  /** Outages extend the deadline: R1 allows budget plus outage time. */
  extendDeadline(ms: number) { if (this.record.deadlineAt !== null) this.record.deadlineAt += ms; }

  async poll(now = Date.now()): Promise<void> {
    if (this.done || !this.record.issueId) return;
    const sample = await this.sample(now);
    this.record.samples.push(sample);
    await this.observeBenchProgress();
    if (await this.maybeFollowUp(sample, now)) {
      // The comment response is not the agent's answer: require fresh samples.
      this.restCandidateSince = null;
      return;
    }
    this.stallSince = isStalledSample(sample) ? (this.stallSince ?? now) : null;
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
        return;
      }
    }
    if (this.record.deadlineAt !== null && now > this.record.deadlineAt && !this.supervisor.faultInProgress) {
      this.record.timedOut = true;
      this.record.finalStatus = sample.issueStatus ?? this.record.finalStatus;
      this.done = true;
      this.timeline.add("task_timed_out", { taskId: this.plan.taskId, status: sample.issueStatus });
    }
  }

  private readonly runEventCursors = new Map<string, { seq: number; lastAt: string | null }>();

  private async runEvidence(run: RunSample): Promise<RunSample> {
    if (run.status !== "running") return run;
    const cursor = this.runEventCursors.get(run.id) ?? { seq: 0, lastAt: null };
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
      }
      if (events.length < RUN_EVENT_PAGE) break;
    }
    this.runEventCursors.set(run.id, cursor);
    return { ...run, lastEvidenceAt: latestIso([run.lastEvidenceAt, cursor.lastAt]) };
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

  private async maybeFollowUp(sample: TaskSample, now: number): Promise<boolean> {
    const definition = this.definition;
    if (!definition.followUp || this.record.followUp || this.plan.followUpAfterMs === null || !sample.reachable) return false;
    if (now < this.record.createdAt! + this.plan.followUpAfterMs) return false;
    // C1 targets a live run (B8); wait for one unless the task already rests.
    const running = (sample.runs ?? []).some(run => run.status === "running");
    if (!running && !isResting(sample)) return false;
    try {
      const comment = await this.api.post<Json>(`/api/issues/${this.record.issueId}/comments`, { body: definition.followUp(this.plan.nonce) });
      this.record.followUp = { at: now, postedAt: Math.max(now, Date.now()), commentId: comment?.id ?? null, error: null, duringRun: running };
    } catch (error) {
      this.record.followUp = { at: now, commentId: null, error: error instanceof Error ? error.message : String(error), duringRun: running };
    }
    this.timeline.add("task_follow_up", { taskId: this.plan.taskId, ...this.record.followUp });
    return true;
  }

  private async onRest(sample: TaskSample, now: number) {
    const status = sample.issueStatus ?? null;
    // C1: a follow-up posted after rest must be served before the task counts as resting.
    if (this.definition.followUp && !this.record.followUp) return;
    const faultSinceRetry = this.record.retry !== null && (this.record.lastFaultAt ?? 0) > this.record.retry.at;
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
  private async retry(sample: TaskSample, now: number): Promise<RetryAttempt> {
    const observedRunId = sample.interruption?.observedRunId ?? (this.issue?.executionBlocker?.runId as string | undefined) ?? null;
    const attempt: RetryAttempt = { at: now, observedRunId, httpStatus: null, accepted: null, error: null };
    try {
      const result = await this.api.post<{ accepted?: boolean }>(`/api/issues/${this.record.issueId}/retry`,
        { idempotencyKey: randomUUID(), observedRunId });
      attempt.httpStatus = 200;
      attempt.accepted = result?.accepted === true;
      attempt.acceptedAt = Math.max(now, Date.now());
    } catch (error) {
      attempt.httpStatus = error instanceof ChaosApiError ? error.status : null;
      attempt.error = error instanceof Error ? error.message : String(error);
    }
    this.timeline.add("task_retry_clicked", { taskId: this.plan.taskId, ...attempt });
    return attempt;
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
    if (workspacePath) {
      for (const relative of definition.collect.files(this.plan.nonce)) {
        files[relative] = await readFile(path.join(workspacePath, relative), "utf8").catch(() => null);
      }
      // Agent-editable code: run it sandboxed, away from the operator's home directory.
      for (const command of definition.collect.commands) commands[command.name] = await runOracleCommand(command.argv, workspacePath, { protectedRoots: this.protectedRoots });
    }
    return {
      issueStatus: issue?.status ?? this.record.finalStatus,
      documents,
      agentComments: (comments ?? []).filter(comment => comment.authorAgentId).map(comment => String(comment.body ?? "")),
      files, commands, workspacePath,
      ...(this.plan.workload === "B5" ? { benchProgressObserved: this.record.benchProgressSeen?.length ?? 0 } : {}),
    };
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
