import { randomUUID } from "node:crypto";
import { createRng } from "./plan-primitives.js";import type { HostedApi } from "./hosted-api.js";
import type { HostedOptions } from "./hosted-config.js";
import { taskTag } from "./hosted-setup.js";
import { hostedIssues } from "./hosted-readers.js";
import type { RetryClick } from "./release-swap-grade.js";
import { assignAdapters, followUpComment, followUpRequestId, roundsFor, ROUND_SECONDS, stagingMixDescription, SUBTASKS_PER_PARENT, type StagingMixTask } from "./staging-mix.js";
import type { AdapterId } from "./types.js";

type Json = Record<string, any>;
export type WorkloadApi = Pick<HostedApi, "get" | "post">;

export interface HostedTaskPlan {
  index: number;
  adapter: AdapterId;
  nonce: string;
  task: StagingMixTask;
}

export interface RetryBanner {
  firstShownAt: number;
  shown: boolean;
  clearedAt: number | null;
  clearedByItself: boolean;
}

export function trackBanner(banner: RetryBanner | null, offered: boolean, now: number): { banner: RetryBanner | null; cleared: boolean } {
  if (offered && !banner) return { banner: { firstShownAt: now, shown: true, clearedAt: null, clearedByItself: false }, cleared: false };
  if (offered && banner && !banner.shown) return { banner: { ...banner, shown: true, clearedAt: null, clearedByItself: false }, cleared: false };
  if (!offered && banner?.shown) return { banner: { ...banner, shown: false, clearedAt: now, clearedByItself: true }, cleared: true };
  return { banner, cleared: false };
}

export interface HostedTaskRecord {
  plan: HostedTaskPlan;
  issueId: string | null;
  identifier: string | null;
  createdAt: number | null;
  createError: string | null;
  status: string;
  lastLiveAt: number | null;
  followUp: { at: number; commentId: string | null; error: string | null } | null;
  retryClicks: RetryClick[];
  retriedRuns: string[];
  doneAt: number | null;
}

const LIVE = new Set(["queued", "running", "scheduled_retry"]);
const RESTING = new Set(["done", "cancelled", "blocked", "in_review"]);
const TERMINAL = new Set(["done", "cancelled"]);
export const IDLE_RELEASE_MS = 10 * 60_000;

export function planHostedTasks(options: Pick<HostedOptions, "ratio" | "turnMinutes" | "subtaskShare" | "followUpShare" | "seed">, count: number): HostedTaskPlan[] {
  const rng = createRng((options.seed ^ 0x40575e) >>> 0);
  const adapters = assignAdapters(options.ratio, count);
  return adapters.map((adapter, index) => {
    const turnMinutes = rng.int(options.turnMinutes[0], options.turnMinutes[1]);
    const rounds = roundsFor(turnMinutes);
    const turnMs = rounds * ROUND_SECONDS * 1_000;
    const subtasks = rng.int(0, 99) < options.subtaskShare ? SUBTASKS_PER_PARENT : 0;
    const followUpAfterMs = rng.int(0, 99) < options.followUpShare ? rng.int(Math.round(turnMs * 0.25), Math.round(turnMs * 0.7)) : null;
    return { index, adapter, nonce: rng.hex(8), task: { turnMinutes, rounds, subtasks, followUpAfterMs, arriveAtMs: 0, holdMs: 0 } };
  });
}

export function inFlight(record: HostedTaskRecord, now: number): boolean {
  if (record.createError || !record.issueId) return false;
  if (RESTING.has(record.status)) return false;
  return now - (record.lastLiveAt ?? record.createdAt ?? now) < IDLE_RELEASE_MS;
}

export class HostedWorkload {
  readonly records: HostedTaskRecord[] = [];
  readonly banners = new Map<string, RetryBanner>();
  private next = 0;

  constructor(private readonly input: { api: WorkloadApi; label: string; companyId: string; projectId: string | null;
    agents: Partial<Record<AdapterId, { id: string; name: string }>>; plans: HostedTaskPlan[]; concurrency: number;
    record: (kind: string, data: Record<string, unknown>) => void; retryDuringWave?: boolean }) {}

  get remaining(): number { return this.input.plans.length - this.next; }
  get launched(): number { return this.next; }

  active(now = Date.now()): HostedTaskRecord[] {
    return this.records.filter(record => inFlight(record, now));
  }

  async launchDue(now = Date.now()): Promise<number> {
    let launched = 0;
    while (this.next < this.input.plans.length && this.active(now).length < this.input.concurrency) {
      const plan = this.input.plans[this.next]!;
      this.next += 1;
      launched += 1;
      const agent = this.input.agents[plan.adapter]!;
      const record: HostedTaskRecord = { plan, issueId: null, identifier: null, createdAt: null, createError: null, status: "todo", lastLiveAt: null,
        followUp: null, retryClicks: [], retriedRuns: [], doneAt: null };
      this.records.push(record);
      try {
        const issue = await this.input.api.post<{ id: string; identifier?: string }>(`/api/companies/${this.input.companyId}/issues`, {
          title: `${taskTag(this.input.label)} Staging mix ${plan.task.subtasks ? "parent" : "task"} ${plan.nonce}`,
          description: stagingMixDescription(plan.nonce, plan.task, { self: agent, other: agent, companyId: this.input.companyId }),
          status: "todo", priority: "medium", assigneeAgentId: agent.id, ...(this.input.projectId ? { projectId: this.input.projectId } : {}) });
        record.issueId = String(issue.id);
        record.identifier = issue.identifier ?? null;
        record.createdAt = Date.now();
        record.lastLiveAt = record.createdAt;
      } catch (error) {
        record.createError = error instanceof Error ? error.message : String(error);
      }
      this.input.record("hosted_task_created", { index: plan.index, adapter: plan.adapter, issueId: record.issueId, identifier: record.identifier,
        turnMinutes: plan.task.turnMinutes, subtasks: plan.task.subtasks, error: record.createError });
    }
    return launched;
  }

  async poll(now = Date.now()): Promise<void> {
    const seen = new Set<string>();
    for (const record of this.active(now)) {
      seen.add(record.issueId!);
      await this.step(record, now).catch(error =>
        this.input.record("hosted_task_poll_failed", { issueId: record.issueId, error: error instanceof Error ? error.message : String(error) }));
    }
    await this.observe(now, seen).catch(error => this.input.record("hosted_banner_observe_failed", { error: error instanceof Error ? error.message : String(error) }));
  }

  async observe(now: number, seen: ReadonlySet<string> = new Set()): Promise<void> {
    const agentIds = Object.values(this.input.agents).map(agent => agent!.id);
    for (const issue of await hostedIssues(this.input.api, this.input.companyId, agentIds)) {
      if (issue.hidden || seen.has(issue.id)) continue;
      if (TERMINAL.has(issue.status) && !this.banners.get(issue.id)?.shown) continue;
      this.noteBanner(issue.id, await this.input.api.get<Json>(`/api/issues/${issue.id}`), now);
    }
  }

  private noteBanner(issueId: string, view: Json, now: number): void {
    const offered = view.status !== "done" && view.interruption?.canRetry === true && !view.interruption?.retryWait;
    const previous = this.banners.get(issueId) ?? null;
    const change = trackBanner(previous, offered, now);
    if (change.banner === previous) return;
    const clicked = this.records.some(record => record.issueId === issueId && record.retryClicks.length > 0);
    this.banners.set(issueId, change.cleared && clicked ? { ...change.banner!, clearedByItself: false } : change.banner!);
    this.input.record(change.cleared ? "hosted_retry_banner_cleared" : "hosted_retry_banner_shown", { issueId, observedRunId: view.interruption?.observedRunId ?? null });
  }

  private async step(record: HostedTaskRecord, now: number): Promise<void> {
    const issue = await this.input.api.get<Json>(`/api/issues/${record.issueId}`);
    const runs = await this.input.api.get<Json[]>(`/api/issues/${record.issueId}/runs`).catch(() => [] as Json[]);
    record.status = String(issue.status);
    if (record.status === "done" && record.doneAt === null) record.doneAt = now;
    const live = runs.some(run => LIVE.has(String(run.status)));
    if (live || issue.scheduledRetry) record.lastLiveAt = now;
    const running = runs.some(run => run.status === "running");
    const task = record.plan.task;
    if (task.followUpAfterMs !== null && !record.followUp?.commentId && running && record.createdAt !== null && now >= record.createdAt + task.followUpAfterMs) {
      const followUp = { at: now, commentId: null as string | null, error: null as string | null };
      try {
        const comment = await this.input.api.post<{ id?: string }>(`/api/issues/${record.issueId}/comments`, { body: followUpComment(record.plan.nonce),
          clientRequestId: followUpRequestId(record.issueId!, record.plan.nonce) });
        followUp.commentId = typeof comment?.id === "string" ? comment.id : null;
      } catch (error) {
        followUp.error = error instanceof Error ? error.message : String(error);
      }
      record.followUp = followUp;
      this.input.record("hosted_follow_up", { issueId: record.issueId, commentId: followUp.commentId, error: followUp.error });
    }
    this.noteBanner(record.issueId!, issue, now);
    if (!this.input.retryDuringWave) return;
    const observedRunId = issue.interruption?.observedRunId ? String(issue.interruption.observedRunId) : null;
    if (record.status !== "done" && issue.interruption?.canRetry === true && !issue.interruption?.retryWait && !live && !record.retriedRuns.includes(observedRunId ?? "")) {
      record.retriedRuns.push(observedRunId ?? "");
      const click: RetryClick = { at: now, accepted: null, via: "observer" };
      try {
        const result = await this.input.api.post<{ accepted?: boolean }>(`/api/issues/${record.issueId}/retry`, { idempotencyKey: randomUUID(),
          observedRunId });
        click.accepted = result?.accepted === true;
      } catch {
        click.accepted = false;
      }
      record.retryClicks.push(click);
      record.lastLiveAt = now;
      this.input.record("task_retry_clicked", { issueId: record.issueId, accepted: click.accepted });
    }
  }
}
