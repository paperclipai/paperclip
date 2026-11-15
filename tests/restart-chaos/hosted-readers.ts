import type { HostedApi } from "./hosted-api.js";
import { isAutoNotice, type GradeRun, type GradeTaskInput } from "./release-swap-grade.js";

type Json = Record<string, any>;
export type ReadApi = Pick<HostedApi, "get">;

export const UNAVAILABLE_OVER_API = [
  "queuedWakes: the API has no read of a task's queued wake requests, so a task whose only owner is a queued wake grades as having none",
  "ownerPid / owning server process of each run: the API does not expose which server process (controller boot) owned a run",
  "lostWhileOldAlive: needs the owning server process, so it is not computed",
  "doubleExecutors: two Runner processes for one run come from database cross-server evidence, not the API",
  "late-start and preparation-during-recovery evidence: the harness does not drive the release, so it cannot place probes on the outgoing server",
] as const;

export interface HostedRunRow {
  runId: string;
  agentId: string | null;
  issueId: string | null;
  status: string;
  errorCode: string | null;
  error: string | null;
  createdAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  lastActivityAt: number | null;
  ownerPid: null;
}

export interface HostedIssueRow {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  parentId: string | null;
  assigneeAgentId: string | null;
  hidden: boolean;
}

const ms = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};
const text = (value: unknown): string | null => value === null || value === undefined ? null : String(value);

export function runRow(run: Json): HostedRunRow {
  const activity = [ms(run.updatedAt), ms(run.lastOutputAt), ms(run.lastUsefulActionAt), ms(run.finishedAt)].filter((at): at is number => at !== null);
  return {
    runId: String(run.id), agentId: text(run.agentId), issueId: text(run.issueId ?? run.contextSnapshot?.issueId), status: String(run.status),
    errorCode: text(run.errorCode), error: run.error ? String(run.error).slice(0, 400) : null,
    createdAt: ms(run.createdAt), startedAt: ms(run.startedAt), finishedAt: ms(run.finishedAt),
    lastActivityAt: activity.length ? Math.max(...activity) : null, ownerPid: null,
  };
}

export const RUN_PAGE = 1_000;
export const ISSUE_PAGE = 500;
export const EVENT_PAGE = 500;

export async function hostedIssues(api: ReadApi, companyId: string, agentIds: readonly string[]): Promise<HostedIssueRow[]> {
  const byId = new Map<string, HostedIssueRow>();
  for (const agentId of agentIds) {
    for (let offset = 0; ; offset += ISSUE_PAGE) {
      const page = await api.get<Json[]>(`/api/companies/${companyId}/issues?assigneeAgentId=${encodeURIComponent(agentId)}&includeAgentCreatedTasks=true`
        + `&limit=${ISSUE_PAGE}&offset=${offset}`);
      for (const issue of page) {
        if (issue.assigneeAgentId !== agentId) continue;
        byId.set(String(issue.id), { id: String(issue.id), identifier: text(issue.identifier), title: String(issue.title ?? ""), status: String(issue.status),
          parentId: text(issue.parentId), assigneeAgentId: text(issue.assigneeAgentId), hidden: Boolean(issue.hiddenAt) });
      }
      if (page.length < ISSUE_PAGE) break;
    }
  }
  return [...byId.values()];
}

export async function hostedCompanyRuns(api: ReadApi, companyId: string, agentIds: readonly string[]): Promise<HostedRunRow[]> {
  const rows = new Map<string, HostedRunRow>();
  let truncated = false;
  for (const agentId of agentIds) {
    const page = await api.get<Json[]>(`/api/companies/${companyId}/heartbeat-runs?agentId=${encodeURIComponent(agentId)}&limit=${RUN_PAGE}`);
    if (page.length >= RUN_PAGE) truncated = true;
    for (const run of page) if (run.agentId === agentId) rows.set(String(run.id), runRow(run));
  }
  if (!truncated) return [...rows.values()];
  const ours = new Set(agentIds);
  for (const issue of await hostedIssues(api, companyId, agentIds)) {
    const runs = await api.get<Json[]>(`/api/issues/${issue.id}/runs`);
    for (const run of runs) {
      if (!ours.has(String(run.agentId)) || rows.has(String(run.runId))) continue;
      rows.set(String(run.runId), runRow({ ...run, id: run.runId, issueId: issue.id }));
    }
  }
  return [...rows.values()];
}

export function startedIssues(issues: readonly HostedIssueRow[], runs: readonly HostedRunRow[]): HostedIssueRow[] {
  const withRun = new Set(runs.flatMap(run => run.issueId ? [run.issueId] : []));
  return issues.filter(issue => !issue.hidden && withRun.has(issue.id));
}

export async function pendingPersonItems(api: ReadApi, issueIds: readonly string[]): Promise<{ questions: Set<string>; approvals: Set<string>; unreadable: string[] }> {
  const questions = new Set<string>();
  const approvals = new Set<string>();
  const unreadable: string[] = [];
  for (const id of issueIds) {
    try {
      const interactions = await api.get<Json[]>(`/api/issues/${id}/interactions`);
      if (interactions.some(interaction => interaction.status === "pending")) questions.add(id);
      const linked = await api.get<Json[]>(`/api/issues/${id}/approvals`);
      if (linked.some(approval => ["pending", "revision_requested"].includes(String(approval.status ?? approval.approval?.status)))) approvals.add(id);
    } catch {
      unreadable.push(id);
    }
  }
  return { questions, approvals, unreadable };
}

export function issueViewFields(issue: Json): Omit<GradeTaskInput, "issueId" | "identifier" | "title" | "runs" | "queuedWakes" | "retryClicks" | "pendingApproval" | "pendingQuestion"> {
  const interruption = issue.interruption;
  return {
    status: String(issue.status),
    scheduledRetry: Boolean(issue.scheduledRetry),
    interruption: interruption ? { state: String(interruption.state), canRetry: interruption.canRetry === true, retryWait: Boolean(interruption.retryWait),
      userAction: text(interruption.userAction), responsibility: text(interruption.responsibility), providerFailureCategory: text(interruption.providerFailure?.category) } : null,
    activeRecoveryOwner: text(issue.activeRecoveryAction?.ownerType),
    executionBlocker: Boolean(issue.executionBlocker),
    openBlockers: (issue.blockedBy ?? []).filter((blocker: Json) => blocker.status !== "done" && blocker.status !== "cancelled").length,
  };
}

export function gradeRuns(runs: readonly HostedRunRow[]): GradeRun[] {
  return runs.map(run => ({ runId: run.runId, status: run.status, errorCode: run.errorCode, createdAt: run.createdAt, startedAt: run.startedAt,
    finishedAt: run.finishedAt, lastActivityAt: run.lastActivityAt }));
}

export async function runEvents(api: ReadApi, runId: string): Promise<Json[]> {
  const events: Json[] = [];
  for (let afterSeq = 0; ;) {
    const page = await api.get<Json[]>(`/api/heartbeat-runs/${runId}/events?afterSeq=${afterSeq}&limit=${EVENT_PAGE}`);
    events.push(...page);
    const last = Number(page.at(-1)?.seq);
    if (page.length < EVENT_PAGE || !Number.isFinite(last) || last <= afterSeq) return events;
    afterSeq = last;
  }
}

export async function failureChain(api: ReadApi, runId: string): Promise<string[]> {
  const events = await runEvents(api, runId).catch(() => [] as Json[]);
  return events.filter(event => event.level === "error" || event.level === "warn" || /fail|error|lost/i.test(String(event.eventType)))
    .slice(-6).map(event => `${event.eventType}${event.message ? `: ${String(event.message).slice(0, 240)}` : ""}`);
}

export async function firstEventAfter(api: ReadApi, runId: string, after: number): Promise<number | null> {
  const events = await runEvents(api, runId).catch(() => [] as Json[]);
  const times = events.map(event => ms(event.createdAt)).filter((at): at is number => at !== null && at > after);
  return times.length ? Math.min(...times) : null;
}

export async function duplicateAgentComments(api: ReadApi, issueIds: readonly string[]):
  Promise<{ duplicateComments: Array<{ issueId: string; count: number }>; autoNoticeRepeats: Array<{ issueId: string; count: number }> }> {
  const duplicateComments: Array<{ issueId: string; count: number }> = [];
  const autoNoticeRepeats: Array<{ issueId: string; count: number }> = [];
  for (const id of issueIds) {
    const comments = await api.get<Json[]>(`/api/issues/${id}/comments`).catch(() => [] as Json[]);
    const counts = new Map<string, { body: string; count: number }>();
    for (const comment of comments) if (comment.authorAgentId) {
      const key = `${comment.authorAgentId}\u0000${comment.body}`;
      counts.set(key, { body: String(comment.body ?? ""), count: (counts.get(key)?.count ?? 0) + 1 });
    }
    for (const { body, count } of counts.values()) if (count > 1) (isAutoNotice(body) ? autoNoticeRepeats : duplicateComments).push({ issueId: id, count });
  }
  return { duplicateComments, autoNoticeRepeats };
}

export function duplicateChildren(issues: readonly HostedIssueRow[]): Array<{ parentId: string; title: string; count: number }> {
  const counts = new Map<string, { parentId: string; title: string; count: number }>();
  for (const issue of issues) {
    if (!issue.parentId || issue.hidden) continue;
    const key = `${issue.parentId}\u0000${issue.title}`;
    const entry = counts.get(key) ?? { parentId: issue.parentId, title: issue.title, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].filter(entry => entry.count > 1);
}
