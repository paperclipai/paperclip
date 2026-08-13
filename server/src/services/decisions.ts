import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships, decisionBundles, decisionEffectExecutions, decisionRetention, decisions, decisionTargetIssues, heartbeatRuns, issueRelations, issues } from "@paperclipai/db";
import { ATTENTION_SOURCE_KINDS, decisionEffectTargetIssueIds } from "@paperclipai/shared";
import type { AttentionArchiveManifestEntry, DecisionEffect, DecisionInput, DecisionOption, DecisionStatsCounts, DecisionStatsResponse } from "@paperclipai/shared";
import { conflict, forbidden, notFound, tooManyRequests, unprocessable } from "../errors.js";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { signDecisionSpec, verifyDecisionSpec } from "./decision-signing.js";
import { issueService } from "./issues.js";
import { decisionRetentionService, hashAttentionArchiveManifest } from "./decision-retention.js";

type Snapshot = { status: string; assigneeAgentId: string | null; assigneeUserId: string | null; updatedAt: string;
  descendantCount?: number; descendantIds?: string[]; childCount?: number; attentionArchive?: unknown };
type Wake = (input: { companyId: string; agentId: string; issueId: string; decisionId: string; outcome: "decided" | "expired" | "cancelled" }) => Promise<unknown>;
export type DecisionServiceOptions = { wakeOriginAgent: Wake };
const DAY = 86_400_000;

function targetIds(options: DecisionOption[]) {
  const result = new Set<string>();
  for (const option of options) for (const effect of option.effects) for (const id of decisionEffectTargetIssueIds(effect)) result.add(id);
  return [...result];
}

function targetActions(options: DecisionOption[]) {
  const result = new Map<string, Set<"issue:comment" | "issue:mutate">>();
  for (const option of options) for (const effect of option.effects) {
    const action = effect.type === "comment_on_issue" ? "issue:comment" as const : "issue:mutate" as const;
    for (const id of decisionEffectTargetIssueIds(effect)) {
      const actions = result.get(id) ?? new Set();
      actions.add(action);
      result.set(id, actions);
    }
  }
  return result;
}

function sameIds(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return rightIds.size === right.length && left.every((id) => rightIds.has(id));
}

function sameInputValues(left: Record<string, string>, right: Record<string, string>) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

function spec(decision: { id: string; options: DecisionOption[]; targetSnapshots: Record<string, Snapshot> }) {
  return { decisionId: decision.id, options: decision.options, targetSnapshots: decision.targetSnapshots };
}

function resource(issue: typeof issues.$inferSelect) {
  return { type: "issue" as const, companyId: issue.companyId, issueId: issue.id, projectId: issue.projectId,
    parentIssueId: issue.parentId, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId, status: issue.status };
}

function interpolate(text: string, values: Record<string, string>) {
  return text.replace(/\{\{input\.([A-Za-z0-9_-]+)\}\}/g, (_all, id: string) => values[id] ?? "");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseAttentionArchiveManifest(
  companyId: string,
  targetSnapshots: Record<string, Snapshot>,
): AttentionArchiveManifestEntry[] | null {
  const entries: AttentionArchiveManifestEntry[] = [];
  const seen = new Set<string>();
  for (const [key, snapshot] of Object.entries(targetSnapshots)) {
    if (!key.startsWith("attention:")) return null;
    const entry = snapshot.attentionArchive;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const candidate = entry as Record<string, unknown>;
    if (candidate.companyId !== companyId
      || typeof candidate.sourceKind !== "string"
      || !ATTENTION_SOURCE_KINDS.includes(candidate.sourceKind as (typeof ATTENTION_SOURCE_KINDS)[number])
      || typeof candidate.sourceId !== "string"
      || !candidate.sourceId
      || !Number.isInteger(candidate.expectedVersion)
      || Number(candidate.expectedVersion) < 1
      || typeof candidate.activityAt !== "string"
      || !Number.isFinite(Date.parse(candidate.activityAt))
      || typeof candidate.reason !== "string"
      || !candidate.reason.trim()) return null;
    const expectedKey = `attention:${candidate.sourceKind}:${candidate.sourceId}`;
    if (key !== expectedKey || seen.has(expectedKey)) return null;
    seen.add(expectedKey);
    entries.push({
      companyId,
      sourceKind: candidate.sourceKind,
      sourceId: candidate.sourceId,
      expectedVersion: Number(candidate.expectedVersion),
      activityAt: candidate.activityAt,
      reason: candidate.reason,
    });
  }
  return entries.length > 0 ? entries : null;
}

function boardCanActDirectly(actor: AuthorizationActor, companyId: string) {
  if (actor.type !== "board") return false;
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return true;
  return actor.companyIds?.includes(companyId) === true ||
    actor.memberships?.some((membership) => membership.companyId === companyId && membership.status === "active") === true;
}

export function decisionService(db: Db, options: DecisionServiceOptions) {
  const authz = authorizationService(db);
  let targetSweepCursor: string | null = null;
  type CreateInput = { companyId: string; actor: AuthorizationActor; agentId: string; runId: string; bundleId?: string | null;
    ruleKey?: string | null; title: string; body: string; options: DecisionOption[]; inputs?: DecisionInput[] | null; expiresAt?: Date | null;
    idempotencyKey?: string | null; continuationPolicy?: "none" | "wake_origin_agent"; metadata?: Record<string, unknown> };
  type CreateInputWithSnapshots = CreateInput & { additionalTargetSnapshots?: Record<string, Snapshot> };

  async function origin(companyId: string, agentId: string, runId: string) {
    const run = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)))
      .then((rows) => rows[0] ?? null);
    if (!run) throw forbidden("Decision provenance requires the origin run");
    const issueId = typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null;
    if (!issueId) throw unprocessable("Origin run is not issue-scoped");
    return { run, issueId };
  }

  async function recoveryActor(companyId: string, userId: string): Promise<AuthorizationActor> {
    const membership = await db.select({ companyId: companyMemberships.companyId, membershipRole: companyMemberships.membershipRole,
      status: companyMemberships.status }).from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active")))
      .then((rows) => rows[0] ?? null);
    if (!membership) return { type: "none", source: "none" };
    return { type: "board", userId, companyIds: [companyId], memberships: [membership], source: "session" };
  }

  async function collectDescendantIds(companyId: string, rootId: string, dbOrTx: Db) {
    const queue = [rootId]; const visited = new Set([rootId]); const result: string[] = [];
    while (queue.length) {
      const parentId = queue.shift()!;
      const children = await dbOrTx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.parentId, parentId)));
      for (const child of children) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        result.push(child.id);
        queue.push(child.id);
      }
    }
    return result;
  }

  async function snapshots(companyId: string, ids: string[], actor: AuthorizationActor, requiredActions: ReturnType<typeof targetActions>,
    cancellationTargetIds: ReadonlySet<string>, dbOrTx: Db) {
    const rows = ids.length ? await dbOrTx.select().from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, ids))) : [];
    if (rows.length !== ids.length) throw unprocessable("All referenced issues must exist in the company");
    const result: Record<string, Snapshot> = {};
    for (const issue of rows) {
      const access = await authz.decide({ actor, action: "issue:read", resource: resource(issue) });
      if (!access.allowed) throw forbidden("Decision target is outside the origin visibility boundary");
      for (const action of requiredActions.get(issue.id) ?? []) {
        const effectAccess = await authz.decide({ actor, action, resource: resource(issue) });
        if (!effectAccess.allowed) throw forbidden("Decision effect exceeds the origin authority boundary");
      }
      const cancellationTarget = cancellationTargetIds.has(issue.id);
      const descendantIds = cancellationTarget ? await collectDescendantIds(companyId, issue.id, dbOrTx) : [];
      if (cancellationTarget && descendantIds.length) {
        const descendants = await dbOrTx.select().from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, descendantIds)));
        const descendantAccess = await Promise.all(descendants.map((descendant) =>
          authz.decide({ actor, action: "issue:mutate", resource: resource(descendant) })));
        if (descendants.length !== descendantIds.length || descendantAccess.some((access) => !access.allowed)) {
          throw forbidden("Decision effect exceeds the origin authority boundary");
        }
      }
      result[issue.id] = { status: issue.status, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
        updatedAt: issue.updatedAt.toISOString(),
        ...(cancellationTarget ? { descendantCount: descendantIds.length, descendantIds } : {}) };
    }
    return result;
  }

  async function createInStore(input: CreateInputWithSnapshots, dbOrTx: Db) {
    if (input.idempotencyKey) {
      const lockKey = `decision-create:${input.companyId}:${input.idempotencyKey}`;
      await dbOrTx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    }
    const provenance = await origin(input.companyId, input.agentId, input.runId);
    if (input.idempotencyKey) {
      const existing = await dbOrTx.select().from(decisions).where(and(eq(decisions.companyId, input.companyId), eq(decisions.idempotencyKey, input.idempotencyKey)))
        .then((rows) => rows[0] ?? null);
      if (existing) {
        const archiveEquivalent = input.additionalTargetSnapshots === undefined || (
          canonicalJson(existing.metadata ?? {}) === canonicalJson(input.metadata ?? {}) &&
          canonicalJson(Object.fromEntries(Object.entries(existing.targetSnapshots as Record<string, Snapshot>)
            .filter(([key]) => key.startsWith("attention:")))) === canonicalJson(input.additionalTargetSnapshots)
        );
        const equivalent = existing.title === input.title && existing.body === input.body &&
          canonicalJson(existing.options) === canonicalJson(input.options) && canonicalJson(existing.inputs ?? null) === canonicalJson(input.inputs ?? null) &&
          archiveEquivalent;
        if (!equivalent) throw conflict("Decision idempotency key already used with a different payload");
        return existing;
      }
    }
    const open = await dbOrTx.select({ value: count() }).from(decisions).where(and(eq(decisions.companyId, input.companyId), eq(decisions.originAgentId, input.agentId), eq(decisions.status, "open")));
    const cap = Number(process.env.PAPERCLIP_DECISIONS_OPEN_CAP ?? 50);
    if (Number(open[0]?.value ?? 0) >= cap) throw tooManyRequests("Open decision cap reached");
    const expiresAt = input.expiresAt ?? new Date(Date.now() + 7 * DAY);
    if (expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 30 * DAY) throw unprocessable("expiresAt must be within 30 days");
    const ids = targetIds(input.options);
    const cancellationTargetIds = new Set(input.options.flatMap((option) => option.effects
      .filter((effect) => effect.type === "cancel_issue_tree").map((effect) => effect.targetIssueId)));
    const targetSnapshots = {
      ...await snapshots(input.companyId, ids, input.actor, targetActions(input.options), cancellationTargetIds, dbOrTx),
      ...(input.additionalTargetSnapshots ?? {}),
    };
    const id = randomUUID();
    const [created] = await dbOrTx.insert(decisions).values({ id, companyId: input.companyId, bundleId: input.bundleId ?? null,
      originAgentId: input.agentId, originIssueId: provenance.issueId, originRunId: input.runId, ruleKey: input.ruleKey ?? null,
      title: input.title, body: input.body, options: input.options, inputs: input.inputs ?? null, expiresAt,
      idempotencyKey: input.idempotencyKey ?? null, signedSpec: signDecisionSpec(spec({ id, options: input.options, targetSnapshots })),
      targetSnapshots, continuationPolicy: input.continuationPolicy ?? "none", metadata: input.metadata ?? {} }).onConflictDoNothing().returning();
    if (!created) {
      const existing = input.idempotencyKey
        ? await dbOrTx.select().from(decisions).where(and(eq(decisions.companyId, input.companyId), eq(decisions.idempotencyKey, input.idempotencyKey))).then((rows) => rows[0] ?? null)
        : null;
      const archiveEquivalent = !existing || input.additionalTargetSnapshots === undefined || (
        canonicalJson(existing.metadata ?? {}) === canonicalJson(input.metadata ?? {}) &&
        canonicalJson(Object.fromEntries(Object.entries(existing.targetSnapshots as Record<string, Snapshot>)
          .filter(([key]) => key.startsWith("attention:")))) === canonicalJson(input.additionalTargetSnapshots)
      );
      const equivalent = existing && existing.title === input.title && existing.body === input.body &&
        canonicalJson(existing.options) === canonicalJson(input.options) && canonicalJson(existing.inputs ?? null) === canonicalJson(input.inputs ?? null) &&
        archiveEquivalent;
      if (equivalent) return existing;
      throw conflict("Decision idempotency key already used with a different payload");
    }
    if (ids.length) await dbOrTx.insert(decisionTargetIssues).values(ids.map((issueId) => ({ decisionId: id, issueId, companyId: input.companyId })));
    await logActivity(dbOrTx, { companyId: input.companyId, actorType: "agent", actorId: input.agentId, agentId: input.agentId,
      runId: input.runId, action: "decision.created", entityType: "decision", entityId: id,
      details: { originIssueId: provenance.issueId, originAgentId: input.agentId, originResponsibleUserId: provenance.run.responsibleUserId } });
    return created;
  }

  async function create(input: CreateInputWithSnapshots, dbOrTx?: Db) {
    if (dbOrTx) return createInStore(input, dbOrTx);
    return db.transaction((tx) => createInStore(input, tx as unknown as Db));
  }

  const get = (id: string) => db.select().from(decisions).where(eq(decisions.id, id)).then((rows) => rows[0] ?? null);
  async function outcome(id: string) {
    const decision = await get(id);
    const executions = await db.select().from(decisionEffectExecutions).where(eq(decisionEffectExecutions.decisionId, id)).orderBy(asc(decisionEffectExecutions.effectIndex));
    return { ...decision, executions };
  }

  async function list(companyId: string, filter: { status?: string; bundleId?: string; targetIssueId?: string; originAgentId?: string; limit?: number } = {}) {
    const conditions = [eq(decisions.companyId, companyId)];
    if (filter.status) conditions.push(eq(decisions.status, filter.status));
    if (filter.bundleId) conditions.push(eq(decisions.bundleId, filter.bundleId));
    if (filter.originAgentId) conditions.push(eq(decisions.originAgentId, filter.originAgentId));
    if (filter.targetIssueId) {
      const links = await db.select({ id: decisionTargetIssues.decisionId }).from(decisionTargetIssues).where(and(eq(decisionTargetIssues.companyId, companyId), eq(decisionTargetIssues.issueId, filter.targetIssueId)));
      if (!links.length) return [];
      conditions.push(inArray(decisions.id, links.map((row) => row.id)));
    }
    const rows = await db.select().from(decisions).where(and(...conditions)).orderBy(desc(decisions.createdAt)).limit(Math.min(filter.limit ?? 50, 100));
    const openDecisionIds = rows.filter((decision) => decision.status === "open").map((decision) => decision.id);
    const currentIssueTargetIds = rows.flatMap((decision) => Object.keys(decision.targetSnapshots as Record<string, Snapshot>))
      .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
    const currentTargets = openDecisionIds.length && currentIssueTargetIds.length
      ? await db.select({ id: issues.id, updatedAt: issues.updatedAt })
        .from(decisionTargetIssues)
        .innerJoin(issues, and(eq(issues.companyId, companyId), eq(issues.id, decisionTargetIssues.issueId)))
        .where(and(eq(decisionTargetIssues.companyId, companyId), inArray(decisionTargetIssues.decisionId, openDecisionIds), inArray(issues.id, currentIssueTargetIds)))
      : [];
    const currentTargetsById = new Map(currentTargets.map((target) => [target.id, target.updatedAt]));
    const attentionSnapshotIds = rows.flatMap((decision) => Object.values(decision.targetSnapshots as Record<string, Snapshot>))
      .map((snapshot) => snapshot.attentionArchive as AttentionArchiveManifestEntry | undefined)
      .filter((entry): entry is AttentionArchiveManifestEntry => Boolean(entry))
      .map((entry) => entry.sourceId);
    const currentAttentionStates = attentionSnapshotIds.length
      ? await db.select().from(decisionRetention).where(and(
        eq(decisionRetention.companyId, companyId),
        inArray(decisionRetention.sourceId, attentionSnapshotIds),
      ))
      : [];
    const currentAttentionByKey = new Map(currentAttentionStates.map((state) => [
      `attention:${state.sourceKind}:${state.sourceId}`,
      state,
    ]));
    const terminalDecisionIds = rows.filter((decision) => decision.status !== "open").map((decision) => decision.id);
    const terminalExecutions = terminalDecisionIds.length
      ? await db.select().from(decisionEffectExecutions)
        .where(inArray(decisionEffectExecutions.decisionId, terminalDecisionIds))
        .orderBy(asc(decisionEffectExecutions.decisionId), asc(decisionEffectExecutions.effectIndex))
      : [];
    const executionsByDecision = new Map<string, typeof terminalExecutions>();
    for (const execution of terminalExecutions) {
      const grouped = executionsByDecision.get(execution.decisionId) ?? [];
      grouped.push(execution);
      executionsByDecision.set(execution.decisionId, grouped);
    }
    return rows.map((decision) => {
      const changed: Record<string, boolean> = {};
      if (decision.status === "open") for (const [id, snapshot] of Object.entries(decision.targetSnapshots as Record<string, Snapshot>)) {
        if (id.startsWith("attention:")) {
          const entry = snapshot.attentionArchive as AttentionArchiveManifestEntry | undefined;
          const current = currentAttentionByKey.get(id);
          changed[id] = !entry || !current || current.version !== entry.expectedVersion
            || current.sourceActivityAt.toISOString() !== entry.activityAt || Boolean(current.archivedAt);
          continue;
        }
        const currentUpdatedAt = currentTargetsById.get(id);
        changed[id] = !currentUpdatedAt || currentUpdatedAt.toISOString() !== snapshot.updatedAt;
      }
      return { ...decision, targetChanged: changed,
        ...(decision.status === "open" ? {} : { executions: executionsByDecision.get(decision.id) ?? [] }) };
    });
  }

  async function stats(companyId: string, filter: { originAgentId?: string; since?: Date } = {}): Promise<DecisionStatsResponse> {
    const conditions = [eq(decisions.companyId, companyId)];
    if (filter.originAgentId) conditions.push(eq(decisions.originAgentId, filter.originAgentId));
    if (filter.since) conditions.push(gte(decisions.createdAt, filter.since));
    const dismissed = sql<boolean>`coalesce(${decisions.metadata}->'dismissed' = 'true'::jsonb, false)`;
    const rows = await db.select({
      ruleKey: decisions.ruleKey,
      status: decisions.status,
      chosenOptionId: decisions.chosenOptionId,
      dismissed,
      value: count(),
    }).from(decisions).where(and(...conditions))
      .groupBy(decisions.ruleKey, decisions.status, decisions.chosenOptionId, dismissed);
    const emptyCounts = (): DecisionStatsCounts => ({ proposed: 0, accepted: 0, rejected: 0, expired: 0 });
    const totals = emptyCounts();
    const grouped = new Map<string | null, { counts: DecisionStatsCounts; chosenOptions: Map<string, number> }>();
    for (const row of rows) {
      const value = Number(row.value);
      const group = grouped.get(row.ruleKey) ?? { counts: emptyCounts(), chosenOptions: new Map<string, number>() };
      grouped.set(row.ruleKey, group);
      totals.proposed += value;
      group.counts.proposed += value;
      if (row.status === "expired") {
        totals.expired += value;
        group.counts.expired += value;
        continue;
      }
      if (row.status !== "decided") continue;
      const rejected = row.chosenOptionId === "dismissed" || row.dismissed;
      if (rejected) {
        totals.rejected += value;
        group.counts.rejected += value;
        continue;
      }
      totals.accepted += value;
      group.counts.accepted += value;
      if (row.chosenOptionId) group.chosenOptions.set(row.chosenOptionId, (group.chosenOptions.get(row.chosenOptionId) ?? 0) + value);
    }
    return {
      groupBy: "ruleKey",
      filters: { originAgentId: filter.originAgentId ?? null, since: filter.since?.toISOString() ?? null },
      totals,
      groups: [...grouped.entries()]
        .sort(([left], [right]) => left === null ? 1 : right === null ? -1 : left.localeCompare(right))
        .map(([ruleKey, group]) => ({
          ruleKey,
          ...group.counts,
          chosenOptions: [...group.chosenOptions.entries()]
            .sort(([leftId, leftCount], [rightId, rightCount]) => rightCount - leftCount || leftId.localeCompare(rightId))
            .map(([optionId, optionCount]) => ({ optionId, count: optionCount })),
        })),
    };
  }

  async function effectAudit(tx: Db, decision: typeof decisions.$inferSelect, executionId: string, effect: DecisionEffect,
    status: "executed" | "failed" | "skipped", decidedByUserId: string, originResponsibleUserId: string | null, details: Record<string, unknown>) {
    return logActivity(tx, { companyId: decision.companyId, actorType: "system", actorId: "decision-executor", agentId: decision.originAgentId,
      runId: decision.originRunId, responsibleUserIdOverride: decidedByUserId, action: `decision.effect_${status}`, entityType: "decision", entityId: decision.id,
      details: { effectType: effect.type, targetIssueId: effect.targetIssueId, originIssueId: decision.originIssueId, originAgentId: decision.originAgentId,
        chosenOptionId: decision.chosenOptionId, executionId, decidedByUserId, originResponsibleUserId, ...details } });
  }

  async function executeEffect(decision: typeof decisions.$inferSelect, effect: DecisionEffect, effectIndex: number,
    userActor: AuthorizationActor, decidedByUserId: string, originResponsibleUserId: string | null) {
    const lockKey = `decision-effect:${decision.id}:${effectIndex}`;
    const recordFailure = async (reason: string, details: Record<string, unknown>) => db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      let execution = await tx.select().from(decisionEffectExecutions).where(and(eq(decisionEffectExecutions.decisionId, decision.id), eq(decisionEffectExecutions.effectIndex, effectIndex)))
        .then((rows) => rows[0] ?? null);
      if (execution && execution.status !== "claimed") return execution;
      if (!execution) {
        [execution] = await tx.insert(decisionEffectExecutions).values({ decisionId: decision.id, effectIndex, effectType: effect.type, targetIssueId: effect.targetIssueId }).onConflictDoNothing().returning();
        if (!execution) execution = await tx.select().from(decisionEffectExecutions).where(and(eq(decisionEffectExecutions.decisionId, decision.id), eq(decisionEffectExecutions.effectIndex, effectIndex))).then((rows) => rows[0] ?? null);
      }
      if (!execution || execution.status !== "claimed") return execution;
      const activity = await effectAudit(tx as unknown as Db, decision, execution.id, effect, "failed", decidedByUserId, originResponsibleUserId, details);
      const [row] = await tx.update(decisionEffectExecutions).set({ status: "failed", error: reason, result: details, activityLogId: activity?.id ?? null, executedAt: new Date() }).where(eq(decisionEffectExecutions.id, execution.id)).returning();
      return row;
    });

    try {
      const postCommitActivityPublications: ActivityPublication[] = [];
      const executionResult = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        let execution = await tx.select().from(decisionEffectExecutions).where(and(eq(decisionEffectExecutions.decisionId, decision.id), eq(decisionEffectExecutions.effectIndex, effectIndex)))
          .then((rows) => rows[0] ?? null);
        if (execution && execution.status !== "claimed") return execution;
        if (!execution) {
          [execution] = await tx.insert(decisionEffectExecutions).values({ decisionId: decision.id, effectIndex, effectType: effect.type, targetIssueId: effect.targetIssueId }).onConflictDoNothing().returning();
          if (!execution) execution = await tx.select().from(decisionEffectExecutions).where(and(eq(decisionEffectExecutions.decisionId, decision.id), eq(decisionEffectExecutions.effectIndex, effectIndex))).then((rows) => rows[0] ?? null);
          if (!execution || execution.status !== "claimed") return execution;
        }
        const finish = async (status: "failed" | "skipped", reason: string, details: Record<string, unknown>) => {
          const activity = await effectAudit(tx as unknown as Db, decision, execution!.id, effect, status, decidedByUserId, originResponsibleUserId, details);
          const [row] = await tx.update(decisionEffectExecutions).set({ status, error: reason, result: details, activityLogId: activity?.id ?? null, executedAt: new Date() }).where(eq(decisionEffectExecutions.id, execution!.id)).returning();
          return row;
        };
        const directReferencedIds = new Set(decisionEffectTargetIssueIds(effect));
        const snapshots = decision.targetSnapshots as Record<string, Snapshot>;
        const cancellationDescendantIds = effect.type === "cancel_issue_tree"
          ? snapshots[effect.targetIssueId]?.descendantIds
          : undefined;
        if (effect.type === "cancel_issue_tree" && !Array.isArray(cancellationDescendantIds)) {
          return finish("failed", "invalid_signed_cancellation_scope", { reason: "invalid_signed_cancellation_scope" });
        }
        const referencedIds = new Set([...directReferencedIds, ...(cancellationDescendantIds ?? [])]);
        const referencedIssues = await tx.select().from(issues).where(and(eq(issues.companyId, decision.companyId), inArray(issues.id, [...referencedIds])));
        if (referencedIssues.length !== referencedIds.size) return finish("failed", "invalid_effect_reference", { reason: "invalid_effect_reference" });
        const target = referencedIssues.find((item) => item.id === effect.targetIssueId)!;
        const originActor: AuthorizationActor = { type: "agent", agentId: decision.originAgentId, companyId: decision.companyId,
          runId: decision.originRunId, onBehalfOfUserId: originResponsibleUserId, source: "agent_jwt" };
        const originAction = effect.type === "comment_on_issue" ? "issue:comment" : "issue:mutate";
        const originAccess = await Promise.all(referencedIssues.map((item) => authz.decide({ actor: originActor, action: originAction, resource: resource(item) })));
        let userAccess: { allowed: boolean; reason: string };
        if (effect.type === "assign_issue" || (effect.type === "create_issue" && (effect.draft.assigneeAgentId || effect.draft.assigneeUserId))) {
          const assigneeAgentId = effect.type === "assign_issue" ? effect.assigneeAgentId : effect.draft.assigneeAgentId;
          const assigneeUserId = effect.type === "assign_issue" ? effect.assigneeUserId : effect.draft.assigneeUserId;
          const parentIssueId = effect.type === "create_issue" ? effect.draft.parentId ?? target.id : target.parentId;
          const projectId = effect.type === "create_issue" ? effect.draft.projectId ?? target.projectId : target.projectId;
          userAccess = await authz.decide({ actor: userActor, action: "tasks:assign", resource: { ...resource(target), parentIssueId, projectId },
            scope: { issueId: target.id, parentIssueId, projectId, assigneeAgentId, assigneeUserId } });
        } else {
          userAccess = boardCanActDirectly(userActor, decision.companyId)
            ? { allowed: true, reason: "allow_board_direct_route" }
            : { allowed: false, reason: "deny_company_boundary" };
        }
        const deniedOrigin = originAccess.find((access) => !access.allowed);
        if (!userAccess.allowed || deniedOrigin) return finish("failed", "deny_decision_intersection",
          { reason: "deny_decision_intersection", userReason: userAccess.reason, originReason: deniedOrigin?.reason ?? null });
        if (effect.staleness === "strict") {
          const staleReference = referencedIssues.some((item) => directReferencedIds.has(item.id) &&
            snapshots[item.id]?.updatedAt !== item.updatedAt.toISOString());
          const changedTree = effect.type === "cancel_issue_tree" && !sameIds(cancellationDescendantIds!,
            await collectDescendantIds(decision.companyId, target.id, tx as unknown as Db));
          if (staleReference || changedTree) return finish("skipped", "target_changed", { reason: "target_changed" });
        }
        const svc = issueService(db);
        const values = decision.inputValues ?? {};
        let result: Record<string, unknown>;
        if (effect.type === "comment_on_issue") {
          const comment = await svc.addComment(target.id, interpolate(effect.bodyMarkdown, values), { userId: decidedByUserId }, undefined, tx);
          result = { commentId: comment.id };
        } else if (effect.type === "update_issue_status") {
          const updated = await svc.update(
            target.id,
            { status: effect.status, actorUserId: decidedByUserId },
            tx,
            postCommitActivityPublications,
          );
          if (effect.comment) await svc.addComment(target.id, interpolate(effect.comment, values), { userId: decidedByUserId }, undefined, tx);
          result = { issueId: updated?.id, status: updated?.status };
        } else if (effect.type === "assign_issue") {
          const updated = await svc.update(
            target.id,
            {
              assigneeAgentId: effect.assigneeAgentId ?? null,
              assigneeUserId: effect.assigneeUserId ?? null,
              actorUserId: decidedByUserId,
            },
            tx,
            postCommitActivityPublications,
          );
          if (effect.comment) await svc.addComment(target.id, interpolate(effect.comment, values), { userId: decidedByUserId }, undefined, tx);
          result = { issueId: updated?.id };
        } else if (effect.type === "resolve_blocker") {
          const current = await tx.select({ id: issueRelations.issueId }).from(issueRelations).where(and(eq(issueRelations.companyId, decision.companyId), eq(issueRelations.relatedIssueId, target.id), eq(issueRelations.type, "blocks")));
          await svc.update(
            target.id,
            {
              blockedByIssueIds: current.map((row) => row.id).filter((id) => !effect.removeBlockedByIssueIds.includes(id)),
              actorUserId: decidedByUserId,
            },
            tx,
            postCommitActivityPublications,
          );
          result = { removedBlockedByIssueIds: effect.removeBlockedByIssueIds };
        } else if (effect.type === "create_issue") {
          const draft = effect.draft;
          const created = await svc.create(decision.companyId, { title: draft.title, description: draft.description ?? null, parentId: draft.parentId ?? target.id,
            assigneeAgentId: draft.assigneeAgentId ?? null, assigneeUserId: draft.assigneeUserId ?? null, projectId: draft.projectId ?? target.projectId,
            goalId: draft.goalId ?? null, blockedByIssueIds: draft.blockedByIssueIds ?? [], createdByUserId: decidedByUserId, actorRunId: decision.originRunId,
            idempotencyKey: `decision-effect:${decision.id}:${effectIndex}` });
          result = { issueId: created.id };
        } else {
          const cancelled = [target.id, ...cancellationDescendantIds!].reverse();
          for (const id of cancelled) {
            await svc.update(
              id,
              { status: "cancelled", actorUserId: decidedByUserId },
              tx,
              postCommitActivityPublications,
            );
          }
          await svc.addComment(target.id, interpolate(effect.reasonComment, values), { userId: decidedByUserId }, undefined, tx);
          result = { cancelledIssueIds: cancelled };
        }
        const activity = await effectAudit(tx as unknown as Db, decision, execution.id, effect, "executed", decidedByUserId, originResponsibleUserId, result);
        const [row] = await tx.update(decisionEffectExecutions).set({ status: "executed", result, error: null, activityLogId: activity?.id ?? null, executedAt: new Date() }).where(eq(decisionEffectExecutions.id, execution.id)).returning();
        return row;
      });
      for (const publication of postCommitActivityPublications) publishActivity(publication);
      return executionResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Decision effect execution failed";
      return recordFailure("effect_execution_failed", { reason: "effect_execution_failed", message });
    }
  }

  async function runEffects(decision: typeof decisions.$inferSelect, userActor: AuthorizationActor) {
    const option = decision.options.find((item) => item.id === decision.chosenOptionId);
    if (!option || !decision.decidedByUserId) throw unprocessable("Stored decision outcome is invalid");
    const run = await db.select({ responsibleUserId: heartbeatRuns.responsibleUserId }).from(heartbeatRuns).where(eq(heartbeatRuns.id, decision.originRunId)).then((rows) => rows[0] ?? null);
    const metadata = decision.metadata as Record<string, unknown>;
    if (metadata.kind === "attention_archive_proposal") {
      if (!verifyDecisionSpec(spec({
        id: decision.id,
        options: decision.options,
        targetSnapshots: decision.targetSnapshots as Record<string, Snapshot>,
      }), decision.signedSpec)) {
        await db.update(decisions).set({ executionStatus: "failed", updatedAt: new Date(), metadata: { ...metadata, archiveProposalError: "invalid_signature" } })
          .where(eq(decisions.id, decision.id));
        return outcome(decision.id);
      }
      if (option.id === "archive") {
        const manifest = parseAttentionArchiveManifest(
          decision.companyId,
          decision.targetSnapshots as Record<string, Snapshot>,
        );
        const manifestHash = manifest ? hashAttentionArchiveManifest(manifest) : null;
        if (!manifest || manifestHash !== metadata.manifestHash) {
          await db.update(decisions).set({ executionStatus: "failed", updatedAt: new Date(), metadata: { ...metadata, archiveProposalError: "manifest_mismatch" } })
            .where(eq(decisions.id, decision.id));
          return outcome(decision.id);
        }
        const originActor: AuthorizationActor = {
          type: "agent",
          agentId: decision.originAgentId,
          companyId: decision.companyId,
          runId: decision.originRunId,
          onBehalfOfUserId: run?.responsibleUserId ?? null,
          source: "agent_jwt",
        };
        try {
          await decisionRetentionService(db).archiveReviewedManifest({
            companyId: decision.companyId,
            manifest,
            originActor,
            decidingActor: userActor,
            decidedByUserId: decision.decidedByUserId,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "archive_proposal_failed";
          await db.update(decisions).set({ executionStatus: "failed", updatedAt: new Date(), metadata: { ...metadata, archiveProposalError: message } })
            .where(eq(decisions.id, decision.id));
          return outcome(decision.id);
        }
      }
      await db.update(decisions).set({
        executionStatus: "succeeded",
        updatedAt: new Date(),
        metadata: { ...metadata, ...(decision.continuationPolicy === "wake_origin_agent" ? { continuationPending: true } : {}) },
      }).where(eq(decisions.id, decision.id));
      return outcome(decision.id);
    }
    for (let index = 0; index < option.effects.length; index += 1) await executeEffect(decision, option.effects[index]!, index, userActor, decision.decidedByUserId, run?.responsibleUserId ?? null);
    const rows = await db.select().from(decisionEffectExecutions).where(eq(decisionEffectExecutions.decisionId, decision.id));
    const successful = rows.filter((row) => row.status === "executed").length;
    const status = rows.every((row) => row.status === "executed") ? "succeeded" : successful ? "partial" : "failed";
    await db.update(decisions).set({ executionStatus: status, updatedAt: new Date(), metadata: { ...decision.metadata,
      ...(decision.continuationPolicy === "wake_origin_agent" ? { continuationPending: true } : {}) } }).where(eq(decisions.id, decision.id));
    return outcome(decision.id);
  }

  async function deliverContinuation(
    decision: typeof decisions.$inferSelect,
    outcome: "decided" | "expired" | "cancelled",
  ) {
    const metadata = decision.metadata as Record<string, unknown>;
    if (decision.continuationPolicy !== "wake_origin_agent" || metadata.continuationPending !== true) return;
    // Delivery is intentionally at-least-once: a crash after wakeup but before
    // this acknowledgement can retry, while a crash before wakeup cannot lose
    // the continuation. Heartbeat wakeups coalesce concurrent queued work.
    await options.wakeOriginAgent({ companyId: decision.companyId, agentId: decision.originAgentId,
      issueId: decision.originIssueId, decisionId: decision.id, outcome });
    await db.update(decisions).set({
      metadata: sql`coalesce(${decisions.metadata}, '{}'::jsonb) || jsonb_build_object(
        'continuationPending', false,
        'continuationDeliveredAt', ${new Date().toISOString()}::text
      )`,
      updatedAt: new Date(),
    }).where(and(eq(decisions.id, decision.id), sql`${decisions.metadata} ->> 'continuationPending' = 'true'`));
  }

  async function resumeDecision(decision: typeof decisions.$inferSelect, userActor: AuthorizationActor) {
    const result = decision.executionStatus === "running" ? await runEffects(decision, userActor) : await outcome(decision.id);
    await deliverContinuation(result, "decided");
    return outcome(decision.id);
  }

  async function decide(input: { id: string; optionId: string; inputValues?: Record<string, string>; idempotencyKey?: string | null; decidedByUserId: string;
    userActor: AuthorizationActor; dismissed?: boolean; dismissReason?: string | null }) {
    const current = await get(input.id); if (!current) throw notFound("Decision not found");
    const metadata = current.metadata as Record<string, unknown>;
    if (!verifyDecisionSpec(spec({ id: current.id, options: current.options, targetSnapshots: current.targetSnapshots as Record<string, Snapshot> }), current.signedSpec)) throw forbidden("Decision signature verification failed");
    if (current.status === "decided" && input.idempotencyKey && metadata.decideIdempotencyKey === input.idempotencyKey) {
      if (current.decidedByUserId !== input.decidedByUserId) throw forbidden("Decision replay belongs to a different user");
      return resumeDecision(current, input.userActor);
    }
    if (current.status === "decided" && current.chosenOptionId === input.optionId &&
      sameInputValues(current.inputValues ?? {}, input.inputValues ?? {})) {
      if (current.decidedByUserId !== input.decidedByUserId) throw forbidden("Decision replay belongs to a different user");
      return resumeDecision(current, input.userActor);
    }
    if (current.status !== "open") throw conflict("decision_already_resolved", { code: "decision_already_resolved" });
    if (current.expiresAt <= new Date()) {
      const [expired] = await db.update(decisions).set({ status: "expired", updatedAt: new Date(), metadata: { ...metadata, expiredReason: "ttl",
        ...(current.continuationPolicy === "wake_origin_agent" ? { continuationPending: true } : {}) } })
        .where(and(eq(decisions.id, current.id), eq(decisions.status, "open"), lte(decisions.expiresAt, new Date()))).returning();
      if (expired) {
        await logActivity(db, { companyId: expired.companyId, actorType: "system", actorId: "decision-expiry-sweeper", agentId: expired.originAgentId,
          runId: expired.originRunId, action: "decision.expired", entityType: "decision", entityId: expired.id, details: { expiredReason: "ttl" } });
        await deliverContinuation(expired, "expired");
      }
      throw conflict("decision_expired", { code: "decision_expired" });
    }
    if (!current.options.some((option) => option.id === input.optionId)) throw unprocessable("Unknown optionId");
    const values = input.inputValues ?? {};
    for (const field of current.inputs ?? []) { const value = values[field.id] ?? ""; if (field.required && !value.trim()) throw unprocessable(`Input ${field.id} is required`); if (field.maxLength && value.length > field.maxLength) throw unprocessable(`Input ${field.id} is too long`); }
    const [claimed] = await db.update(decisions).set({ status: "decided", executionStatus: "running", chosenOptionId: input.optionId, inputValues: values,
      decidedByUserId: input.decidedByUserId, decidedAt: new Date(), updatedAt: new Date(), metadata: { ...metadata,
        decideIdempotencyKey: input.idempotencyKey ?? null,
        ...(current.continuationPolicy === "wake_origin_agent" ? { continuationPending: true } : {}),
        ...(input.dismissed ? { dismissed: true, dismissReason: input.dismissReason ?? null } : {}) } })
      .where(and(eq(decisions.id, current.id), eq(decisions.status, "open"))).returning();
    if (!claimed) throw conflict("decision_already_resolved", { code: "decision_already_resolved" });
    const run = await db.select({ responsibleUserId: heartbeatRuns.responsibleUserId }).from(heartbeatRuns).where(eq(heartbeatRuns.id, claimed.originRunId)).then((rows) => rows[0] ?? null);
    await logActivity(db, { companyId: claimed.companyId, actorType: "system", actorId: "decision-executor", agentId: claimed.originAgentId, runId: claimed.originRunId,
      responsibleUserIdOverride: input.decidedByUserId, action: input.dismissed ? "decision.dismissed" : "decision.decided", entityType: "decision", entityId: claimed.id,
      details: { chosenOptionId: input.optionId, decidedByUserId: input.decidedByUserId, originResponsibleUserId: run?.responsibleUserId ?? null,
        ...(input.dismissed ? { dismissed: true, dismissReason: input.dismissReason ?? null } : {}) } });
    return resumeDecision(claimed, input.userActor);
  }

  async function cancel(id: string, actor: { actorType: "agent" | "user"; actorId: string; runId?: string | null }) {
    const current = await get(id); if (!current) throw notFound("Decision not found");
    if (actor.actorType === "agent" && actor.actorId !== current.originAgentId) throw forbidden("Only the origin agent may cancel");
    if (current.status === "cancelled") {
      await deliverContinuation(current, "cancelled");
      return (await get(id))!;
    }
    const [updated] = await db.update(decisions).set({ status: "cancelled", updatedAt: new Date(), metadata: { ...current.metadata,
      ...(current.continuationPolicy === "wake_origin_agent" ? { continuationPending: true } : {}) } }).where(and(eq(decisions.id, id), eq(decisions.status, "open"))).returning();
    if (!updated) throw conflict("decision_already_resolved", { code: "decision_already_resolved" });
    await logActivity(db, { companyId: updated.companyId, actorType: actor.actorType, actorId: actor.actorId, runId: actor.runId, action: "decision.cancelled", entityType: "decision", entityId: id });
    await deliverContinuation(updated, "cancelled");
    return (await get(id))!;
  }

  async function dismiss(id: string, userId: string, userActor: AuthorizationActor, reason?: string | null) {
    const current = await get(id); if (!current) throw notFound("Decision not found");
    if (!verifyDecisionSpec(spec({ id: current.id, options: current.options, targetSnapshots: current.targetSnapshots as Record<string, Snapshot> }), current.signedSpec)) throw forbidden("Decision signature verification failed");
    const empty = current.options.find((option) => option.effects.length === 0);
    if (empty) return decide({ id, optionId: empty.id, decidedByUserId: userId, userActor, dismissed: true, dismissReason: reason });
    const [updated] = await db.update(decisions).set({ status: "decided", executionStatus: "succeeded", chosenOptionId: "dismissed", decidedByUserId: userId,
      decidedAt: new Date(), updatedAt: new Date(), metadata: { ...current.metadata, dismissed: true, dismissReason: reason ?? null,
        ...(current.continuationPolicy === "wake_origin_agent" ? { continuationPending: true } : {}) } }).where(and(eq(decisions.id, id), eq(decisions.status, "open"))).returning();
    if (!updated) throw conflict("decision_already_resolved", { code: "decision_already_resolved" });
    await logActivity(db, { companyId: updated.companyId, actorType: "system", actorId: "decision-executor", agentId: updated.originAgentId,
      runId: updated.originRunId, responsibleUserIdOverride: userId, action: "decision.dismissed", entityType: "decision", entityId: updated.id,
      details: { chosenOptionId: "dismissed", decidedByUserId: userId, dismissed: true } });
    await deliverContinuation(updated, "decided");
    return outcome(id);
  }

  async function createBundle(input: { companyId: string; actor: AuthorizationActor; agentId: string; runId: string; title: string; summary: string;
    decisions: Array<Omit<Parameters<typeof create>[0], "companyId" | "actor" | "agentId" | "runId" | "bundleId">> }) {
    return db.transaction(async (tx) => { const provenance = await origin(input.companyId, input.agentId, input.runId);
      const [bundle] = await tx.insert(decisionBundles).values({ companyId: input.companyId, title: input.title, summary: input.summary, originAgentId: input.agentId, originIssueId: provenance.issueId, originRunId: input.runId }).returning();
      const created = []; for (const item of input.decisions) created.push(await create({ ...item, companyId: input.companyId, actor: input.actor, agentId: input.agentId, runId: input.runId, bundleId: bundle.id }, tx as unknown as Db));
      return { ...bundle, decisions: created }; });
  }

  async function sweepExpired(now = new Date()) {
    const configuredBatchSize = Number(process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE ?? 100);
    const batchSize = Number.isFinite(configuredBatchSize)
      ? Math.max(1, Math.trunc(configuredBatchSize))
      : 100;
    const configuredRecoveryGraceMs = Number(process.env.PAPERCLIP_DECISIONS_RECOVERY_GRACE_MS ?? 60_000);
    const recoveryGraceMs = Number.isFinite(configuredRecoveryGraceMs) && configuredRecoveryGraceMs >= 0
      ? configuredRecoveryGraceMs
      : 60_000;
    const runningRows = await db.select().from(decisions)
      .where(and(eq(decisions.status, "decided"), eq(decisions.executionStatus, "running"),
        lte(decisions.updatedAt, new Date(now.getTime() - recoveryGraceMs))))
      .orderBy(asc(decisions.updatedAt)).limit(batchSize);
    let resumed = 0;
    for (const decision of runningRows) {
      if (!decision.decidedByUserId) continue;
      const recovered = await runEffects(decision, await recoveryActor(decision.companyId, decision.decidedByUserId));
      if (recovered.executionStatus === "running") continue;
      resumed += 1;
      await deliverContinuation(recovered, "decided");
    }
    const pendingContinuations = await db.select().from(decisions)
      .where(and(eq(decisions.continuationPolicy, "wake_origin_agent"),
        sql`${decisions.metadata} ->> 'continuationPending' = 'true'`,
        or(inArray(decisions.status, ["expired", "cancelled"]), and(eq(decisions.status, "decided"),
          inArray(decisions.executionStatus, ["succeeded", "partial", "failed"])))))
      .orderBy(asc(decisions.updatedAt)).limit(batchSize);
    for (const decision of pendingContinuations) {
      await deliverContinuation(decision, decision.status === "expired" ? "expired" : decision.status === "cancelled" ? "cancelled" : "decided");
    }
    const ttlRows = await db.select().from(decisions)
      .where(and(eq(decisions.status, "open"), lte(decisions.expiresAt, now)))
      .orderBy(asc(decisions.expiresAt)).limit(batchSize);
    const remaining = batchSize - ttlRows.length;
    const targetRows = remaining > 0
      ? await db.select().from(decisions)
        .where(and(eq(decisions.status, "open"), ...(targetSweepCursor ? [gt(decisions.id, targetSweepCursor)] : [])))
        .orderBy(asc(decisions.id)).limit(remaining)
      : [];
    targetSweepCursor = targetRows.length === remaining && targetRows.length > 0 ? targetRows[targetRows.length - 1]!.id : null;
    const rows = [...new Map([...ttlRows, ...targetRows].map((row) => [row.id, row])).values()]; let expired = 0;
    for (const decision of rows) { const strictTargetIds = new Set(decision.options.flatMap((option) => option.effects.filter((effect) => effect.staleness === "strict").flatMap(decisionEffectTargetIssueIds)));
      const targets = strictTargetIds.size > 0
        ? await db.select({ id: issues.id, status: issues.status }).from(issues).where(and(eq(issues.companyId, decision.companyId), inArray(issues.id, [...strictTargetIds])))
        : [];
      const targetGone = targets.length !== strictTargetIds.size || targets.some((target) => target.status === "cancelled");
      // A decision whose strict targets all completed after it was proposed is moot:
      // the strict guard would skip its effects anyway, so retire it instead of
      // leaving it pending until TTL. Targets that were already done at proposal
      // time don't count — those decisions intentionally act on a done issue.
      const snapshots = decision.targetSnapshots as Record<string, Snapshot>;
      const targetsCompleted = !targetGone && strictTargetIds.size > 0 &&
        targets.every((target) => target.status === "done") &&
        targets.some((target) => snapshots[target.id]?.status !== "done");
      if (!targetGone && !targetsCompleted && decision.expiresAt >= now) continue;
      const reason = targetGone ? "target_gone" : targetsCompleted ? "target_completed" : "ttl";
      const [updated] = await db.update(decisions).set({ status: "expired", updatedAt: now, metadata: { ...decision.metadata, expiredReason: reason,
        ...(decision.continuationPolicy === "wake_origin_agent" ? { continuationPending: true } : {}) } }).where(and(eq(decisions.id, decision.id), eq(decisions.status, "open"))).returning();
      if (!updated) continue; expired += 1;
      await logActivity(db, { companyId: updated.companyId, actorType: "system", actorId: "decision-expiry-sweeper", agentId: updated.originAgentId, runId: updated.originRunId, action: "decision.expired", entityType: "decision", entityId: updated.id, details: { expiredReason: reason } });
      await deliverContinuation(updated, "expired"); }
    return { expired, resumed };
  }

  return { create, createBundle, get, list, stats, outcome, decide, cancel, dismiss, sweepExpired };
}
