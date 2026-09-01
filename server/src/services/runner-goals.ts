import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentSessionGoalActions,
  agentTaskSessions,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import type {
  RunnerGoalActionAccepted,
  RunnerGoalActionRequest,
  RunnerGoalCapability,
  RunnerGoalPendingAction,
  RunnerGoalProjection,
  RunnerGoalSnapshot,
} from "@paperclipai/shared";
import { queueLiveRunnerPrpCommand } from "../realtime/runner-prp-ws.js";
import { dispatchLiveRunnerGoalControl } from "./runner-goal-control-broker.js";
import { publishLiveEvent } from "./live-events.js";

const ACTIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;
const OPEN_ACTION_STATUSES = ["pending", "delivering", "delivered"] as const;

type AgentBinding = Pick<typeof agents.$inferSelect, "id" | "companyId" | "adapterType" | "adapterConfig">;
type TaskSession = typeof agentTaskSessions.$inferSelect;

export class RunnerGoalConflictError extends Error {
  constructor(
    readonly code: "stale_revision" | "replacement_required" | "idempotency_key_conflict",
    readonly projection: RunnerGoalProjection,
  ) {
    super(code);
  }
}

export class RunnerGoalActionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function capabilityForAgent(agent: AgentBinding): RunnerGoalCapability {
  const config = asRecord(agent.adapterConfig) ?? {};
  const engine = typeof config.engine === "string" ? config.engine : null;
  const sessionMode = typeof config.mode === "string" ? config.mode : "persistent";
  if (agent.adapterType === "paperclip_runner") {
    const provider = typeof config.provider === "string" ? config.provider : "codex";
    const acpxAgent = typeof config.acpxAgent === "string" ? config.acpxAgent : "pi";
    if (provider === "codex" || (provider === "acpx" && acpxAgent === "codex")) {
      return {
        availability: "available",
        verified: false,
        actions: ["set", "pause", "resume", "clear"],
        autonomousUpdates: true,
        persistentAcrossResume: true,
        maxObjectiveChars: 4_000,
        tokenBudgetControl: true,
        usageReporting: true,
        reasonCode: "support_pending_handshake",
        reason: provider === "codex"
          ? "Support will be verified when the Codex session starts."
          : "Support will be verified when the persistent Codex ACP session starts.",
      };
    }
    if (provider === "acpx" && acpxAgent === "claude") {
      return {
        availability: "available",
        verified: false,
        actions: ["set", "clear"],
        autonomousUpdates: true,
        persistentAcrossResume: true,
        maxObjectiveChars: 4_000,
        tokenBudgetControl: false,
        usageReporting: false,
        reasonCode: "support_pending_handshake",
        reason: "Support will be verified when the persistent Claude ACP session starts.",
      };
    }
    const reason = provider === "opencode"
      ? "Unsupported by OpenCode."
      : provider === "acpx"
        ? "This ACP agent does not advertise a structured session goal extension."
        : "This Paperclip runner provider does not expose a durable session goal lifecycle.";
    return {
      availability: "unsupported",
      verified: true,
      actions: [],
      autonomousUpdates: false,
      persistentAcrossResume: false,
      maxObjectiveChars: 4_000,
      tokenBudgetControl: false,
      usageReporting: false,
      reasonCode: provider === "opencode"
        ? "opencode_structured_goals_unavailable"
        : "persistent_session_goal_extension_required",
      reason,
    };
  }
  if (agent.adapterType === "codex_local" && engine !== "cli" && sessionMode !== "oneshot") {
    return {
      availability: "available",
      verified: false,
      actions: ["set", "pause", "resume", "clear"],
      autonomousUpdates: true,
      persistentAcrossResume: true,
      maxObjectiveChars: 4_000,
      tokenBudgetControl: true,
      usageReporting: true,
      reasonCode: "support_pending_handshake",
      reason: "Support will be verified when the persistent Codex ACP session starts.",
    };
  }
  if (agent.adapterType === "claude_local" && engine !== "cli" && sessionMode !== "oneshot") {
    return {
      availability: "available",
      verified: false,
      actions: ["set", "clear"],
      autonomousUpdates: true,
      persistentAcrossResume: true,
      maxObjectiveChars: 4_000,
      tokenBudgetControl: false,
      usageReporting: false,
      reasonCode: "support_pending_handshake",
      reason: "Support will be verified when the persistent Claude ACP session starts.",
    };
  }
  const reason = agent.adapterType === "opencode_local"
    ? "Unsupported by OpenCode."
    : (agent.adapterType === "claude_local" || agent.adapterType === "codex_local") && sessionMode === "oneshot"
      ? "Session goals require a persistent ACP session."
    : agent.adapterType === "claude_local"
      ? "Requires persistent Claude ACP."
      : agent.adapterType === "codex_local"
        ? "Requires persistent Codex ACP."
        : "This runner does not expose a durable session goal lifecycle.";
  return {
    availability: "unsupported",
    verified: true,
    actions: [],
    autonomousUpdates: false,
    persistentAcrossResume: false,
    maxObjectiveChars: 4_000,
    tokenBudgetControl: false,
    usageReporting: false,
    reasonCode: agent.adapterType === "opencode_local"
      ? "opencode_structured_goals_unavailable"
      : "persistent_session_goal_extension_required",
    reason,
  };
}

function storedCapability(session: TaskSession | null, fallback: RunnerGoalCapability): RunnerGoalCapability {
  const stored = asRecord(session?.goalCapabilityJson);
  if (!stored) return fallback;
  const availability = stored.availability;
  const actions = Array.isArray(stored.actions)
    ? stored.actions.filter((action): action is "set" | "pause" | "resume" | "clear" =>
      ["set", "pause", "resume", "clear"].includes(String(action)))
    : [];
  if (!["available", "unsupported", "policy_disabled"].includes(String(availability))) {
    return fallback;
  }
  return {
    availability: availability as RunnerGoalCapability["availability"],
    verified: true,
    actions,
    autonomousUpdates: stored.autonomousUpdates === true,
    persistentAcrossResume: stored.persistentAcrossResume === true,
    maxObjectiveChars: typeof stored.maxObjectiveChars === "number" ? stored.maxObjectiveChars : 4_000,
    tokenBudgetControl: stored.tokenBudgetControl === true,
    usageReporting: stored.usageReporting === true,
    reasonCode: typeof stored.reasonCode === "string" ? stored.reasonCode : null,
    reason: typeof stored.reason === "string" ? stored.reason : null,
  };
}

function storedGoal(session: TaskSession | null): RunnerGoalSnapshot | null {
  const goal = asRecord(session?.goalJson);
  if (!goal || typeof goal.objective !== "string" || typeof goal.status !== "string") return null;
  return {
    objective: goal.objective,
    status: goal.status as RunnerGoalSnapshot["status"],
    tokenBudget: typeof goal.tokenBudget === "number" ? goal.tokenBudget : null,
    tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0,
    elapsedSeconds: typeof goal.elapsedSeconds === "number" ? goal.elapsedSeconds : 0,
    iterations: typeof goal.iterations === "number" ? goal.iterations : 0,
    lastReason: typeof goal.lastReason === "string" ? goal.lastReason : null,
    createdAt: typeof goal.createdAt === "string" && goal.createdAt ? goal.createdAt : null,
    updatedAt: typeof goal.updatedAt === "string" && goal.updatedAt ? goal.updatedAt : null,
    completedAt: typeof goal.completedAt === "string" && goal.completedAt ? goal.completedAt : null,
    workingNow: goal.workingNow === true,
  };
}

function pendingAction(action: string | null): RunnerGoalPendingAction | null {
  switch (action) {
    case "create": return "starting";
    case "edit": return "editing";
    case "replace": return "replacing";
    case "pause": return "pausing";
    case "resume": return "resuming";
    case "clear": return "clearing";
    default: return null;
  }
}

function isSameGoalActionRequest(
  storedPayload: unknown,
  request: RunnerGoalActionRequest,
): boolean {
  const stored = asRecord(storedPayload);
  if (!stored) return false;
  const storedTokenBudget = typeof stored.tokenBudget === "number" || stored.tokenBudget === null
    ? stored.tokenBudget
    : undefined;
  return stored.requestId === request.requestId
    && stored.agentId === request.agentId
    && stored.expectedRevision === request.expectedRevision
    && stored.action === request.action
    && stored.objective === request.objective
    && storedTokenBudget === request.tokenBudget
    && (stored.confirmReplace === true) === (request.confirmReplace === true);
}

function commandSequence(request: RunnerGoalActionRequest) {
  if (request.action === "clear") {
    return [{ type: "session.goal.clear", payload: { requestId: request.requestId } }];
  }
  if (request.action === "pause") {
    return [{ type: "session.goal.set", payload: { requestId: request.requestId, status: "paused" } }];
  }
  if (request.action === "resume") {
    return [{ type: "session.goal.set", payload: { requestId: request.requestId, status: "active" } }];
  }
  const setPayload = {
    requestId: request.requestId,
    objective: request.objective,
    ...(request.action === "edit" ? {} : { status: "active" }),
    ...(request.tokenBudget !== undefined ? { tokenBudget: request.tokenBudget } : {}),
  };
  return request.action === "replace"
    ? [
        { type: "session.goal.clear", payload: { requestId: request.requestId } },
        { type: "session.goal.set", payload: setPayload },
      ]
    : [{ type: "session.goal.set", payload: setPayload }];
}

export function runnerGoalService(
  db: Db,
  options: {
    queueLiveCommand?: typeof queueLiveRunnerPrpCommand;
    dispatchLiveControl?: typeof dispatchLiveRunnerGoalControl;
    enqueueOfflineControl?: (input: {
      companyId: string;
      issueId: string;
      agentId: string;
      requestId: string;
      control: RunnerGoalActionRequest;
    }) => Promise<void>;
  } = {},
) {
  const queueLiveCommand = options.queueLiveCommand ?? queueLiveRunnerPrpCommand;
  const dispatchLiveControl = options.dispatchLiveControl ?? dispatchLiveRunnerGoalControl;

  async function readBinding(companyId: string, issueId: string, requestedAgentId?: string | null) {
    const [issue] = await db
      .select({ id: issues.id, companyId: issues.companyId, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .limit(1);
    if (!issue) return null;
    const agentId = requestedAgentId ?? issue.assigneeAgentId;
    if (!agentId) return { issue, agent: null };
    const [agent] = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .limit(1);
    return { issue, agent: agent ?? null };
  }

  async function projection(companyId: string, issueId: string, requestedAgentId?: string | null): Promise<RunnerGoalProjection | null> {
    const binding = await readBinding(companyId, issueId, requestedAgentId);
    if (!binding) return null;
    if (!binding.agent) {
      return {
        issueId,
        agentId: null,
        adapterType: null,
        sessionId: null,
        capability: {
          availability: "unsupported",
          verified: true,
          actions: [],
          autonomousUpdates: false,
          persistentAcrossResume: false,
          maxObjectiveChars: 4_000,
          tokenBudgetControl: false,
          usageReporting: false,
          reasonCode: "no_agent_selected",
          reason: "Select an agent to use session goals.",
        },
        goal: null,
        workingNow: false,
        activeRunId: null,
        pendingAction: null,
        revision: 0,
        observedAt: null,
      };
    }
    const [session, activeRun] = await Promise.all([
      db.select().from(agentTaskSessions).where(and(
        eq(agentTaskSessions.companyId, companyId),
        eq(agentTaskSessions.agentId, binding.agent.id),
        eq(agentTaskSessions.adapterType, binding.agent.adapterType),
        eq(agentTaskSessions.taskKey, issueId),
      )).orderBy(desc(agentTaskSessions.updatedAt)).limit(1).then((rows) => rows[0] ?? null),
      db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, binding.agent.id),
        eq(heartbeatRuns.nativeIssueId, issueId),
        inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
      )).orderBy(desc(heartbeatRuns.createdAt)).limit(1).then((rows) => rows[0] ?? null),
    ]);
    const pending = session
      ? await db.select({ action: agentSessionGoalActions.action })
          .from(agentSessionGoalActions)
          .where(and(
            eq(agentSessionGoalActions.sessionId, session.id),
            inArray(agentSessionGoalActions.status, [...OPEN_ACTION_STATUSES]),
          ))
          .orderBy(desc(agentSessionGoalActions.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    const goal = storedGoal(session);
    const projectedPendingAction = pendingAction(pending?.action ?? null) ?? (
      goal?.status === "active" && !goal.workingNow && activeRun
        ? "continuing"
        : null
    );
    return {
      issueId,
      agentId: binding.agent.id,
      adapterType: binding.agent.adapterType,
      sessionId: session?.id ?? null,
      capability: storedCapability(session, capabilityForAgent(binding.agent)),
      goal,
      workingNow: goal?.workingNow ?? false,
      activeRunId: activeRun?.id ?? null,
      pendingAction: projectedPendingAction,
      revision: session?.goalRevision ?? 0,
      observedAt: session?.goalObservedAt?.toISOString() ?? null,
    };
  }

  async function act(
    companyId: string,
    issueId: string,
    request: RunnerGoalActionRequest,
  ): Promise<RunnerGoalActionAccepted> {
    const binding = await readBinding(companyId, issueId, request.agentId);
    if (!binding) throw new RunnerGoalActionError("issue_not_found", "Issue not found.");
    if (!binding.agent) throw new RunnerGoalActionError("agent_not_found", "Agent not found.");
    if (binding.issue.assigneeAgentId !== request.agentId) {
      throw new RunnerGoalActionError("agent_not_assigned", "The selected agent is not assigned to this issue.");
    }
    const fallbackCapability = capabilityForAgent(binding.agent);
    const initialProjection = await projection(companyId, issueId, request.agentId);
    if (!initialProjection) throw new RunnerGoalActionError("issue_not_found", "Issue not found.");
    if (initialProjection.capability.availability !== "available") {
      throw new RunnerGoalActionError(
        initialProjection.capability.reasonCode ?? "session_goals_unsupported",
        initialProjection.capability.reason ?? "Session goals are unsupported.",
      );
    }

    const accepted = await db.transaction(async (tx) => {
      await tx.insert(agentTaskSessions).values({
        companyId,
        agentId: request.agentId,
        adapterType: binding.agent!.adapterType,
        taskKey: issueId,
      }).onConflictDoNothing();
      const [session] = await tx.select().from(agentTaskSessions).where(and(
        eq(agentTaskSessions.companyId, companyId),
        eq(agentTaskSessions.agentId, request.agentId),
        eq(agentTaskSessions.adapterType, binding.agent!.adapterType),
        eq(agentTaskSessions.taskKey, issueId),
      )).limit(1).for("update");
      if (!session) throw new RunnerGoalActionError("session_unavailable", "Agent task session is unavailable.");

      const currentGoal = storedGoal(session);
      const currentProjection: RunnerGoalProjection = {
        ...initialProjection,
        sessionId: session.id,
        capability: storedCapability(session, fallbackCapability),
        goal: currentGoal,
        workingNow: currentGoal?.workingNow ?? false,
        revision: session.goalRevision,
        observedAt: session.goalObservedAt?.toISOString() ?? null,
      };

      const [existingAction] = await tx.select().from(agentSessionGoalActions).where(and(
        eq(agentSessionGoalActions.sessionId, session.id),
        eq(agentSessionGoalActions.requestId, request.requestId),
      )).limit(1);
      if (existingAction) {
        if (!isSameGoalActionRequest(existingAction.payloadJson, request)) {
          throw new RunnerGoalConflictError("idempotency_key_conflict", currentProjection);
        }
        return {
          repeated: true,
          session,
          status: existingAction.status,
          result: asRecord(existingAction.resultJson),
        };
      }
      if (session.goalRevision !== request.expectedRevision) {
        throw new RunnerGoalConflictError("stale_revision", currentProjection);
      }
      const capability = storedCapability(session, fallbackCapability);
      const requiredCapabilityAction = request.action === "pause"
        ? "pause"
        : request.action === "resume"
          ? "resume"
          : request.action === "clear"
            ? "clear"
            : "set";
      if (capability.availability !== "available" || !capability.actions.includes(requiredCapabilityAction)) {
        throw new RunnerGoalActionError(
          capability.reasonCode ?? "goal_action_unsupported",
          capability.reason ?? `${request.action} is unsupported by this agent session.`,
        );
      }
      if (request.tokenBudget != null && !capability.tokenBudgetControl) {
        throw new RunnerGoalActionError(
          "goal_token_budget_unsupported",
          "This agent session does not support goal token budgets.",
        );
      }
      if (request.action === "create" && currentGoal && currentGoal.status !== "complete") {
        throw new RunnerGoalConflictError("replacement_required", currentProjection);
      }
      if (["edit", "replace", "pause", "resume", "clear"].includes(request.action) && !currentGoal) {
        throw new RunnerGoalActionError("goal_not_found", "There is no current session goal.");
      }

      const nextRevision = session.goalRevision + 1;
      const desiredState = request.action === "pause"
        ? "paused"
        : request.action === "clear"
          ? null
          : "active";
      await tx.update(agentTaskSessions).set({
        goalDesiredState: desiredState,
        goalRevision: nextRevision,
        updatedAt: new Date(),
      }).where(eq(agentTaskSessions.id, session.id));
      const pendingProjection: RunnerGoalProjection = {
        ...currentProjection,
        pendingAction: pendingAction(request.action),
        revision: nextRevision,
      };
      const [action] = await tx.insert(agentSessionGoalActions).values({
        companyId,
        sessionId: session.id,
        requestId: request.requestId,
        action: request.action,
        payloadJson: request,
        resultJson: { projection: pendingProjection },
      }).returning();
      return {
        repeated: false,
        session: { ...session, goalRevision: nextRevision },
        status: action!.status,
        result: { projection: pendingProjection },
      };
    });

    const originalProjection = accepted.result?.projection as RunnerGoalProjection | undefined;
    if (accepted.repeated) {
      const repeatedStatus = OPEN_ACTION_STATUSES.includes(
        accepted.status as (typeof OPEN_ACTION_STATUSES)[number],
      )
        ? "pending"
        : accepted.status === "completed"
          ? "completed"
          : "failed";
      return {
        requestId: request.requestId,
        status: repeatedStatus,
        projection: originalProjection ?? (await projection(companyId, issueId, request.agentId))!,
      };
    }

    const commands = commandSequence(request);
    let live = false;
    const liveCompletions: Array<Promise<unknown>> = [];
    try {
      // Runner transports can retain a durable PRP authority while their
      // heartbeat is suspended. That authority is resumable, but it is not a
      // live command consumer. Only use either in-memory broker when the
      // projection proves a run is currently active; otherwise the outbox
      // resumes the provider session through the goal_control heartbeat.
      const hasActiveRun = typeof originalProjection?.activeRunId === "string";
      const adapterControl = hasActiveRun
        ? dispatchLiveControl({
            companyId,
            issueId,
            agentId: request.agentId,
          }, request)
        : null;
      if (adapterControl) {
        live = true;
        liveCompletions.push(adapterControl.completion);
      } else if (hasActiveRun) {
        const queuedCommands = commands.map((command, index) => queueLiveCommand({
          companyId,
          issueId,
          agentId: request.agentId,
          type: command.type,
          payload: command.payload,
          commandId: `goal_${request.requestId}_${index + 1}`,
        }));
        live = queuedCommands.every((queued) => queued !== null);
        for (const queued of queuedCommands) {
          if (queued) liveCompletions.push(queued.completion);
        }
      }
      if (!live && options.enqueueOfflineControl) {
        await options.enqueueOfflineControl({
          companyId,
          issueId,
          agentId: request.agentId,
          requestId: request.requestId,
          control: request,
        });
      }
      await db.update(agentSessionGoalActions).set({
        status: live ? "delivered" : "pending",
        deliveredAt: live ? new Date() : null,
        updatedAt: new Date(),
      }).where(and(
        eq(agentSessionGoalActions.sessionId, accepted.session.id),
        eq(agentSessionGoalActions.requestId, request.requestId),
        inArray(agentSessionGoalActions.status, ["pending", "delivering"]),
      ));
      if (live) {
        void Promise.all(liveCompletions).catch((error) =>
          failRunnerGoalAction(
            db,
            {
              companyId,
              issueId,
              agentId: request.agentId,
              adapterType: binding.agent!.adapterType,
            },
            request.requestId,
            error instanceof Error ? error.message : "live_goal_control_failed",
          )
        ).catch(() => undefined);
      }
    } catch (error) {
      await db.update(agentSessionGoalActions).set({
        status: "failed",
        error: error instanceof Error ? error.name : "goal_control_dispatch_failed",
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(agentSessionGoalActions.sessionId, accepted.session.id),
        eq(agentSessionGoalActions.requestId, request.requestId),
      ));
      throw error;
    }
    const current = await projection(companyId, issueId, request.agentId);
    if (!current) throw new RunnerGoalActionError("issue_not_found", "Issue not found.");
    publishLiveEvent({
      companyId,
      type: "agent.session.goal.changed",
      payload: current as unknown as Record<string, unknown>,
    });
    return { requestId: request.requestId, status: "accepted", projection: current };
  }

  return { projection, act };
}

function normalizedPrpGoal(value: unknown, workingNow: boolean): RunnerGoalSnapshot | null {
  const goal = asRecord(value);
  if (!goal || typeof goal.objective !== "string" || typeof goal.status !== "string") return null;
  if (![
    "active",
    "paused",
    "blocked",
    "limited",
    "usage_limited",
    "budget_limited",
    "complete",
  ].includes(goal.status)) return null;
  const objective = goal.objective.trim();
  if (!objective || objective.length > 4_000) return null;
  return {
    objective,
    status: goal.status as RunnerGoalSnapshot["status"],
    tokenBudget: typeof goal.tokenBudget === "number" ? goal.tokenBudget : null,
    tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0,
    elapsedSeconds: typeof goal.elapsedSeconds === "number" ? goal.elapsedSeconds : 0,
    iterations: typeof goal.iterations === "number" ? goal.iterations : 0,
    lastReason: typeof goal.lastReason === "string" ? goal.lastReason : null,
    createdAt: typeof goal.createdAt === "string" && goal.createdAt ? goal.createdAt : null,
    updatedAt: typeof goal.updatedAt === "string" && goal.updatedAt ? goal.updatedAt : null,
    completedAt: typeof goal.completedAt === "string" && goal.completedAt ? goal.completedAt : null,
    workingNow,
  };
}

/**
 * Commits the goal portion of a PRP event into the issue-scoped projection.
 * The provider source sequence is the resurrection fence for clear events and
 * makes replayed runner events harmless.
 */
export async function applyRunnerGoalPrpEvent(
  db: Db,
  binding: {
    companyId: string;
    issueId: string;
    agentId: string;
    adapterType: string;
  },
  event: {
    eventType: string;
    sourceInstanceId?: string;
    sourceRunId?: string;
    sourceSeq: number;
    payload: unknown;
  },
): Promise<RunnerGoalProjection | null> {
  if (![
    "session.capabilities.updated",
    "session.goal.snapshot",
    "session.goal.updated",
    "session.goal.cleared",
    "turn.started",
    "turn.completed",
    "turn.failed",
    "turn.interrupted",
    "turn.cancelled",
  ].includes(event.eventType)) return null;
  const payload = asRecord(event.payload) ?? {};
  const changed = await db.transaction(async (tx) => {
    await tx.insert(agentTaskSessions).values({
      companyId: binding.companyId,
      agentId: binding.agentId,
      adapterType: binding.adapterType,
      taskKey: binding.issueId,
    }).onConflictDoNothing();
    const [session] = await tx.select().from(agentTaskSessions).where(and(
      eq(agentTaskSessions.companyId, binding.companyId),
      eq(agentTaskSessions.agentId, binding.agentId),
      eq(agentTaskSessions.adapterType, binding.adapterType),
      eq(agentTaskSessions.taskKey, binding.issueId),
    )).limit(1).for("update");
    // runnerInstanceId is deliberately stable while a durable provider
    // session is resumed, but each PRP run owns a fresh source sequence. Use
    // the run as the sequence epoch so seq=1 in a successor heartbeat is not
    // mistaken for a replay from its predecessor.
    const sourceId = event.sourceInstanceId
      ? event.sourceRunId
        ? `${event.sourceInstanceId}:${event.sourceRunId}`
        : event.sourceInstanceId
      : undefined;
    const sameSource = !sourceId || session?.goalSourceId === sourceId;
    if (
      !session ||
      (sameSource && session.goalSourceCursor !== null && event.sourceSeq <= session.goalSourceCursor)
    ) {
      return false;
    }

    const capability = asRecord(payload.sessionGoals);
    const providerError = typeof payload.error === "string" && payload.error.length > 0;
    const turnLifecycleEvent = event.eventType.startsWith("turn.");
    const workingNow = event.eventType === "turn.started"
      ? true
      : turnLifecycleEvent
        ? false
        : payload.workingNow === true;
    let goal = providerError
      ? storedGoal(session)
      : turnLifecycleEvent
      ? storedGoal(session)
      : event.eventType === "session.goal.cleared"
        ? null
        : normalizedPrpGoal(payload.goal, workingNow);
    if (turnLifecycleEvent && goal) goal = { ...goal, workingNow };
    if (event.eventType === "session.goal.snapshot" && !goal) {
      const persistedGoal = storedGoal(session);
      const alreadyBlockedForMissingProviderGoal =
        persistedGoal?.status === "blocked" &&
        persistedGoal.lastReason === "provider_session_goal_missing_after_resume";
      if (persistedGoal?.status === "complete") {
        // Completed goals remain visible until an explicit clear or
        // replacement. An empty resume snapshot is not a clear event.
        goal = persistedGoal;
      } else if (persistedGoal) {
        goal = {
          ...persistedGoal,
          status: "blocked",
          workingNow: false,
          lastReason: "provider_session_goal_missing_after_resume",
          updatedAt: alreadyBlockedForMissingProviderGoal
            ? persistedGoal.updatedAt
            : new Date().toISOString(),
        };
      }
    }
    let completedPendingActionId: string | null = null;
    if (
      !providerError &&
      (event.eventType === "session.goal.updated" || event.eventType === "session.goal.cleared")
    ) {
      const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
      const [pending] = requestId
        ? await tx.select({
            id: agentSessionGoalActions.id,
            action: agentSessionGoalActions.action,
          }).from(agentSessionGoalActions).where(and(
            eq(agentSessionGoalActions.sessionId, session.id),
            inArray(agentSessionGoalActions.status, [...OPEN_ACTION_STATUSES]),
            eq(agentSessionGoalActions.requestId, requestId),
          )).limit(1)
        : [];
      const matches = pending && (
        event.eventType === "session.goal.updated"
          ? pending.action !== "clear"
          : pending.action === "clear"
      );
      if (pending && matches) completedPendingActionId = pending.id;
    }
    const writesGoal =
      (!providerError && event.eventType.startsWith("session.goal.")) ||
      (turnLifecycleEvent && goal);
    const nextDesiredState = !writesGoal
      ? session.goalDesiredState
      : event.eventType === "session.goal.cleared" || goal?.status === "complete"
        ? null
        : goal?.status === "active"
          ? "active"
          : goal
            ? "paused"
            : session.goalDesiredState;
    const projectionChanged =
      (capability !== null && !isDeepStrictEqual(asRecord(session.goalCapabilityJson), capability)) ||
      (Boolean(writesGoal) && !isDeepStrictEqual(storedGoal(session), goal)) ||
      nextDesiredState !== session.goalDesiredState ||
      completedPendingActionId !== null;
    const observedAt = new Date();
    const update: Partial<typeof agentTaskSessions.$inferInsert> = {
      goalSourceCursor: event.sourceSeq,
      ...(sourceId ? { goalSourceId: sourceId } : {}),
      goalObservedAt: observedAt,
      updatedAt: observedAt,
    };
    if (!projectionChanged) {
      await tx.update(agentTaskSessions).set(update).where(eq(agentTaskSessions.id, session.id));
      return false;
    }
    update.goalRevision = session.goalRevision + 1;
    if (capability) {
      update.goalCapabilityJson = capability;
    }
    if (writesGoal) {
      update.goalJson = goal as unknown as Record<string, unknown> | null;
      update.goalStatus = goal?.status ?? null;
      // Blocked and limited goals remain resumable, but must not be picked up
      // by the automatic active-goal recovery sweep until a user resumes.
      update.goalDesiredState = nextDesiredState;
    }
    await tx.update(agentTaskSessions).set(update).where(eq(agentTaskSessions.id, session.id));

    if (completedPendingActionId) {
      await tx.update(agentSessionGoalActions).set({
        status: "completed",
        completedAt: observedAt,
        updatedAt: observedAt,
      }).where(eq(agentSessionGoalActions.id, completedPendingActionId));
    }
    return true;
  });
  if (!changed) return null;
  const current = await runnerGoalService(db).projection(
    binding.companyId,
    binding.issueId,
    binding.agentId,
  );
  if (!current) return null;
  publishLiveEvent({
    companyId: binding.companyId,
    type: "agent.session.goal.changed",
    payload: current as unknown as Record<string, unknown>,
  });
  return current;
}

export async function failRunnerGoalAction(
  db: Db,
  binding: { companyId: string; issueId: string; agentId: string; adapterType: string },
  requestId: string,
  errorCode: string,
): Promise<RunnerGoalProjection | null> {
  const [session] = await db.select({ id: agentTaskSessions.id }).from(agentTaskSessions).where(and(
    eq(agentTaskSessions.companyId, binding.companyId),
    eq(agentTaskSessions.agentId, binding.agentId),
    eq(agentTaskSessions.adapterType, binding.adapterType),
    eq(agentTaskSessions.taskKey, binding.issueId),
  )).limit(1);
  if (!session) return null;
  await db.update(agentSessionGoalActions).set({
    status: "failed",
    error: errorCode.slice(0, 240),
    completedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(agentSessionGoalActions.sessionId, session.id),
    eq(agentSessionGoalActions.requestId, requestId),
  ));
  const current = await runnerGoalService(db).projection(
    binding.companyId,
    binding.issueId,
    binding.agentId,
  );
  if (current) {
    publishLiveEvent({
      companyId: binding.companyId,
      type: "agent.session.goal.changed",
      payload: current as unknown as Record<string, unknown>,
    });
  }
  return current;
}

export async function blockRunnerGoalRecovery(
  db: Db,
  binding: { companyId: string; issueId: string; agentId: string; adapterType: string },
  reason = "provider_session_goal_recovery_failed",
): Promise<RunnerGoalProjection | null> {
  const changed = await db.transaction(async (tx) => {
    const [session] = await tx.select().from(agentTaskSessions).where(and(
      eq(agentTaskSessions.companyId, binding.companyId),
      eq(agentTaskSessions.agentId, binding.agentId),
      eq(agentTaskSessions.adapterType, binding.adapterType),
      eq(agentTaskSessions.taskKey, binding.issueId),
    )).limit(1).for("update");
    const goal = storedGoal(session ?? null);
    if (!session || !goal || goal.status !== "active") return false;
    const now = new Date();
    await tx.update(agentTaskSessions).set({
      goalJson: {
        ...goal,
        status: "blocked",
        workingNow: false,
        lastReason: reason,
        updatedAt: now.toISOString(),
      },
      goalStatus: "blocked",
      goalDesiredState: "paused",
      goalRevision: session.goalRevision + 1,
      goalObservedAt: now,
      updatedAt: now,
    }).where(eq(agentTaskSessions.id, session.id));
    return true;
  });
  if (!changed) return null;
  const current = await runnerGoalService(db).projection(
    binding.companyId,
    binding.issueId,
    binding.agentId,
  );
  if (current) {
    publishLiveEvent({
      companyId: binding.companyId,
      type: "agent.session.goal.changed",
      payload: current as unknown as Record<string, unknown>,
    });
  }
  return current;
}

/**
 * Stops an unfinished goal through the controller that owns the live provider
 * session. Codex-style sessions pause; providers that only advertise clear
 * (currently Claude ACP) are cleared. The caller must not interrupt the process
 * until this function confirms the resulting projection.
 */
export async function settleLiveRunnerGoalBeforeInterrupt(
  db: Db,
  binding: { companyId: string; issueId: string; agentId: string },
): Promise<"paused" | "cleared" | "none"> {
  const goals = runnerGoalService(db);
  const current = await goals.projection(binding.companyId, binding.issueId, binding.agentId);
  if (!current?.goal || current.goal.status === "complete") return "none";
  if (current.goal.status === "paused") return "paused";
  const action = current.capability.actions.includes("pause")
    ? "pause" as const
    : current.capability.actions.includes("clear")
      ? "clear" as const
      : null;
  if (!action) {
    throw new RunnerGoalActionError(
      "runner_goal_stop_unsupported",
      "The live agent goal cannot be stopped safely.",
    );
  }

  const requestId = `interrupt_${randomUUID()}`;
  const adapterControl = dispatchLiveRunnerGoalControl(binding, { requestId, action });
  const nativeControl = adapterControl
    ? null
    : queueLiveRunnerPrpCommand({
        ...binding,
        type: action === "pause" ? "session.goal.set" : "session.goal.clear",
        payload: action === "pause"
          ? { requestId, status: "paused" }
          : { requestId },
        commandId: `goal_${requestId}`,
      });
  const completion = adapterControl?.completion ?? nativeControl?.completion ?? null;
  if (!completion) {
    throw new RunnerGoalActionError(
      "runner_goal_live_controller_unavailable",
      "The live agent goal controller is unavailable; the run was not interrupted.",
    );
  }
  await completion;

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const observed = await goals.projection(binding.companyId, binding.issueId, binding.agentId);
    if (action === "pause" && observed?.goal?.status === "paused") return "paused";
    if (action === "clear" && observed?.goal === null) return "cleared";
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new RunnerGoalActionError(
    "runner_goal_stop_unconfirmed",
    "The provider did not confirm that the live agent goal stopped.",
  );
}
