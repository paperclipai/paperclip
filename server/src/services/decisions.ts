import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { decisionBundles, decisionEffectExecutions, decisions, decisionTargetIssues, heartbeatRuns, issueRelations, issues } from "@paperclipai/db";
import type { DecisionEffect, DecisionInput, DecisionOption } from "@paperclipai/shared";
import { conflict, forbidden, notFound, tooManyRequests, unprocessable } from "../errors.js";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { logActivity } from "./activity-log.js";
import { signDecisionSpec, verifyDecisionSpec } from "./decision-signing.js";
import { issueService } from "./issues.js";

type Snapshot = { status: string; assigneeAgentId: string | null; assigneeUserId: string | null; updatedAt: string; childCount: number };
type Wake = (input: { companyId: string; agentId: string; issueId: string; decisionId: string; outcome: "decided" | "expired" }) => Promise<unknown>;
const DAY = 86_400_000;

function targetIds(options: DecisionOption[]) {
  const result = new Set<string>();
  for (const option of options) for (const effect of option.effects) {
    result.add(effect.targetIssueId);
    if (effect.type === "create_issue") {
      if (effect.draft.parentId) result.add(effect.draft.parentId);
      for (const id of effect.draft.blockedByIssueIds ?? []) result.add(id);
    }
    if (effect.type === "resolve_blocker") for (const id of effect.removeBlockedByIssueIds) result.add(id);
  }
  return [...result];
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

function boardCanActDirectly(actor: AuthorizationActor, companyId: string) {
  if (actor.type !== "board") return false;
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return true;
  return actor.companyIds?.includes(companyId) === true ||
    actor.memberships?.some((membership) => membership.companyId === companyId && membership.status === "active") === true;
}

export function decisionService(db: Db, options: { wakeOriginAgent?: Wake } = {}) {
  const authz = authorizationService(db);

  async function origin(companyId: string, agentId: string, runId: string) {
    const run = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)))
      .then((rows) => rows[0] ?? null);
    if (!run) throw forbidden("Decision provenance requires the origin run");
    const issueId = typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null;
    if (!issueId) throw unprocessable("Origin run is not issue-scoped");
    return { run, issueId };
  }

  async function snapshots(companyId: string, ids: string[], actor: AuthorizationActor, dbOrTx: Db) {
    const rows = ids.length ? await dbOrTx.select().from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, ids))) : [];
    if (rows.length !== ids.length) throw unprocessable("All referenced issues must exist in the company");
    const result: Record<string, Snapshot> = {};
    for (const issue of rows) {
      const access = await authz.decide({ actor, action: "issue:read", resource: resource(issue) });
      if (!access.allowed) throw forbidden("Decision target is outside the origin visibility boundary");
      const children = await dbOrTx.select({ value: count() }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.parentId, issue.id)));
      result[issue.id] = { status: issue.status, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
        updatedAt: issue.updatedAt.toISOString(), childCount: Number(children[0]?.value ?? 0) };
    }
    return result;
  }

  async function create(input: { companyId: string; actor: AuthorizationActor; agentId: string; runId: string; bundleId?: string | null;
    ruleKey?: string | null; title: string; body: string; options: DecisionOption[]; inputs?: DecisionInput[] | null; expiresAt?: Date | null;
    idempotencyKey?: string | null; continuationPolicy?: "none" | "wake_origin_agent"; metadata?: Record<string, unknown> }, dbOrTx: Db = db) {
    const provenance = await origin(input.companyId, input.agentId, input.runId);
    if (input.idempotencyKey) {
      const existing = await dbOrTx.select().from(decisions).where(and(eq(decisions.companyId, input.companyId), eq(decisions.idempotencyKey, input.idempotencyKey)))
        .then((rows) => rows[0] ?? null);
      if (existing) {
        const equivalent = existing.title === input.title && existing.body === input.body &&
          JSON.stringify(existing.options) === JSON.stringify(input.options) && JSON.stringify(existing.inputs ?? null) === JSON.stringify(input.inputs ?? null);
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
    const targetSnapshots = await snapshots(input.companyId, ids, input.actor, dbOrTx);
    const id = randomUUID();
    const [created] = await dbOrTx.insert(decisions).values({ id, companyId: input.companyId, bundleId: input.bundleId ?? null,
      originAgentId: input.agentId, originIssueId: provenance.issueId, originRunId: input.runId, ruleKey: input.ruleKey ?? null,
      title: input.title, body: input.body, options: input.options, inputs: input.inputs ?? null, expiresAt,
      idempotencyKey: input.idempotencyKey ?? null, signedSpec: signDecisionSpec(spec({ id, options: input.options, targetSnapshots })),
      targetSnapshots, continuationPolicy: input.continuationPolicy ?? "none", metadata: input.metadata ?? {} }).returning();
    if (ids.length) await dbOrTx.insert(decisionTargetIssues).values(ids.map((issueId) => ({ decisionId: id, issueId, companyId: input.companyId })));
    await logActivity(dbOrTx, { companyId: input.companyId, actorType: "agent", actorId: input.agentId, agentId: input.agentId,
      runId: input.runId, action: "decision.created", entityType: "decision", entityId: id,
      details: { originIssueId: provenance.issueId, originAgentId: input.agentId, originResponsibleUserId: provenance.run.responsibleUserId } });
    return created;
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
    return Promise.all(rows.map(async (decision) => {
      const changed: Record<string, boolean> = {};
      if (decision.status === "open") for (const [id, snapshot] of Object.entries(decision.targetSnapshots as Record<string, Snapshot>)) {
        const current = await db.select({ updatedAt: issues.updatedAt }).from(issues).where(eq(issues.id, id)).then((items) => items[0] ?? null);
        changed[id] = !current || current.updatedAt.toISOString() !== snapshot.updatedAt;
      }
      return { ...decision, targetChanged: changed };
    }));
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
      return await db.transaction(async (tx) => {
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
        const referencedIds = new Set([effect.targetIssueId]);
        if (effect.type === "create_issue") {
          if (effect.draft.parentId) referencedIds.add(effect.draft.parentId);
          for (const id of effect.draft.blockedByIssueIds ?? []) referencedIds.add(id);
        }
        if (effect.type === "resolve_blocker") for (const id of effect.removeBlockedByIssueIds) referencedIds.add(id);
        const referencedIssues = await tx.select().from(issues).where(and(eq(issues.companyId, decision.companyId), inArray(issues.id, [...referencedIds])));
        if (referencedIssues.length !== referencedIds.size) return finish("failed", "invalid_effect_reference", { reason: "invalid_effect_reference" });
        const target = referencedIssues.find((item) => item.id === effect.targetIssueId)!;
        const originActor: AuthorizationActor = { type: "agent", agentId: decision.originAgentId, companyId: decision.companyId,
          runId: decision.originRunId, onBehalfOfUserId: originResponsibleUserId, source: "agent_jwt" };
        const originAccess = await Promise.all(referencedIssues.map((item) => authz.decide({ actor: originActor, action: "issue:read", resource: resource(item) })));
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
        const snapshot = (decision.targetSnapshots as Record<string, Snapshot>)[target.id];
        if (effect.staleness === "strict" && (!snapshot || snapshot.updatedAt !== target.updatedAt.toISOString())) return finish("skipped", "target_changed", { reason: "target_changed" });
        const svc = issueService(tx as unknown as Db);
        const values = decision.inputValues ?? {};
        let result: Record<string, unknown>;
        if (effect.type === "comment_on_issue") {
          const comment = await svc.addComment(target.id, interpolate(effect.bodyMarkdown, values), { userId: decidedByUserId }, undefined, tx);
          result = { commentId: comment.id };
        } else if (effect.type === "update_issue_status") {
          const updated = await svc.update(target.id, { status: effect.status, actorUserId: decidedByUserId }, tx);
          if (effect.comment) await svc.addComment(target.id, interpolate(effect.comment, values), { userId: decidedByUserId }, undefined, tx);
          result = { issueId: updated?.id, status: updated?.status };
        } else if (effect.type === "assign_issue") {
          const updated = await svc.update(target.id, { assigneeAgentId: effect.assigneeAgentId ?? null, assigneeUserId: effect.assigneeUserId ?? null, actorUserId: decidedByUserId }, tx);
          if (effect.comment) await svc.addComment(target.id, interpolate(effect.comment, values), { userId: decidedByUserId }, undefined, tx);
          result = { issueId: updated?.id };
        } else if (effect.type === "resolve_blocker") {
          const current = await tx.select({ id: issueRelations.relatedIssueId }).from(issueRelations).where(and(eq(issueRelations.companyId, decision.companyId), eq(issueRelations.issueId, target.id), eq(issueRelations.type, "blocks")));
          await svc.update(target.id, { blockedByIssueIds: current.map((row) => row.id).filter((id) => !effect.removeBlockedByIssueIds.includes(id)), actorUserId: decidedByUserId }, tx);
          result = { removedBlockedByIssueIds: effect.removeBlockedByIssueIds };
        } else if (effect.type === "create_issue") {
          const draft = effect.draft;
          const created = await svc.create(decision.companyId, { title: draft.title, description: draft.description ?? null, parentId: draft.parentId ?? target.id,
            assigneeAgentId: draft.assigneeAgentId ?? null, assigneeUserId: draft.assigneeUserId ?? null, projectId: draft.projectId ?? target.projectId,
            goalId: draft.goalId ?? null, blockedByIssueIds: draft.blockedByIssueIds ?? [], createdByUserId: decidedByUserId, actorRunId: decision.originRunId,
            idempotencyKey: `decision-effect:${decision.id}:${effectIndex}` });
          result = { issueId: created.id };
        } else {
          const queue = [target.id]; const cancelled: string[] = [];
          while (queue.length) { const id = queue.shift()!; cancelled.push(id); const children = await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, decision.companyId), eq(issues.parentId, id))); queue.push(...children.map((row) => row.id)); }
          for (const id of cancelled.reverse()) await svc.update(id, { status: "cancelled", actorUserId: decidedByUserId }, tx);
          await svc.addComment(target.id, interpolate(effect.reasonComment, values), { userId: decidedByUserId }, undefined, tx);
          result = { cancelledIssueIds: cancelled };
        }
        const activity = await effectAudit(tx as unknown as Db, decision, execution.id, effect, "executed", decidedByUserId, originResponsibleUserId, result);
        const [row] = await tx.update(decisionEffectExecutions).set({ status: "executed", result, error: null, activityLogId: activity?.id ?? null, executedAt: new Date() }).where(eq(decisionEffectExecutions.id, execution.id)).returning();
        return row;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Decision effect execution failed";
      return recordFailure("effect_execution_failed", { reason: "effect_execution_failed", message });
    }
  }

  async function runEffects(decision: typeof decisions.$inferSelect, userActor: AuthorizationActor) {
    const option = decision.options.find((item) => item.id === decision.chosenOptionId);
    if (!option || !decision.decidedByUserId) throw unprocessable("Stored decision outcome is invalid");
    const run = await db.select({ responsibleUserId: heartbeatRuns.responsibleUserId }).from(heartbeatRuns).where(eq(heartbeatRuns.id, decision.originRunId)).then((rows) => rows[0] ?? null);
    for (let index = 0; index < option.effects.length; index += 1) await executeEffect(decision, option.effects[index]!, index, userActor, decision.decidedByUserId, run?.responsibleUserId ?? null);
    const rows = await db.select().from(decisionEffectExecutions).where(eq(decisionEffectExecutions.decisionId, decision.id));
    const successful = rows.filter((row) => row.status === "executed").length;
    const status = rows.every((row) => row.status === "executed") ? "succeeded" : successful ? "partial" : "failed";
    await db.update(decisions).set({ executionStatus: status, updatedAt: new Date() }).where(eq(decisions.id, decision.id));
    return outcome(decision.id);
  }

  async function decide(input: { id: string; optionId: string; inputValues?: Record<string, string>; idempotencyKey?: string | null; decidedByUserId: string; userActor: AuthorizationActor }) {
    const current = await get(input.id); if (!current) throw notFound("Decision not found");
    const metadata = current.metadata as Record<string, unknown>;
    if (!verifyDecisionSpec(spec({ id: current.id, options: current.options, targetSnapshots: current.targetSnapshots as Record<string, Snapshot> }), current.signedSpec)) throw forbidden("Decision signature verification failed");
    if (current.status === "decided" && input.idempotencyKey && metadata.decideIdempotencyKey === input.idempotencyKey) {
      if (current.decidedByUserId !== input.decidedByUserId) throw forbidden("Decision replay belongs to a different user");
      return current.executionStatus === "running" ? runEffects(current, input.userActor) : outcome(current.id);
    }
    if (current.status !== "open") throw conflict("decision_already_resolved", { code: "decision_already_resolved" });
    if (!current.options.some((option) => option.id === input.optionId)) throw unprocessable("Unknown optionId");
    const values = input.inputValues ?? {};
    for (const field of current.inputs ?? []) { const value = values[field.id] ?? ""; if (field.required && !value.trim()) throw unprocessable(`Input ${field.id} is required`); if (field.maxLength && value.length > field.maxLength) throw unprocessable(`Input ${field.id} is too long`); }
    const [claimed] = await db.update(decisions).set({ status: "decided", executionStatus: "running", chosenOptionId: input.optionId, inputValues: values,
      decidedByUserId: input.decidedByUserId, decidedAt: new Date(), updatedAt: new Date(), metadata: { ...metadata, decideIdempotencyKey: input.idempotencyKey ?? null } })
      .where(and(eq(decisions.id, current.id), eq(decisions.status, "open"))).returning();
    if (!claimed) throw conflict("decision_already_resolved", { code: "decision_already_resolved" });
    const run = await db.select({ responsibleUserId: heartbeatRuns.responsibleUserId }).from(heartbeatRuns).where(eq(heartbeatRuns.id, claimed.originRunId)).then((rows) => rows[0] ?? null);
    await logActivity(db, { companyId: claimed.companyId, actorType: "system", actorId: "decision-executor", agentId: claimed.originAgentId, runId: claimed.originRunId,
      responsibleUserIdOverride: input.decidedByUserId, action: "decision.decided", entityType: "decision", entityId: claimed.id,
      details: { chosenOptionId: input.optionId, decidedByUserId: input.decidedByUserId, originResponsibleUserId: run?.responsibleUserId ?? null } });
    const result = await runEffects(claimed, input.userActor);
    if (claimed.continuationPolicy === "wake_origin_agent") await options.wakeOriginAgent?.({ companyId: claimed.companyId, agentId: claimed.originAgentId, issueId: claimed.originIssueId, decisionId: claimed.id, outcome: "decided" });
    return result;
  }

  async function cancel(id: string, actor: { actorType: "agent" | "user"; actorId: string; runId?: string | null }) {
    const current = await get(id); if (!current) throw notFound("Decision not found");
    if (actor.actorType === "agent" && actor.actorId !== current.originAgentId) throw forbidden("Only the origin agent may cancel");
    const [updated] = await db.update(decisions).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(decisions.id, id), eq(decisions.status, "open"))).returning();
    if (!updated) throw conflict("decision_already_resolved", { code: "decision_already_resolved" });
    await logActivity(db, { companyId: updated.companyId, actorType: actor.actorType, actorId: actor.actorId, runId: actor.runId, action: "decision.cancelled", entityType: "decision", entityId: id });
    return updated;
  }

  async function dismiss(id: string, userId: string, userActor: AuthorizationActor, reason?: string | null) {
    const current = await get(id); if (!current) throw notFound("Decision not found");
    const empty = current.options.find((option) => option.effects.length === 0);
    if (empty) return decide({ id, optionId: empty.id, decidedByUserId: userId, userActor });
    const [updated] = await db.update(decisions).set({ status: "decided", executionStatus: "succeeded", chosenOptionId: "dismissed", decidedByUserId: userId,
      decidedAt: new Date(), updatedAt: new Date(), metadata: { ...current.metadata, dismissed: true, dismissReason: reason ?? null } }).where(and(eq(decisions.id, id), eq(decisions.status, "open"))).returning();
    if (!updated) throw conflict("decision_already_resolved", { code: "decision_already_resolved" });
    await logActivity(db, { companyId: updated.companyId, actorType: "system", actorId: "decision-executor", agentId: updated.originAgentId,
      runId: updated.originRunId, responsibleUserIdOverride: userId, action: "decision.decided", entityType: "decision", entityId: updated.id,
      details: { chosenOptionId: "dismissed", decidedByUserId: userId, dismissed: true } });
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
    const rows = await db.select().from(decisions).where(eq(decisions.status, "open")); let expired = 0;
    for (const decision of rows) { const strictTargetIds = new Set(decision.options.flatMap((option) => option.effects.filter((effect) => effect.staleness === "strict").map((effect) => effect.targetIssueId)));
      const targets = strictTargetIds.size > 0
        ? await db.select({ id: issues.id, status: issues.status }).from(issues).where(and(eq(issues.companyId, decision.companyId), inArray(issues.id, [...strictTargetIds])))
        : [];
      const targetGone = targets.length !== strictTargetIds.size || targets.some((target) => target.status === "cancelled");
      if (!targetGone && decision.expiresAt >= now) continue;
      const reason = targetGone ? "target_gone" : "ttl";
      const [updated] = await db.update(decisions).set({ status: "expired", updatedAt: now, metadata: { ...decision.metadata, expiredReason: reason } }).where(and(eq(decisions.id, decision.id), eq(decisions.status, "open"))).returning();
      if (!updated) continue; expired += 1;
      await logActivity(db, { companyId: updated.companyId, actorType: "system", actorId: "decision-expiry-sweeper", agentId: updated.originAgentId, runId: updated.originRunId, action: "decision.expired", entityType: "decision", entityId: updated.id, details: { expiredReason: reason } });
      if (updated.continuationPolicy === "wake_origin_agent") await options.wakeOriginAgent?.({ companyId: updated.companyId, agentId: updated.originAgentId, issueId: updated.originIssueId, decisionId: updated.id, outcome: "expired" }); }
    return { expired };
  }

  return { create, createBundle, get, list, outcome, decide, cancel, dismiss, sweepExpired };
}
