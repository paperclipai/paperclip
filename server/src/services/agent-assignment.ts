import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { agents, aiProviderDefaults, connectionGrants, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import {
  AGENT_DEFAULT_MAX_CONCURRENT_RUNS, aiRuntimeConnectionBindingSchema, assignmentTotal, compareAssignmentCandidates,
  getAgentWorkEligibility, issueAssignmentRoutingSchema, readAgentAssignmentProfile,
  type AiConnectionUsage, type AssignmentCandidate, type AssignmentScore, type AssignmentScoreKey, type AssignmentStrategy,
  type AutoAssignIssue, type IssueAssignmentRouting,
} from "@paperclipai/shared";
import { parseObject } from "../adapters/utils.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { aiConnectionService } from "./ai-connections.js";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { issueService } from "./issues.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { agentProviderLimitCooldown } from "./native-runtime/native-startup-retry.js";

type AgentRow = typeof agents.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

const HEALTH_SAMPLE_SIZE = 20;
const HEALTH_MIN_SAMPLES = 3;
const USAGE_TIMEOUT_MS = 10_000;
const USAGE_CACHE_MS = 60_000;
const ASSIGNABLE_STATUSES = ["backlog", "todo", "blocked"];

export type ProbeAgentUsage = (input: { companyId: string; userId: string | null; agent: AgentRow }) => Promise<AiConnectionUsage | null>;

export interface AgentAssignmentActivityActor {
  actorType: "user" | "agent" | "system";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

function score(value: number, source: AssignmentScore["source"], detail: string | null = null): AssignmentScore {
  return { value: Math.max(0, Math.min(1, Math.round(value * 1000) / 1000)), source, detail };
}

const neutral = (detail: string) => score(0.5, "unknown", detail);

/** The smallest remaining share across the account's reported windows, or why it is unusable. */
export function quotaSignal(usage: AiConnectionUsage | null): { exhausted: string | null; score: AssignmentScore } {
  if (!usage || usage.status !== "ok") return { exhausted: null, score: neutral(usage?.message ?? "Usage is not reported for this account") };
  let lowest: { share: number; label: string; resetsAt: string | null } | null = null;
  for (const limit of usage.limits) {
    const share = limit.remainingPercent != null ? limit.remainingPercent / 100
      : limit.usedPercent != null ? 1 - limit.usedPercent / 100
        : limit.remaining != null && limit.limit ? limit.remaining / limit.limit : null;
    if (limit.limitReached === true || limit.allowed === false || share === 0) {
      return { exhausted: `${limit.label} is used up${limit.resetsAt ? ` until ${limit.resetsAt}` : ""}`, score: score(0, "observed", limit.label) };
    }
    if (share != null && (!lowest || share < lowest.share)) lowest = { share, label: limit.label, resetsAt: limit.resetsAt };
  }
  if (!lowest) return { exhausted: null, score: neutral("The provider reported no usage windows") };
  return { exhausted: null, score: score(lowest.share, "observed", `${Math.round(lowest.share * 100)}% left in ${lowest.label}`) };
}

function costSignal(agent: AgentRow): AssignmentScore {
  const binding = aiRuntimeConnectionBindingSchema.safeParse(parseObject(agent.runtimeConfig).aiConnection);
  if (!binding.success) return neutral("No managed AI connection");
  if (binding.data.mode === "router") return score(0.6, "estimated", "Connection pool");
  return binding.data.method === "subscription"
    ? score(1, "estimated", "Subscription: no per-run charge")
    : score(0.4, "estimated", "API key: charged per token");
}

function maxConcurrentRuns(agent: AgentRow) {
  const value = Number(parseObject(parseObject(agent.runtimeConfig).heartbeat).maxConcurrentRuns);
  return Number.isFinite(value) && value > 0 ? value : AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
}

export function agentAssignmentService(db: Db, options: { wakeup?: IssueAssignmentWakeupDeps["wakeup"]; probeUsage?: ProbeAgentUsage; now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const usageCache = new Map<string, { value: AiConnectionUsage | null; expires: number }>();

  /** Reads the agent's own account usage through the platform probe; never estimates it. */
  const defaultProbeUsage: ProbeAgentUsage = async ({ companyId, userId, agent }) => {
    if (!userId) return null;
    const binding = aiRuntimeConnectionBindingSchema.safeParse(parseObject(agent.runtimeConfig).aiConnection);
    if (!binding.success || binding.data.mode === "router") return null;
    let grantId: string | null = null;
    let connectionId: string | null = null;
    if (binding.data.mode === "responsible_user") {
      const [row] = await db.select({ grantId: aiProviderDefaults.grantId }).from(aiProviderDefaults).where(and(
        eq(aiProviderDefaults.companyId, companyId), eq(aiProviderDefaults.userId, userId), eq(aiProviderDefaults.provider, binding.data.provider)));
      grantId = row?.grantId ?? null;
    } else {
      grantId = binding.data.grantId;
      connectionId = binding.data.connectionId;
    }
    if (!grantId) return null;
    if (!connectionId) {
      const [grant] = await db.select({ connectionId: connectionGrants.connectionId }).from(connectionGrants)
        .where(and(eq(connectionGrants.companyId, companyId), eq(connectionGrants.id, grantId)));
      connectionId = grant?.connectionId ?? null;
    }
    if (!connectionId) return null;
    const key = `${companyId}:${grantId}`;
    const cached = usageCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const value = await Promise.race([
      aiConnectionService(db).probeUsage(companyId, userId, connectionId, grantId).catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), USAGE_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (usageCache.size > 500) usageCache.clear();
    usageCache.set(key, { value, expires: Date.now() + USAGE_CACHE_MS });
    return value;
  };
  const probeUsage = options.probeUsage ?? defaultProbeUsage;

  async function loadScore(agent: AgentRow) {
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id), inArray(heartbeatRuns.status, ["queued", "running"])));
    const active = Number(row?.count ?? 0);
    const limit = maxConcurrentRuns(agent);
    return { full: active >= limit, score: score(1 - active / limit, "observed", `${active}/${limit} runs active`) };
  }

  async function healthScore(agent: AgentRow) {
    const rows = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id),
      inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out"]),
    )).orderBy(desc(heartbeatRuns.createdAt)).limit(HEALTH_SAMPLE_SIZE);
    if (rows.length < HEALTH_MIN_SAMPLES) return neutral(`Only ${rows.length} finished runs`);
    const succeeded = rows.filter((row) => row.status === "succeeded").length;
    const limited = rows.filter((row) => row.errorCode === "provider_quota").length;
    return score(succeeded / rows.length, "observed", `${succeeded}/${rows.length} recent runs succeeded${limited ? `, ${limited} hit a usage limit` : ""}`);
  }

  /** Evaluates every company agent for the task. Never writes. */
  async function evaluate(input: {
    issue: IssueRow; actor: AuthorizationActor; userId: string | null; request: AutoAssignIssue; excludeAgentIds?: string[];
  }): Promise<AssignmentCandidate[]> {
    const { issue, request } = input;
    const companyAgents = await db.select().from(agents).where(eq(agents.companyId, issue.companyId));
    const authorization = authorizationService(db);
    const at = now();
    const ranked: Array<AssignmentCandidate & { createdAt: string; loadValue: number | null }> = [];
    for (const agent of companyAgents) {
      const excluded: string[] = [];
      const profile = readAgentAssignmentProfile(agent.runtimeConfig);
      if (!profile) excluded.push("Not opted in to automatic assignment");
      if (input.excludeAgentIds?.includes(agent.id)) excluded.push("Already tried for this task");
      const eligibility = getAgentWorkEligibility({ agent, agents: companyAgents });
      if (!eligibility.assignable) excluded.push(`Cannot take work: ${eligibility.assignabilityReason ?? "unavailable"}`);
      if (agent.status === "paused") excluded.push("Paused");
      if (Array.isArray(agent.lifecycleHolds) && agent.lifecycleHolds.length > 0) excluded.push("On hold (budget or lifecycle)");
      const missing = request.requiredCapabilities.filter((capability) => !profile?.capabilities.includes(capability));
      if (profile && missing.length) excluded.push(`Missing capabilities: ${missing.join(", ")}`);
      if (!excluded.length) {
        const decision = await authorization.decide({ actor: input.actor, action: "tasks:assign", resource: {
          type: "issue", companyId: issue.companyId, issueId: issue.id, projectId: issue.projectId, parentIssueId: issue.parentId,
          assigneeAgentId: agent.id, assigneeUserId: null, status: issue.status,
        }, scope: { issueId: issue.id, projectId: issue.projectId, parentIssueId: issue.parentId, assigneeAgentId: agent.id, assigneeUserId: null } });
        if (!decision.allowed) excluded.push(`Not permitted: ${decision.explanation}`);
      }
      let scores: AssignmentCandidate["scores"] = null;
      let loadValue: number | null = null;
      if (!excluded.length) {
        const cooldown = await agentProviderLimitCooldown(db, { companyId: issue.companyId, agentId: agent.id, now: at }).catch(() => null);
        if (cooldown) excluded.push(`Usage limit until ${cooldown.resetAt.toISOString()}`);
      }
      if (!excluded.length) {
        const [load, health, usage] = await Promise.all([
          loadScore(agent), healthScore(agent),
          probeUsage({ companyId: issue.companyId, userId: input.userId, agent }).catch((err: unknown) => {
            logger.warn({ err, agentId: agent.id }, "agent usage probe failed during automatic assignment");
            return null;
          }),
        ]);
        if (load.full) excluded.push(`All ${maxConcurrentRuns(agent)} run slots are busy`);
        if (usage?.status === "unavailable") excluded.push(`AI connection unavailable: ${usage.message ?? usage.errorCode ?? "reconnect it"}`);
        const quota = quotaSignal(usage);
        if (quota.exhausted) excluded.push(quota.exhausted);
        const quality = profile?.quality != null ? score((profile.quality - 1) / 4, "configured", `Quality ${profile.quality}/5`) : neutral("No quality level set");
        scores = { quota: quota.score, cost: costSignal(agent), load: load.score, health, quality };
        loadValue = load.score.value;
      }
      const eligible = excluded.length === 0;
      ranked.push({
        agentId: agent.id, name: agent.name, eligible, excludedReasons: excluded, scores,
        total: scores && eligible ? assignmentTotal(scores as Record<AssignmentScoreKey, AssignmentScore>, request.strategy) : null,
        rank: null, createdAt: agent.createdAt.toISOString(), loadValue,
      });
    }
    ranked.sort((left, right) => compareAssignmentCandidates(
      { ...left, load: left.loadValue }, { ...right, load: right.loadValue }));
    let rank = 0;
    return ranked.map(({ createdAt: _createdAt, loadValue: _loadValue, ...candidate }) => ({ ...candidate, rank: candidate.eligible ? ++rank : null }));
  }

  /**
   * Assigns an unowned task to the best eligible agent. The task row lock and
   * status version make concurrent requests settle on one owner.
   */
  async function autoAssign(input: {
    issueId: string; actor: AuthorizationActor; activityActor: AgentAssignmentActivityActor; userId: string | null;
    request: AutoAssignIssue; excludeAgentIds?: string[]; fallback?: IssueAssignmentRouting["fallback"];
  }): Promise<IssueAssignmentRouting> {
    const [initial] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    if (!initial) throw notFound("Task not found");
    if (!input.fallback && (initial.assigneeAgentId || initial.assigneeUserId)) throw conflict("Automatic assignment needs a task without an assignee");
    const statuses = input.fallback ? [...ASSIGNABLE_STATUSES, "in_progress"] : ASSIGNABLE_STATUSES;
    if (!statuses.includes(initial.status)) throw unprocessable(`Automatic assignment does not apply to a ${initial.status} task`);
    if (initial.executionRunId) throw conflict("This task is running; automatic assignment never moves running work");
    // Evaluation probes provider usage, so it runs before the row lock.
    const candidates = await evaluate({ issue: initial, actor: input.actor, userId: input.userId, request: input.request, excludeAgentIds: input.excludeAgentIds });
    const selected = candidates.find((candidate) => candidate.eligible) ?? null;
    const routing: IssueAssignmentRouting = issueAssignmentRoutingSchema.parse({
      mode: "auto", status: selected ? "assigned" : "no_candidate", strategy: input.request.strategy,
      requiredCapabilities: input.request.requiredCapabilities,
      tier: (parseObject(initial.difficultyRouting).tier as IssueAssignmentRouting["tier"] | undefined) ?? null,
      selectedAgentId: selected?.agentId ?? null, candidates, decidedAt: now().toISOString(), fallback: input.fallback ?? null,
    });
    const updated = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(issues).where(and(eq(issues.id, initial.id), eq(issues.companyId, initial.companyId))).for("update");
      if (!current || current.statusVersion !== initial.statusVersion || current.assigneeAgentId !== initial.assigneeAgentId
        || current.assigneeUserId !== initial.assigneeUserId || current.executionRunId) {
        throw conflict("The task changed while Paperclip chose an agent; reload and try again");
      }
      if (!selected) {
        await tx.update(issues).set({ assignmentRouting: routing, updatedAt: new Date() }).where(eq(issues.id, current.id));
        return null;
      }
      const result = await issueService(tx as unknown as Db).update(current.id, {
        companyGuard: current.companyId, assigneeAgentId: selected.agentId, assigneeUserId: null,
        status: current.status === "in_progress" ? "todo" : current.status,
        statusVersion: current.statusVersion + 1,
        ...(input.activityActor.actorType === "agent" ? { actorAgentId: input.activityActor.actorId } : { actorUserId: input.activityActor.actorId }),
      }, tx as unknown as Db);
      if (!result) throw notFound("Task not found");
      await tx.update(issues).set({ assignmentRouting: routing }).where(eq(issues.id, current.id));
      return result;
    });
    await logActivity(db, {
      companyId: initial.companyId, ...input.activityActor, action: selected ? "issue.auto_assigned" : "issue.auto_assignment_unavailable",
      entityType: "issue", entityId: initial.id,
      details: {
        strategy: routing.strategy, selectedAgentId: routing.selectedAgentId, fallback: routing.fallback,
        candidates: candidates.map(({ agentId, name, eligible, excludedReasons, total, rank }) => ({ agentId, name, eligible, excludedReasons, total, rank })),
      },
    });
    if (updated && options.wakeup) {
      // Awaited so a caller that drains work sees the new owner's wake; a failed wake never undoes the assignment.
      await queueIssueAssignmentWakeup({
        heartbeat: { wakeup: options.wakeup }, issue: updated, reason: "issue_assigned", mutation: input.fallback ? "auto_assignment_fallback" : "auto_assign",
        contextSource: "issue.auto_assign", requestedByActorType: input.activityActor.actorType, requestedByActorId: input.activityActor.actorId,
      })?.catch((err: unknown) => logger.warn({ err, issueId: initial.id }, "failed to wake the automatically assigned agent"));
    }
    return routing;
  }

  /**
   * Whether a wake that is about to wait for the assignee's provider limit may
   * instead move its task once to the next candidate. Only auto-assigned tasks
   * qualify, and only while the current assignee has finished no run on them.
   */
  async function fallbackEligible(input: { companyId: string; issueId: string; agentId: string }): Promise<boolean> {
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
    const routing = issueAssignmentRoutingSchema.safeParse(issue?.assignmentRouting);
    if (!issue || !routing.success || routing.data.status !== "assigned" || routing.data.fallback) return false;
    if (issue.assigneeAgentId !== input.agentId || routing.data.selectedAgentId !== input.agentId || !issue.responsibleUserId) return false;
    if (![...ASSIGNABLE_STATUSES, "in_progress"].includes(issue.status)) return false;
    const [worked] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`, eq(heartbeatRuns.status, "succeeded"))).limit(1);
    return !worked;
  }

  /** Moves an eligible task to the next candidate. The caller has already released the wake's task lock. */
  async function fallbackFromProviderLimit(input: { companyId: string; issueId: string; agentId: string; resetAt: string }): Promise<boolean> {
    if (!(await fallbackEligible(input))) return false;
    const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    const routing = issueAssignmentRoutingSchema.parse(issue!.assignmentRouting);
    const userId = issue!.responsibleUserId!;
    // Candidates are re-checked against the responsible person's own authority.
    const actor = { type: "board", userId, source: "system", companyIds: [issue!.companyId] } as unknown as AuthorizationActor;
    try {
      const next = await autoAssign({
        issueId: issue!.id, actor, userId, activityActor: { actorType: "system", actorId: "system" },
        request: { strategy: routing.strategy, requiredCapabilities: routing.requiredCapabilities },
        excludeAgentIds: [input.agentId],
        fallback: { fromAgentId: input.agentId, reason: `Usage limit until ${input.resetAt}`, at: now().toISOString() },
      });
      return next.status === "assigned";
    } catch (err) {
      logger.warn({ err, issueId: input.issueId }, "automatic assignment fallback failed; keeping the usage limit wait");
      return false;
    }
  }

  return { evaluate, autoAssign, fallbackEligible, fallbackFromProviderLimit };
}
