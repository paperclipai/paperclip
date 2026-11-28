import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { agents, connectionGrants, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { AI_CONNECTION_POOL_WAIT_RETRY_REASON } from "../../modules/run-dispatch/index.js";
import { aiRuntimeConnectionBindingSchema } from "@paperclipai/shared";
import {
  agentHasProviderLimitEvidence, agentProviderLimitCooldown, runProviderLimitCredential, runProviderQuotaScope, type ProviderLimitCredential,
} from "../native-runtime/native-startup-retry.js";

/** Plain words for the work a scoped quota serves. */
function quotaScopeLabel(scope: string): string {
  return scope === ANTIGRAVITY_CLI_QUOTA_SCOPE ? "Swarms" : "Some requests for this agent";
}
import { aiConnectionService } from "../ai-connections.js";
import { ANTIGRAVITY_CLI_QUOTA_SCOPE } from "../antigravity-swarm-refusal.js";
import { parseObject } from "../../adapters/utils.js";
import { logActivity, publishActivity } from "../activity-log.js";
import { notifyScheduledRetryDispatch } from "../run-dispatch-notifications.js";
import type { ActivityPublication } from "../../types/activity-publication.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;

export interface ProviderLimitWaitDependencies {
  setRunStatusIfRunning: (runId: string, status: "cancelled", patch: {
    error: string; errorCode: string; finishedAt: Date; resultJson: Record<string, unknown>;
  }) => Promise<{ updated: boolean; run?: HeartbeatRun | null }>;
  setWakeupStatus: (wakeupRequestId: string | null | undefined, status: "cancelled", patch: { finishedAt: Date; error: string }) => Promise<unknown>;
  appendRunEvent: (run: HeartbeatRun, event: {
    eventType: string; stream: "system"; level: "info" | "warn"; message: string; payload: Record<string, unknown>;
  }) => Promise<unknown>;
  scheduleBoundedRetryForRun: (run: HeartbeatRun, agent: Agent, opts: {
    now: Date; retryReason: string; wakeReason: string; maxAttempts: number; delayMs: number;
  }) => Promise<{ outcome: string }>;
  releaseIssueExecutionAndPromote: (run: HeartbeatRun) => Promise<unknown>;
  finalizeAgentStatus: (agentId: string, outcome: "cancelled") => Promise<unknown>;
  /**
   * How the run's SSH environment signs the harness in, as run admission
   * decides it, or "undecided" when only later preparation knows the
   * environment (a low-trust task's own environment).
   */
  sshAuthentication?: (agent: Agent, run: HeartbeatRun) => Promise<SshAuthentication | "undecided">;
  /**
   * The provider quota the pending run would draw on (PROVIDER_QUOTA_SCOPE_CONTEXT_KEY),
   * decided read-only before dispatch; null is the credential's default quota.
   */
  providerQuotaScope?: (agent: Agent, run: HeartbeatRun) => Promise<string | null>;
}

/** How an SSH environment signs the harness in; null when no SSH environment applies. */
export type SshAuthentication = "host" | "managed" | null;

/** Holds new work while the agent's provider account is out of allowance. */
export function createProviderLimitWait(db: Db, deps: ProviderLimitWaitDependencies) {
  const {
    setRunStatusIfRunning, setWakeupStatus, appendRunEvent, scheduleBoundedRetryForRun,
    releaseIssueExecutionAndPromote, finalizeAgentStatus,
  } = deps;

  /**
   * An agent whose provider account recently reported an exhausted allowance
   * would fail new work the same way. Before any workspace or provider work,
   * hold the wake until the reported reset and retry it then. A manual run, a
   * recovering run, a conversation turn, and pool routing (which selects
   * another account) still start, so an operator can always test a repair.
   */
  async function deferRunForProviderLimit(
    run: HeartbeatRun,
    agent: Agent,
    options: {
      resumingAdmittedRun: boolean; conversation: boolean;
      /** Set once dispatch has chosen the run's environment. */
      sshAuthentication?: SshAuthentication;
    },
  ): Promise<boolean> {
    if (options.resumingAdmittedRun || options.conversation) return false;
    if (run.invocationSource === "on_demand" && run.triggerDetail === "manual") return false;
    if (parseObject(parseObject(agent.runtimeConfig).aiConnection).mode === "router") return false;
    const now = new Date();
    // The limit belongs to the credential it was reported on. A run that would
    // use another account, or whose limited account was revoked, is not held.
    // Most agents have no live limit, so resolving the account waits for one.
    let quotaScope: string | null = null;
    const cooldown = await agentHasProviderLimitEvidence(db, {
      companyId: run.companyId, agentId: run.agentId, runId: run.id, now,
    }).then(async limited => {
      if (!limited) return null;
      quotaScope = deps.providerQuotaScope ? await deps.providerQuotaScope(agent, run) : runProviderQuotaScope(run.contextSnapshot, run.runnerProfileJson);
      const ssh = options.sshAuthentication !== undefined ? options.sshAuthentication
        : deps.sshAuthentication ? await deps.sshAuthentication(agent, run) : null;
      // Dispatch checks again once the environment, and so the account, is known.
      if (ssh === "undecided") return null;
      return agentProviderLimitCooldown(db, {
        companyId: run.companyId, agentId: run.agentId, runId: run.id, now,
        credential: await agentProviderLimitCredential(db, agent, run.responsibleUserId, ssh),
        quotaScope,
      });
    }).catch((err: unknown) => {
      // Missing evidence must not stop work; the provider still reports its own limit.
      logger.warn({ err, runId: run.id }, "provider limit evidence unavailable before dispatch");
      return null;
    });
    if (!cooldown) return false;
    const resetAt = cooldown.resetAt.toISOString();
    const message = quotaScope !== null
      // A limit on a separate quota (such as Google's Antigravity CLI for swarms) holds only that kind of work.
      ? `${quotaScopeLabel(quotaScope)} are out of quota for now. Paperclip will try again after ${resetAt}; other work on this agent continues.`
      : cooldown.resetReported
      ? `This agent's provider usage limit has a reported reset at ${resetAt}. Work is held; a retry must recheck availability before starting work.`
      : `This agent's provider usage limit has no reported reset time. Work is held; a retry can recheck availability after ${resetAt}; the limit may still apply then.`;
    const cancelled = await setRunStatusIfRunning(run.id, "cancelled", {
      error: message, errorCode: "provider_limit_wait", finishedAt: now,
      resultJson: {
        executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false },
        providerLimitWait: {
          resetAt, resetReported: cooldown.resetReported, category: cooldown.category,
          sourceRunId: cooldown.sourceRunId, grantId: cooldown.grantId, actionUrl: `/agents/${agent.id}/runtime`,
          ...(quotaScope !== null ? { quotaScope } : {}),
        },
        cancellation: {
          source: "control_plane", expected: true, initiator: { type: "system" },
          reason: "Waiting for the agent's provider usage limit to reset", recordedAt: now.toISOString(),
        },
        retryAt: resetAt,
      },
    });
    if (!cancelled.updated) return true;
    const deferred = cancelled.run ?? run;
    // The cancellation is committed. From here the wake must either gain its
    // retry or release its task lock; diagnostics never decide that.
    let scheduled = false;
    try {
      // Scheduling is idempotent per source run, so one more attempt is safe.
      for (let attempt = 1; attempt <= 2 && !scheduled; attempt += 1) {
        try {
          // Each wait is one retry at the reset; evidence expires within a day.
          const retry = await scheduleBoundedRetryForRun(deferred, agent, {
            now, retryReason: AI_CONNECTION_POOL_WAIT_RETRY_REASON, wakeReason: "provider_limit_retry",
            maxAttempts: (run.scheduledRetryAttempt ?? 0) + 1,
            delayMs: Math.max(1000, cooldown.resetAt.getTime() - now.getTime() + 1000),
          });
          scheduled = retry.outcome === "scheduled";
          if (!scheduled) break;
        } catch (err) {
          logger.warn({ err, runId: run.id, attempt }, "failed to schedule the provider limit retry");
        }
      }
      await appendRunEvent(deferred, {
        eventType: "lifecycle", stream: "system", level: scheduled ? "info" : "warn",
        message: scheduled
          ? `Waiting to recheck the provider usage limit after ${resetAt} before starting work`
          : "Waiting for provider availability; this wake could not schedule its recheck and released the task",
        payload: { resetAt, resetReported: cooldown.resetReported, category: cooldown.category, sourceRunId: cooldown.sourceRunId, retryScheduled: scheduled },
      }).catch((err: unknown) => logger.warn({ err, runId: run.id }, "failed to record the provider limit wait"));
      await setWakeupStatus(run.wakeupRequestId, "cancelled", { finishedAt: now, error: message })
        .catch((err: unknown) => logger.warn({ err, runId: run.id }, "failed to settle the provider limit wakeup"));
    } finally {
      try {
        if (!scheduled) await releaseIssueExecutionAndPromote(deferred);
      } finally {
        await finalizeAgentStatus(run.agentId, "cancelled");
      }
    }
    return true;
  }

  return { deferRunForProviderLimit };
}

/**
 * The account the agent's next run would use, chosen by the same selection a
 * run makes when it starts.
 */
async function agentProviderLimitCredential(
  db: Db, agent: Agent, responsibleUserId: string | null, ssh: SshAuthentication,
): Promise<ProviderLimitCredential> {
  const saved = parseObject(agent.runtimeConfig).aiConnection;
  if (saved === undefined || saved === null) return { kind: "host" };
  // Run admission ignores the saved account when the harness uses the host's
  // own sign-in: an SSH host that keeps its login, or a preconfigured home.
  if (ssh === "host" || (ssh !== "managed" && agent.adapterType === "paperclip_runner"
    && parseObject(agent.adapterConfig).homeMode === "preconfigured")) return { kind: "host" };
  const parsed = aiRuntimeConnectionBindingSchema.safeParse(saved);
  if (!parsed.success || parsed.data.mode === "router") return { kind: "unresolved" };
  const binding = parsed.data;
  const config = parseObject(agent.adapterConfig);
  try {
    const selection = await aiConnectionService(db).select({
      companyId: agent.companyId, agentId: agent.id, userId: responsibleUserId, adapterType: agent.adapterType,
      model: config.model, runnerProvider: config.provider, acpxAgent: config.acpxAgent, binding,
    });
    return { kind: "grants", grantIds: [selection.grant.id] };
  } catch {
    // A run that cannot select an account fails on its own setup check. An
    // explicit binding still names the account that check would use.
    if (binding.mode !== "responsible_user") return { kind: "grants", grantIds: [binding.grantId] };
    // The run can use only its own user's accounts, so another user's limit never holds it.
    return { kind: "grants", grantIds: responsibleUserId ? await personalGrantIds(db, agent.companyId, responsibleUserId) : [] };
  }
}

async function personalGrantIds(db: Db, companyId: string, userId: string): Promise<string[]> {
  const rows = await db.select({ id: connectionGrants.id }).from(connectionGrants).where(and(
    eq(connectionGrants.companyId, companyId), eq(connectionGrants.kind, "user"), eq(connectionGrants.subjectUserId, userId),
  ));
  return rows.map(row => row.id);
}

export type ProviderLimitWaitRelease =
  /** The agent's AI connection changed, so its next run may use another account. */
  | "ai_connection_changed"
  /** An account was revoked or removed, so limits reported on it no longer apply. */
  | "ai_connection_revoked"
  /** Someone replied on the task; the reply rechecks the wait now. */
  | "user_reply";

/**
 * Makes waiting provider limit retries due now, so each rechecks availability
 * through the normal dispatch path. The recheck reads only saved evidence and
 * holds the run again, with no provider work, when the same account is still
 * out of allowance. A user reply also rechecks a connection pool wait.
 */
export async function releaseProviderLimitWaits(db: Db, input: {
  companyId: string;
  reason: ProviderLimitWaitRelease;
  agentId?: string;
  /** A specific waiting retry. */
  runId?: string;
  /** Only waits whose limit was reported on one of these grants. */
  grantIds?: readonly string[];
  actor?: { actorType: "user" | "agent" | "system" | "plugin"; actorId: string };
  publications?: ActivityPublication[];
  now?: Date;
}): Promise<string[]> {
  if (input.grantIds && input.grantIds.length === 0) return [];
  const now = input.now ?? new Date();
  const waitRun = alias(heartbeatRuns, "provider_limit_wait_run");
  const candidates = await db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
      limitGrantId: sql<string | null>`${waitRun.resultJson} #>> '{providerLimitWait,grantId}'`,
      sourceRunId: sql<string | null>`${waitRun.resultJson} #>> '{providerLimitWait,sourceRunId}'`,
    })
    .from(heartbeatRuns)
    .innerJoin(waitRun, and(eq(waitRun.id, heartbeatRuns.retryOfRunId), eq(waitRun.companyId, heartbeatRuns.companyId)))
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.status, "scheduled_retry"),
      eq(heartbeatRuns.scheduledRetryReason, AI_CONNECTION_POOL_WAIT_RETRY_REASON),
      gt(heartbeatRuns.scheduledRetryAt, now),
      ...(input.agentId ? [eq(heartbeatRuns.agentId, input.agentId)] : []),
      ...(input.runId ? [eq(heartbeatRuns.id, input.runId)] : []),
      // A pool wait rechecks only on a reply; an account change cannot free a pool.
      input.reason === "user_reply"
        ? inArray(waitRun.errorCode, ["provider_limit_wait", "ai_connection_pool_exhausted"])
        : eq(waitRun.errorCode, "provider_limit_wait"),
    ));
  let released = candidates;
  if (input.grantIds) {
    // Waits saved before the grant was recorded on them name their evidence run.
    const sourceRunIds = candidates.flatMap(row => !row.limitGrantId && row.sourceRunId && UUID.test(row.sourceRunId) ? [row.sourceRunId] : []);
    const sources = sourceRunIds.length === 0 ? [] : await db
      .select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.id, sourceRunIds)));
    const sourceGrant = new Map(sources.map(source => {
      const credential = runProviderLimitCredential(source.contextSnapshot);
      return [source.id, credential.kind === "grants" ? credential.grantIds[0] : null] as const;
    }));
    released = candidates.filter(row => {
      const grantId = row.limitGrantId ?? (row.sourceRunId ? sourceGrant.get(row.sourceRunId) : null);
      return Boolean(grantId && input.grantIds!.includes(grantId));
    });
  }
  if (released.length === 0) return [];
  const recheck = { reason: input.reason, requestedAt: now.toISOString() };
  // Inside a caller's transaction its publications commit with it; otherwise
  // this release publishes its own after its commit.
  const publications = input.publications ?? [];
  const releasedIds = await db.transaction(async tx => {
    // Dispatch learns of the due retries before they are written, so drain and
    // sleep account for them; the notice commits only with the write.
    await notifyScheduledRetryDispatch(tx, { companyId: input.companyId });
    const updated = await tx.update(heartbeatRuns)
      .set({
        scheduledRetryAt: now,
        contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ scheduledRetryAt: now.toISOString(), providerLimitRecheck: recheck })}::jsonb`,
        updatedAt: now,
      })
      .where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        inArray(heartbeatRuns.id, released.map(row => row.id)),
        eq(heartbeatRuns.status, "scheduled_retry"),
        gt(heartbeatRuns.scheduledRetryAt, now),
      ))
      .returning({ id: heartbeatRuns.id });
    if (updated.length === 0) return [];
    const updatedIds = new Set(updated.map(row => row.id));
    for (const row of released.filter(candidate => updatedIds.has(candidate.id))) {
      await logActivity(tx as unknown as Db, {
        companyId: input.companyId,
        actorType: input.actor?.actorType ?? "system",
        actorId: input.actor?.actorId ?? "provider-limit-wait",
        agentId: row.agentId,
        runId: row.id,
        action: "issue.scheduled_retry_retry_now",
        entityType: row.issueId ? "issue" : "heartbeat_run",
        entityId: row.issueId ?? row.id,
        details: { source: "provider_limit_recheck", reason: input.reason },
      }, publications);
    }
    return [...updatedIds];
  });
  if (!input.publications) publications.forEach(publishActivity);
  return releasedIds;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
