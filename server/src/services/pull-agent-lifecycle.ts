import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentRuntimeState, agentTaskSessions, agents, heartbeatRuns, issues } from "@paperclipai/db";
import type {
  AgentRuntimeConfig,
  AgentStatus,
  PullAgentLifecycle,
  PullAgentLifecycleEvidence,
  PullAgentLifecycleReport,
  PullAgentLifecycleState,
} from "@paperclipai/shared";
import { resolveAgentHeartbeatDispatchPolicy } from "./pull-agent-dispatch.js";

const DEFAULT_PULL_LEASE_TTL_SEC = 120;
const MAX_PULL_LEASE_TTL_SEC = 3600;
const REPORT_STATE_KEY = "pullLifecycleReport";
const REPORT_RUNTIME_KEY = "pullLifecycle";
const NATIVE_SESSION_LIMIT = 20;
const MUTABLE_AGENT_STATUS = new Set<AgentStatus>(["idle", "running", "error", "active"]);
const LIVE_HEARTBEAT_RUN_STATUSES = ["running"] as const;

interface StoredPullAgentLifecycleReport extends PullAgentLifecycleReport {
  observedAt: string;
  expiresAt: string;
}
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asStoredReport(value: unknown): StoredPullAgentLifecycleReport | null {
  const row = asRecord(value);
  if (
    typeof row.source !== "string"
    || typeof row.observedAt !== "string"
    || typeof row.expiresAt !== "string"
  ) return null;
  return row as unknown as StoredPullAgentLifecycleReport;
}

export function agentStatusFromPullLifecycle(state: PullAgentLifecycleState): AgentStatus | null {
  if (state === "running") return "running";
  if (state === "idle" || state === "idle_queued" || state === "unreachable") return "idle";
  return null;
}

/** Prefer the native runtime-state lease; fall back to runtimeConfig.pullLifecycle
 *  so a host reporter can persist evidence through the existing agent PATCH before
 *  /lifecycle-report is deployed. */
export function resolveStoredPullReport(
  runtimeStateJson: unknown,
  runtimeConfig: unknown,
): StoredPullAgentLifecycleReport | null {
  const fromState = asStoredReport(asRecord(runtimeStateJson)[REPORT_STATE_KEY]);
  if (fromState) return fromState;
  return asStoredReport(asRecord(runtimeConfig)[REPORT_RUNTIME_KEY]);
}

function clampLeaseTtlSec(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : DEFAULT_PULL_LEASE_TTL_SEC;
  return Math.min(MAX_PULL_LEASE_TTL_SEC, Math.max(15, n));
}

function leaseTtlSecFor(runtimeConfig: AgentRuntimeConfig | undefined, override?: number): number {
  return clampLeaseTtlSec(override ?? runtimeConfig?.pull?.leaseTtlSec ?? DEFAULT_PULL_LEASE_TTL_SEC);
}

function clampObservedMs(observedAt: Date, now: Date): number {
  if (Number.isNaN(observedAt.getTime())) return now.getTime();
  return Math.min(observedAt.getTime(), now.getTime());
}

function isRecentTimestamp(value: Date | string | null | undefined, now: Date, ttlSec: number): boolean {
  if (!value) return false;
  const t = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(t.getTime())) return false;
  const age = now.getTime() - t.getTime();
  if (age > clampLeaseTtlSec(ttlSec) * 1_000) return false;
  // A future timestamp is clock skew, not extra lease time.
  return true;
}

function isExecutingHeartbeatRun(
  run: {
    status: string;
    finishedAt: Date | null;
    processPid: number | null;
    lastOutputAt: Date | null;
    processStartedAt: Date | null;
    startedAt: Date | null;
  },
  now: Date,
  ttlSec: number,
): boolean {
  if (run.finishedAt) return false;
  if (run.status !== "running") return false;
  // A recorded adapter pid means the run is still the live process. Do not
  // expire that on the short host-lease TTL — quiet thinking exceeds 120s.
  // Heartbeat's orphan reaper owns dead pids after restart. Rows with no pid
  // still need recent output or process-start so leftover running shells
  // after a restart do not look live.
  if (run.processPid != null) return true;
  return isRecentTimestamp(run.lastOutputAt, now, ttlSec)
    || isRecentTimestamp(run.processStartedAt, now, ttlSec);
}

function isFreshLease(
  report: StoredPullAgentLifecycleReport | null,
  now: Date,
  maxTtlSec = MAX_PULL_LEASE_TTL_SEC,
): boolean {
  if (!report) return false;
  const expiresAt = new Date(report.expiresAt);
  const observedAt = new Date(report.observedAt);
  if (Number.isNaN(expiresAt.getTime()) || Number.isNaN(observedAt.getTime())) return false;
  if (observedAt > now) return false;
  if (expiresAt <= now) return false;
  const cap = new Date(observedAt.getTime() + clampLeaseTtlSec(maxTtlSec) * 1_000);
  return now < cap;
}

function clampStoredLease(
  report: StoredPullAgentLifecycleReport,
  now: Date,
  maxTtlSec: number,
): StoredPullAgentLifecycleReport {
  const observedAt = new Date(report.observedAt);
  const expiresAt = new Date(report.expiresAt);
  const observedMs = clampObservedMs(observedAt, now);
  const requestedExpiry = Number.isNaN(expiresAt.getTime())
    ? observedMs + maxTtlSec * 1_000
    : expiresAt.getTime();
  const cappedExpiry = Math.min(requestedExpiry, observedMs + maxTtlSec * 1_000);
  return {
    ...report,
    observedAt: new Date(observedMs).toISOString(),
    expiresAt: new Date(cappedExpiry).toISOString(),
  };
}

export function derivePullAgentLifecycle(input: {
  runtimeConfig: AgentRuntimeConfig;
  storedReport: StoredPullAgentLifecycleReport | null;
  queuedIssueCount: number;
  blockedIssueCount: number;
  nativeEvidence?: PullAgentLifecycleEvidence[];
  now?: Date;
}): PullAgentLifecycle {
  const executionModel = input.runtimeConfig.executionModel === "pull" ? "pull" : "push";
  const dispatchEnabled = executionModel === "push"
    || input.runtimeConfig.pull?.dispatchEnabled === true;
  const report = input.storedReport;
  const observedAt = report ? new Date(report.observedAt) : null;
  const expiresAt = report ? new Date(report.expiresAt) : null;
  const now = input.now ?? new Date();
  const nativeEvidence = input.nativeEvidence ?? [];
  const reportFresh = isFreshLease(report, now, leaseTtlSecFor(input.runtimeConfig));
  const evidence = [...(reportFresh ? report?.evidence ?? [] : []), ...nativeEvidence];
  const nativeActive = nativeEvidence.some((item) => item.active);

  let state: PullAgentLifecycle["state"];
  if (executionModel === "push") {
    state = "idle";
  } else if (!reportFresh && !nativeActive) {
    state = "unreachable";
  } else if (reportFresh && report?.state === "blocked") {
    state = "blocked";
  } else if (
    nativeActive
    || (reportFresh && (report?.state === "running" || evidence.some((item) => item.active)))
  ) {
    state = "running";
  } else if (input.queuedIssueCount > 0) {
    state = "idle_queued";
  } else if (input.blockedIssueCount > 0) {
    state = "blocked";
  } else {
    state = "idle";
  }

  return {
    executionModel,
    state,
    source: reportFresh ? report?.source ?? null : nativeActive ? "task_session" : null,
    evidence,
    observedAt: observedAt && !Number.isNaN(observedAt.getTime()) ? observedAt : null,
    expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
    queuedIssueCount: input.queuedIssueCount,
    blockedIssueCount: input.blockedIssueCount,
    dispatchEnabled,
  };
}

export function pullAgentLifecycleService(db: Db) {
  async function issueCounts(companyId: string, agentId: string) {
    const rows = await db
      .select({ status: issues.status, count: sql<number>`count(*)::int` })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
      ))
      .groupBy(issues.status);
    const count = (statuses: string[]) => rows
      .filter((row) => statuses.includes(row.status))
      .reduce((sum, row) => sum + Number(row.count), 0);
    return {
      queuedIssueCount: count(["backlog", "todo", "in_progress", "in_review"]),
      blockedIssueCount: count(["blocked"]),
    };
  }

  async function nativeEvidence(agent: typeof agents.$inferSelect, now: Date) {
    const dispatchEnabled = resolveAgentHeartbeatDispatchPolicy(agent.runtimeConfig).dispatchEnabled;
    const ttlSec = leaseTtlSecFor(agent.runtimeConfig as AgentRuntimeConfig);
    const [liveRuns, rows] = await Promise.all([
      dispatchEnabled
        ? db
          .select({
            id: heartbeatRuns.id,
            status: heartbeatRuns.status,
            finishedAt: heartbeatRuns.finishedAt,
            startedAt: heartbeatRuns.startedAt,
            createdAt: heartbeatRuns.createdAt,
            processPid: heartbeatRuns.processPid,
            lastOutputAt: heartbeatRuns.lastOutputAt,
            processStartedAt: heartbeatRuns.processStartedAt,
          })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.companyId, agent.companyId),
            eq(heartbeatRuns.agentId, agent.id),
            inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_RUN_STATUSES]),
          ))
          .orderBy(desc(heartbeatRuns.createdAt))
          .limit(NATIVE_SESSION_LIMIT)
        : Promise.resolve([]),
      db
        .select({
          id: agentTaskSessions.id,
          taskKey: agentTaskSessions.taskKey,
          sessionDisplayId: agentTaskSessions.sessionDisplayId,
          lastRunId: agentTaskSessions.lastRunId,
          updatedAt: agentTaskSessions.updatedAt,
          lastError: agentTaskSessions.lastError,
          runStatus: heartbeatRuns.status,
          runFinishedAt: heartbeatRuns.finishedAt,
        })
        .from(agentTaskSessions)
        .leftJoin(heartbeatRuns, eq(agentTaskSessions.lastRunId, heartbeatRuns.id))
        .where(and(
          eq(agentTaskSessions.companyId, agent.companyId),
          eq(agentTaskSessions.agentId, agent.id),
        ))
        .orderBy(desc(agentTaskSessions.updatedAt))
        .limit(NATIVE_SESSION_LIMIT),
    ]);
    const liveById = new Map(
      liveRuns
        .filter((run) => isExecutingHeartbeatRun(run, now, ttlSec))
        .map((run) => [run.id, run] as const),
    );
    const sessionEvidence = rows.map((row): PullAgentLifecycleEvidence => {
      const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
      const liveRun = Boolean(row.lastRunId && liveById.has(row.lastRunId));
      return {
        kind: "task_session",
        id: row.sessionDisplayId || row.taskKey || row.id,
        active: liveRun,
        status: liveRun
          ? liveById.get(row.lastRunId!)?.status
          : (row.runStatus ?? (row.lastError ? "error" : "idle")),
        observedAt: Number.isNaN(updatedAt.getTime()) ? undefined : updatedAt.toISOString(),
        detail: row.taskKey,
      };
    });
    const covered = new Set(rows.map((row) => row.lastRunId).filter((id): id is string => Boolean(id)));
    const liveRunEvidence = [...liveById.values()]
      .filter((run) => !covered.has(run.id))
      .map((run): PullAgentLifecycleEvidence => {
        const observed = run.startedAt ?? run.createdAt;
        const observedAt = observed instanceof Date ? observed : new Date(observed);
        return {
          kind: "task_session",
          id: run.id,
          active: true,
          status: run.status,
          observedAt: Number.isNaN(observedAt.getTime()) ? undefined : observedAt.toISOString(),
          detail: "heartbeat_run",
        };
      });
    return [...sessionEvidence, ...liveRunEvidence];
  }

  async function get(agent: typeof agents.$inferSelect, now = new Date()) {
    const runtimeState = await db
      .select({ stateJson: agentRuntimeState.stateJson })
      .from(agentRuntimeState)
      .where(and(
        eq(agentRuntimeState.companyId, agent.companyId),
        eq(agentRuntimeState.agentId, agent.id),
      ))
      .then((rows) => rows[0] ?? null);
    const [counts, sessions] = await Promise.all([
      issueCounts(agent.companyId, agent.id),
      nativeEvidence(agent, now),
    ]);
    return derivePullAgentLifecycle({
      runtimeConfig: agent.runtimeConfig as AgentRuntimeConfig,
      storedReport: resolveStoredPullReport(runtimeState?.stateJson, agent.runtimeConfig),
      nativeEvidence: sessions,
      ...counts,
      now,
    });
  }

  async function syncAgentStatus(
    agent: typeof agents.$inferSelect,
    lifecycle: PullAgentLifecycle,
    now: Date,
  ) {
    const next = agentStatusFromPullLifecycle(lifecycle.state);
    if (!next) return;
    if (!MUTABLE_AGENT_STATUS.has(agent.status as AgentStatus)) return;
    if (agent.status === next) return;
    await db.update(agents).set({ status: next, updatedAt: now }).where(and(
      eq(agents.id, agent.id),
      eq(agents.status, agent.status),
    ));
  }

  async function report(agent: typeof agents.$inferSelect, input: PullAgentLifecycleReport, now = new Date()) {
    const runtimeConfig = agent.runtimeConfig as AgentRuntimeConfig;
    const ttlSec = leaseTtlSecFor(runtimeConfig, input.leaseTtlSec);
    const stored: StoredPullAgentLifecycleReport = {
      ...input,
      observedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSec * 1_000).toISOString(),
    };
    const patch = { [REPORT_STATE_KEY]: stored };

    await db.insert(agentRuntimeState).values({
      agentId: agent.id,
      companyId: agent.companyId,
      adapterType: agent.adapterType,
      stateJson: patch,
    }).onConflictDoUpdate({
      target: agentRuntimeState.agentId,
      set: {
        stateJson: sql`${agentRuntimeState.stateJson} || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: now,
      },
    });

    const lifecycle = await get(agent, now);
    await syncAgentStatus(agent, lifecycle, now);
    return lifecycle;
  }

  async function reconcile(agent: typeof agents.$inferSelect, now = new Date()) {
    const lifecycle = await get(agent, now);
    await syncAgentStatus(agent, lifecycle, now);
    return lifecycle;
  }

  async function reconcilePullAgents(
    candidates: Array<typeof agents.$inferSelect>,
    now = new Date(),
  ) {
    let reconciled = 0;
    for (const agent of candidates) {
      const runtimeConfig = agent.runtimeConfig as AgentRuntimeConfig;
      if (runtimeConfig.executionModel !== "pull") continue;
      await reconcile(agent, now);
      reconciled += 1;
    }
    return reconciled;
  }

  /** Promote a host-written runtimeConfig.pullLifecycle blob into the native
   *  runtime-state lease and derive agents.status. Existing PATCH /agents/:id
   *  is the production write path until POST /lifecycle-report is deployed.
   *  Expired blobs are not renewed: report() would stamp a new observedAt/expiresAt. */
  async function ingestRuntimeConfigLease(
    agent: typeof agents.$inferSelect,
    now = new Date(),
  ) {
    const stored = resolveStoredPullReport(null, agent.runtimeConfig);
    const ttlSec = leaseTtlSecFor(agent.runtimeConfig as AgentRuntimeConfig);
    if (!stored) return reconcile(agent, now);
    const clamped = clampStoredLease(stored, now, ttlSec);
    if (!isFreshLease(clamped, now, ttlSec)) return reconcile(agent, now);

    const patch = { [REPORT_STATE_KEY]: clamped };
    await db.insert(agentRuntimeState).values({
      agentId: agent.id,
      companyId: agent.companyId,
      adapterType: agent.adapterType,
      stateJson: patch,
    }).onConflictDoUpdate({
      target: agentRuntimeState.agentId,
      set: {
        stateJson: sql`${agentRuntimeState.stateJson} || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: now,
      },
    });
    return reconcile(agent, now);
  }

  return { get, report, reconcile, reconcilePullAgents, ingestRuntimeConfigLease };
}
