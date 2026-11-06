import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ChaosApiError, type ChaosApi } from "./api.js";
import { ACTIVE_RUN_STATUSES } from "./grader.js";
import type { ChaosLab } from "./seed.js";
import type { Timeline } from "./timeline.js";
import type {
  InterruptionSample, OracleArtifacts, RestSweep, RetryAttempt, RunSample, TaskPlan, TaskRecord, TaskSample,
} from "./types.js";
import { workloadDefinitions } from "./workloads.js";

const execFileAsync = promisify(execFile);
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
  };
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
  return true;
}

export class TaskObserver {
  readonly record: TaskRecord;
  issue: Json | null = null;
  private restCandidateSince: number | null = null;
  private faultRequested = false;
  done = false;

  constructor(readonly plan: TaskPlan, private readonly api: ChaosApi, private readonly lab: ChaosLab,
    private readonly timeline: Timeline, private readonly supervisor: { serverReady: boolean; faultInProgress: boolean }) {
    this.record = { plan, issueId: null, identifier: null, createdAt: null, launchError: null, samples: [], retry: null,
      restAt: null, finalStatus: null, deadlineAt: null, timedOut: false, followUp: null, faultIds: [], sweep: null };
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
        workload: this.plan.workload, adapter: this.plan.adapter, fault: this.plan.fault, fireAfterMs: this.plan.fireAfterMs });
    } catch (error) {
      this.record.launchError = error instanceof Error ? error.message : String(error);
      this.done = true;
      this.timeline.add("task_launch_failed", { taskId: this.plan.taskId, error: this.record.launchError });
    }
  }

  /** True once the planned fault is due and the task has not rested yet. */
  faultDue(now: number): boolean {
    if (this.faultRequested || this.done || this.record.createdAt === null) return false;
    if (now < this.record.createdAt + this.plan.fireAfterMs) return false;
    this.faultRequested = true;
    if (this.record.restAt !== null) {
      this.timeline.add("fault_skipped_task_resting", { taskId: this.plan.taskId, fault: this.plan.fault });
      return false;
    }
    return true;
  }

  noteFault(faultId: string) { if (!this.record.faultIds.includes(faultId)) this.record.faultIds.push(faultId); }

  /** Outages extend the deadline: R1 allows budget plus outage time. */
  extendDeadline(ms: number) { if (this.record.deadlineAt !== null) this.record.deadlineAt += ms; }

  async poll(now = Date.now()): Promise<void> {
    if (this.done || !this.record.issueId) return;
    const sample = await this.sample(now);
    this.record.samples.push(sample);
    await this.maybeFollowUp(sample, now);
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
        runs: (runs ?? []).map(toRunSample) };
    } catch {
      return { at: now, reachable: false, serverReady: false };
    }
  }

  private async maybeFollowUp(sample: TaskSample, now: number) {
    const definition = this.definition;
    if (!definition.followUp || this.record.followUp || this.plan.followUpAfterMs === null || !sample.reachable) return;
    if (now < this.record.createdAt! + this.plan.followUpAfterMs) return;
    // C1 targets a live run (B8); wait for one unless the task already rests.
    const running = (sample.runs ?? []).some(run => run.status === "running");
    if (!running && !isResting(sample)) return;
    try {
      const comment = await this.api.post<Json>(`/api/issues/${this.record.issueId}/comments`, { body: definition.followUp(this.plan.nonce) });
      this.record.followUp = { at: now, commentId: comment?.id ?? null, error: null };
    } catch (error) {
      this.record.followUp = { at: now, commentId: null, error: error instanceof Error ? error.message : String(error) };
    }
    this.timeline.add("task_follow_up", { taskId: this.plan.taskId, duringRun: running, ...this.record.followUp });
  }

  private async onRest(sample: TaskSample, now: number) {
    const status = sample.issueStatus ?? null;
    // C1: a follow-up posted after rest must be served before the task counts as resting.
    if (this.definition.followUp && !this.record.followUp) return;
    if (status !== "done" && !this.record.retry && sample.interruption?.canRetry) {
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
    const files: Record<string, string | null> = {};
    const commands: OracleArtifacts["commands"] = {};
    if (workspacePath) {
      for (const relative of definition.collect.files(this.plan.nonce)) {
        files[relative] = await readFile(path.join(workspacePath, relative), "utf8").catch(() => null);
      }
      for (const command of definition.collect.commands) {
        try {
          const { stdout, stderr } = await execFileAsync(command.argv[0]!, command.argv.slice(1), { cwd: workspacePath, timeout: 60_000,
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", PYTHONDONTWRITEBYTECODE: "1" } });
          commands[command.name] = { exitCode: 0, stdout, stderr: stderr.slice(-4_000) };
        } catch (error) {
          const failure = error as { code?: number; stdout?: string; stderr?: string };
          commands[command.name] = { exitCode: typeof failure.code === "number" ? failure.code : null,
            stdout: failure.stdout ?? "", stderr: (failure.stderr ?? String(error)).slice(-4_000) };
        }
      }
    }
    return {
      issueStatus: issue?.status ?? this.record.finalStatus,
      documents,
      agentComments: (comments ?? []).filter(comment => comment.authorAgentId).map(comment => String(comment.body ?? "")),
      files, commands, workspacePath,
    };
  }

  /** R6 sweep: nothing still pending once the wave is quiet. */
  async sweep(): Promise<RestSweep> {
    if (!this.record.issueId) return { activeRuns: [], runningWorkspaceOperations: [], activeRecoveryAction: false, error: null };
    try {
      const [issue, runs] = await Promise.all([
        this.api.get<Json>(`/api/issues/${this.record.issueId}`),
        this.api.get<Json[]>(`/api/issues/${this.record.issueId}/runs`),
      ]);
      const samples = runs.map(toRunSample);
      const operations: string[] = [];
      for (const run of samples) {
        const rows = await this.api.get<Json[]>(`/api/heartbeat-runs/${run.id}/workspace-operations`).catch(() => []);
        for (const row of rows ?? []) if (row.status === "running") operations.push(String(row.id));
      }
      return { activeRuns: samples.filter(run => ACTIVE_RUN_STATUSES.has(run.status)).map(run => run.id),
        runningWorkspaceOperations: operations, activeRecoveryAction: Boolean(issue.activeRecoveryAction), error: null };
    } catch (error) {
      return { activeRuns: [], runningWorkspaceOperations: [], activeRecoveryAction: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
