import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, lt, lte, or, sql } from "drizzle-orm";
import {
  agents, authUsers, budgetPolicies, budgetReservations, companies, companyMemberships, companyDecisionModels, costEvents,
  decisionInvocations, heartbeatRuns, issues, projects, companySecrets, type Db,
} from "@paperclipai/db";
import {
  DECISION_MODELS, decisionProviderForConnection, decisionRequestSchema, updateDecisionModelSchema,
  centsToUnits, unitsToCents, type DecisionAvailability, type DecisionConnectionChoice, type DecisionHistoryEntry,
  type DecisionModelSettings, type DecisionProvider, type DecisionRequest, type DecisionResult, type DecisionUnavailableReason, type UpdateDecisionModel,
} from "@paperclipai/shared";
import { HttpError, forbidden, unprocessable } from "../errors.js";
import { aiConnectionService } from "./ai-connections.js";
import { accessService } from "./access.js";
import { type AuthorizationActor } from "./authorization.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { budgetPoliciesForRun, budgetService, budgetServiceInTransaction, computeObservedSpend, type BudgetServiceHooks } from "./budgets.js";
import { createCostEventInTransaction } from "./costs.js";
import { logActivity } from "./activity-log.js";
import { decisionReceipt, runDecisionProvider, type DecisionProviderOutcome } from "./decision-model-provider.js";

const registeredFeatures = new WeakSet<object>();
/** Register once in a server module. Feature handles cannot be supplied over JSON/API. */
export function defineDecisionFeature(id: string, options: { background?: boolean } = {}) {
  if (!/^[a-z][a-z0-9_.-]{0,99}$/.test(id)) throw new Error("Invalid decision feature identifier");
  const feature = Object.freeze({ id, background: options.background === true });
  registeredFeatures.add(feature);
  return feature;
}
export const settingsDecisionTest = defineDecisionFeature("settings.test");
export interface DecisionContext {
  companyId: string;
  feature: ReturnType<typeof defineDecisionFeature>;
  actor: AuthorizationActor | { type: "system" };
  issueId?: string;
  projectId?: string;
}
class DecisionUnavailable extends Error {
  constructor(readonly reason: DecisionUnavailableReason) { super(reason); }
}
function unavailableReason(error: unknown): DecisionUnavailableReason | null {
  if (error instanceof DecisionUnavailable) return error.reason;
  if (error instanceof HttpError) {
    if (error.status === 403 || error.status === 404) return "access_denied";
    if (error.status === 422) {
      return (error.details as { code?: string } | undefined)?.code === "incompatible_connection" ? "incompatible_connection" : "connection_unavailable";
    }
  }
  return null;
}

export function decisionModelService(db: Db, options: { provider?: typeof runDecisionProvider; budgetHooks?: BudgetServiceHooks } = {}) {
  const providerCall = options.provider ?? runDecisionProvider;
  async function settings(companyId: string): Promise<DecisionModelSettings> {
    const [row] = await db.select().from(companyDecisionModels).where(eq(companyDecisionModels.companyId, companyId));
    return row ? { ...row, provider: row.provider as DecisionProvider | null } : {
      companyId, enabled: false, allowBackground: true, connectionId: null, grantId: null, provider: null, model: null,
    };
  }
  async function choices(companyId: string, userId: string): Promise<DecisionConnectionChoice[]> {
    const connections = aiConnectionService(db);
    if (!(await connections.membership(companyId, userId))) throw forbidden();
    return (await connections.list(companyId, userId)).flatMap(row => {
      const provider = decisionProviderForConnection(row);
      return provider && row.ownership === "shared" ? [{ ...row, decisionModel: DECISION_MODELS[provider].id }] : [];
    });
  }
  async function configure(companyId: string, userId: string, input: UpdateDecisionModel) {
    const data = updateDecisionModelSchema.parse(input);
    return withAccountingTransaction(db, companyId, async (tx, publications) => {
      const [previous] = await tx.select().from(companyDecisionModels).where(eq(companyDecisionModels.companyId, companyId));
      // Managers can always turn off a broken/revoked connection without acquiring it.
      const disabling = !data.enabled && previous?.connectionId === data.connectionId && previous?.grantId === data.grantId;
      const row = !disabling && data.connectionId && data.grantId ? await aiConnectionService(tx).selectDecision({ companyId,
        userId, connectionId: data.connectionId, grantId: data.grantId }) : null;
      const provider = (disabling ? previous?.provider : row?.provider) as DecisionProvider | null | undefined;
      const values = { ...data, allowBackground: data.allowBackground ?? previous?.allowBackground ?? true, companyId, provider: provider ?? null, model: provider ? DECISION_MODELS[provider].id : null, updatedAt: new Date() };
      await tx.insert(companyDecisionModels).values(values).onConflictDoUpdate({ target: companyDecisionModels.companyId, set: values });
      await logActivity(tx, { companyId, actorType: "user", actorId: userId, action: "decision_model.configured", entityType: "company", entityId: companyId,
        details: { ...data, provider: values.provider, model: values.model } }, publications);
      return values;
    });
  }
  async function resolve(context: DecisionContext, executor = db) {
    if (!registeredFeatures.has(context.feature)) throw forbidden("A registered decision feature is required");
    const [config] = await executor.select().from(companyDecisionModels).where(eq(companyDecisionModels.companyId, context.companyId));
    if (!config?.connectionId || !config.grantId) throw new DecisionUnavailable("not_configured");
    if (!config.enabled) throw new DecisionUnavailable("disabled");
    let userId: string | null = null, agentId: string | null = null, runId: string | null = null, identityContextId: string | null = null;
    let issueId = context.issueId ?? null;
    let actor = context.actor;
    if (actor.type === "system") {
      if (!context.feature.background || !config.allowBackground) throw new DecisionUnavailable("background_disabled");
    } else if (actor.type === "agent") {
      if (!actor.agentId || !actor.runId || actor.companyId !== context.companyId) throw forbidden();
      const [run] = await executor.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, context.companyId), eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.agentId, actor.agentId)));
      if (!run || run.status !== "running") throw forbidden("An active run is required");
      agentId = run.agentId; runId = run.id; userId = run.responsibleUserId; identityContextId = run.activeIdentityContextId;
      const runIssue = run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId;
      if (issueId && issueId !== runIssue) throw forbidden("Task does not belong to this run");
      issueId = typeof runIssue === "string" ? runIssue : null;
      const memberships = userId ? await executor.select({ companyId: companyMemberships.companyId, membershipRole: companyMemberships.membershipRole, status: companyMemberships.status })
        .from(companyMemberships).where(and(eq(companyMemberships.companyId, context.companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId))) : [];
      actor = { ...actor, onBehalfOfUserId: userId, onBehalfOfMemberships: memberships };
    } else if (actor.type === "board") userId = actor.userId ?? (actor.source === "local_implicit" ? "local-board" : null);
    else throw forbidden();
    if (actor.type !== "system" && !userId) throw new DecisionUnavailable("responsible_user_missing");
    const [issue] = issueId ? await executor.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, context.companyId))) : [];
    if (issueId && !issue) throw forbidden();
    if (issue && context.projectId && context.projectId !== issue.projectId) throw forbidden("Task project mismatch");
    const projectId = issue?.projectId ?? context.projectId ?? null;
    if (projectId) {
      const [project] = await executor.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, context.companyId)));
      if (!project) throw forbidden();
    }
    if (actor.type !== "system") {
      const access = accessService(executor);
      const accessResult = await access.decide({ actor, action: issue ? "issue:read" : projectId ? "project:read" : "company_scope:read",
        resource: issue ? { type: "issue", companyId: context.companyId, issueId: issue.id, projectId: issue.projectId, parentIssueId: issue.parentId,
          assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId, status: issue.status }
          : projectId ? { type: "project", companyId: context.companyId, projectId } : { type: "company", companyId: context.companyId } });
      if (!accessResult.allowed) throw forbidden();
    }
    const connection = await aiConnectionService(executor).selectDecision({ companyId: context.companyId,
      connectionId: config.connectionId, grantId: config.grantId, userId, agentId, sponsoredBackground: actor.type === "system" });
    if (connection.provider !== config.provider || config.model !== DECISION_MODELS[connection.provider].id) throw new DecisionUnavailable("incompatible_connection");
    return { config, connection, userId, agentId, runId, identityContextId, issueId, projectId,
      actorType: actor.type === "board" ? "user" as const : actor.type === "agent" ? "agent" as const : "system" as const,
      actorId: actor.type === "system" ? "paperclip-decisions" : agentId ?? userId! };
  }
  async function availability(context: DecisionContext): Promise<DecisionAvailability> {
    try { await resolve(context); return { available: true }; }
    catch (error) { const reason = unavailableReason(error); if (reason) return { available: false, reason }; throw error; }
  }
  /** Callers may memoize within their request; dispatch never consumes a cached authorization. */
  function availabilityForRequest() {
    const cache = new Map<DecisionContext, Promise<DecisionAvailability>>();
    return (context: DecisionContext) => { let result = cache.get(context); if (!result) { result = availability(context); cache.set(context, result); } return result; };
  }
  async function settle(invocation: typeof decisionInvocations.$inferSelect, outcome: DecisionProviderOutcome) {
    await withAccountingTransaction(db, invocation.companyId, async (tx, publications) => {
      const [current] = await tx.select().from(decisionInvocations).where(and(eq(decisionInvocations.companyId, invocation.companyId), eq(decisionInvocations.id, invocation.id))).for("update");
      if (!current || current.status !== "running") return;
      const receipt = outcome.receipt;
      // Keep dispatch identity on the invocation even if its task or agent was
      // deleted while the provider worked. Ledger foreign keys use live rows.
      const links: { agentId: string | null; issueId: string | null; projectId: string | null } = { agentId: null, issueId: null, projectId: null };
      for (const [key, table] of [["agentId", agents], ["issueId", issues], ["projectId", projects]] as const) {
        const id = invocation[key];
        if (!id) continue;
        const [row] = await tx.select({ id: table.id }).from(table).where(and(eq(table.id, id), eq(table.companyId, invocation.companyId))).for("key share");
        if (row) links[key] = row.id;
      }
      const event = await createCostEventInTransaction(tx, invocation.companyId, {
        usageKind: "decision", responsibleUserId: invocation.responsibleUserId, ...links,
        // Run attribution lives on the invocation. Run receipt reconciliation must not ingest this independent charge.
        heartbeatRunId: null, idempotencyKey: `decision:${invocation.id}`,
        provider: invocation.provider === "openrouter" ? "typesafe" : "openai", biller: invocation.provider,
        billingType: "metered_api", costStatus: receipt.costStatus, model: invocation.model,
        inputTokens: receipt.inputTokens ?? 0, outputTokens: receipt.outputTokens ?? 0, costCents: receipt.costCents ?? "0",
        providerRequestId: receipt.providerRequestId, pricingProvenance: receipt.pricingProvenance, occurredAt: invocation.startedAt,
      }, publications, { actorType: invocation.actorType as "system" | "user" | "agent", actorId: invocation.actorId, agentId: links.agentId });
      const finishedAt = new Date();
      await tx.update(decisionInvocations).set({ status: outcome.answers ? "succeeded" : receipt.costStatus === "unpriced" ? "unknown" : "failed",
        errorCode: outcome.errorCode ?? null, costEventId: event.id, providerRequestId: receipt.providerRequestId,
        inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, finishedAt, durationMs: Math.max(0, finishedAt.getTime() - invocation.startedAt.getTime()),
      }).where(eq(decisionInvocations.id, invocation.id));
      if (receipt.costStatus !== "unpriced") await tx.update(budgetReservations).set({ state: outcome.noProviderWork ? "released" : "settled", settledAt: finishedAt }).where(and(
        eq(budgetReservations.companyId, invocation.companyId), eq(budgetReservations.decisionInvocationId, invocation.id), eq(budgetReservations.state, "held"),
      ));
    });
    await budgetService(db, options.budgetHooks).deliverPendingEnforcement(invocation.companyId);
  }
  async function decide(context: DecisionContext, request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
    const parsed = decisionRequestSchema.safeParse(request);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > 32_000) throw unprocessable("Decisions require 1–20 valid questions and at most 32 KB of text/JSON");
    let selected: Awaited<ReturnType<typeof resolve>>;
    try { selected = await resolve(context); }
    catch (error) { const reason = unavailableReason(error); if (reason) return { status: "unavailable", reason }; throw error; }
    const secretId = selected.connection.grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential")?.secretId;
    const [credentialSnapshot] = secretId ? await db.select({ id: companySecrets.id, status: companySecrets.status, version: companySecrets.latestVersion })
      .from(companySecrets).where(and(eq(companySecrets.companyId, context.companyId), eq(companySecrets.id, secretId))) : [];
    if (!credentialSnapshot || credentialSnapshot.status !== "active") return { status: "unavailable", reason: "connection_unavailable" };
    let credential: string;
    try { credential = await aiConnectionService(db).credential(selected.connection, 0, { responsibleUserId: selected.userId,
      actorType: selected.actorType, actorId: selected.actorId, issueId: selected.issueId, heartbeatRunId: selected.runId }); }
    catch (error) { return { status: "unavailable", reason: unavailableReason(error) ?? "connection_unavailable" }; }
    const admission = await withAccountingTransaction(db, context.companyId, async (tx, publications) => {
      let current: Awaited<ReturnType<typeof resolve>>;
      try { current = await resolve(context, tx); }
      catch (error) { const reason = unavailableReason(error); if (reason) return { reason }; throw error; }
      // A different setting or steering identity requires a fresh credential acquisition.
      if (current.config.updatedAt.getTime() !== selected.config.updatedAt.getTime() || current.userId !== selected.userId || current.identityContextId !== selected.identityContextId
        || current.connection.grant.updatedAt.getTime() !== selected.connection.grant.updatedAt.getTime()
        || current.connection.connection.updatedAt.getTime() !== selected.connection.connection.updatedAt.getTime())
        return { reason: "connection_unavailable" as const };
      // Secret changes do not update the connection revision. Serialize against
      // rotation/revocation through admission, including time spent waiting for
      // the accounting lock after credential resolution.
      const [currentSecret] = await tx.select({ status: companySecrets.status, version: companySecrets.latestVersion }).from(companySecrets)
        .where(and(eq(companySecrets.companyId, context.companyId), eq(companySecrets.id, credentialSnapshot.id))).for("share");
      if (!currentSecret || currentSecret.status !== "active" || currentSecret.version !== credentialSnapshot.version)
        return { reason: "connection_unavailable" as const };
      const budgets = budgetServiceInTransaction(tx, publications);
      const block = await budgets.getInvocationBlock(context.companyId, current.agentId, { projectId: current.projectId });
      const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, context.companyId));
      const [agent] = current.agentId ? await tx.select({ status: agents.status }).from(agents).where(and(eq(agents.id, current.agentId), eq(agents.companyId, context.companyId))) : [];
      if (block || company.status !== "active" || (current.agentId && (!agent || agent.status === "paused" || agent.status === "terminated"))) return { reason: "budget_blocked" as const };
      const policies = await tx.select().from(budgetPolicies).where(and(eq(budgetPolicies.companyId, context.companyId), eq(budgetPolicies.isActive, true),
        eq(budgetPolicies.hardStopEnabled, true), eq(budgetPolicies.metric, "billed_cents"), sql`${budgetPolicies.amount} > 0`, budgetPoliciesForRun(context.companyId, current.agentId, current.projectId)));
      const amount = policies.reduce((max, p) => { const n = centsToUnits(p.reservationCents); return n > max ? n : max; }, 0n);
      for (const policy of policies) {
        const [held] = await tx.select({ total: sql<string>`coalesce(sum(${budgetReservations.amountCents}),0)::text` }).from(budgetReservations).where(and(
          eq(budgetReservations.companyId, context.companyId), eq(budgetReservations.state, "held"),
          policy.scopeType === "agent" ? eq(budgetReservations.agentId, current.agentId!) : undefined,
          policy.scopeType === "project" ? eq(budgetReservations.projectId, current.projectId!) : undefined,
        ));
        const committed = centsToUnits((await computeObservedSpend(tx, policy)).totalExact) + centsToUnits(held.total);
        if (committed >= centsToUnits(policy.amount) || committed + amount > centsToUnits(policy.amount)) return { reason: "budget_blocked" as const };
      }
      signal?.throwIfAborted();
      const [invocation] = await tx.insert(decisionInvocations).values({ id: randomUUID(), companyId: context.companyId, feature: context.feature.id,
        actorType: current.actorType, actorId: current.actorId, responsibleUserId: current.userId, agentId: current.agentId,
        issueId: current.issueId, projectId: current.projectId, runId: current.runId, identityContextId: current.identityContextId,
        connectionId: current.connection.connection.id, grantId: current.connection.grant.id, provider: current.connection.provider, model: current.config.model!,
        questionTypes: Object.values(parsed.data.questions).map(q => q.type),
      }).returning();
      await tx.insert(budgetReservations).values({ companyId: context.companyId, decisionInvocationId: invocation.id, agentId: current.agentId,
        projectId: current.projectId, amountCents: unitsToCents(amount), providerStartedAt: invocation.startedAt });
      return { invocation };
    });
    if (admission.reason) return { status: "unavailable", reason: admission.reason };
    const invocation = admission.invocation!;
    let outcome: DecisionProviderOutcome;
    try { outcome = await providerCall({ provider: selected.connection.provider, model: invocation.model, apiKey: credential,
      request: parsed.data, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }); }
    catch { outcome = { errorCode: "provider_failed", receipt: decisionReceipt(selected.connection.provider, null) }; }
    await settle(invocation, outcome);
    const { inputTokens, outputTokens, costCents, costStatus } = outcome.receipt;
    const usage = { inputTokens, outputTokens, costCents, costStatus };
    return outcome.answers ? { status: "succeeded", invocationId: invocation.id, answers: outcome.answers, usage }
      : { status: "failed", invocationId: invocation.id, errorCode: outcome.errorCode ?? "provider_failed", usage };
  }
  async function recoverInterrupted() {
    const stale = await db.select().from(decisionInvocations).where(and(eq(decisionInvocations.status, "running"), lt(decisionInvocations.startedAt, new Date(Date.now() - 120_000)))).limit(100);
    for (const invocation of stale) await settle(invocation, { errorCode: "interrupted", receipt: decisionReceipt(invocation.provider as DecisionProvider, null) });
    return stale.length;
  }
  async function history(companyId: string, actor: AuthorizationActor, range: { from?: Date; to?: Date; before?: Date; limit?: number } = {}): Promise<DecisionHistoryEntry[]> {
    const access = accessService(db);
    if (!(await access.decide({ actor, action: "company_scope:read", resource: { type: "company", companyId } })).allowed) throw forbidden();
    const rows = await db.select({ invocation: decisionInvocations, userName: authUsers.name,
      inputTokens: costEvents.inputTokens, outputTokens: costEvents.outputTokens, costStatus: costEvents.costStatus,
      costCents: sql<string | null>`${costEvents.costCents}::text`, issue: issues,
    }).from(decisionInvocations).leftJoin(costEvents, and(eq(costEvents.id, decisionInvocations.costEventId), eq(costEvents.companyId, companyId)))
      .leftJoin(authUsers, eq(authUsers.id, decisionInvocations.responsibleUserId))
      .leftJoin(issues, and(eq(issues.id, decisionInvocations.issueId), eq(issues.companyId, companyId)))
      .where(and(eq(decisionInvocations.companyId, companyId), range.from ? gte(decisionInvocations.startedAt, range.from) : undefined,
        range.to ? lte(decisionInvocations.startedAt, range.to) : undefined, range.before ? lt(decisionInvocations.startedAt, range.before) : undefined))
      .orderBy(desc(decisionInvocations.startedAt), desc(decisionInvocations.id)).limit(Math.min(range.limit ?? 100, 500));
    return Promise.all(rows.map(async ({ invocation: row, issue, ...cost }) => {
      const visible = issue && (await access.decide({ actor, action: "issue:read", resource: { type: "issue", companyId, issueId: issue.id,
        projectId: issue.projectId, parentIssueId: issue.parentId, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId, status: issue.status } })).allowed;
      return { id: row.id, feature: row.feature, actorType: row.actorType, responsibleUserId: row.responsibleUserId, userName: cost.userName,
        issueId: visible ? issue.id : null, issueIdentifier: visible ? issue.identifier : null, agentId: row.agentId, runId: visible ? row.runId : null,
        connectionId: row.connectionId, provider: row.provider, model: row.model, status: row.status, errorCode: row.errorCode,
        startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null, durationMs: row.durationMs,
        inputTokens: row.inputTokens, outputTokens: row.outputTokens,
        costCents: cost.costStatus === "unpriced" ? null : cost.costCents, costStatus: cost.costStatus };
    }));
  }
  return { settings, choices, configure, availability, availabilityForRequest, decide, recoverInterrupted, history };
}
