import { and, eq, sql } from "drizzle-orm";
import { activityLog, mcpOauthGrants, mcpOauthRequests, museAgentBindings, type Db } from "@paperclipai/db";
import { withExternalAdmissionGuard } from "../../modules/external-agents/index.js";
import { logger } from "../../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";

const checks = ["verifier_format", "client_mismatch", "redirect_mismatch", "resource_mismatch", "pkce_mismatch", "code_consumed", "code_expired", "binding_unavailable", "grant_unavailable", "current_authority_unavailable"] as const;
export type MuseCodeExchangeCheck = typeof checks[number];
type BindingScope = Pick<typeof museAgentBindings.$inferSelect, "id" | "companyId" | "agentId" | "operatorId" | "generation" | "grantId">;
type CodeTimes = Pick<typeof mcpOauthRequests.$inferSelect, "decidedAt" | "expiresAt">;
export type MuseCodeExchangeObservation = {
  receivedAt: Date;
  startedAt: number;
  decisionAt?: Date;
  decisionLatencyMs?: number;
  failedChecks: MuseCodeExchangeCheck[];
  binding?: BindingScope;
  codeTimes?: CodeTimes;
  publications: ActivityPublication[];
};

export function beginMuseCodeExchange(receivedAt: Date): MuseCodeExchangeObservation {
  return { receivedAt, startedAt: performance.now(), failedChecks: [], publications: [] };
}

export function observeMuseCodeBinding(observation: MuseCodeExchangeObservation | undefined, binding: BindingScope) {
  if (observation) observation.binding = { id: binding.id, companyId: binding.companyId, agentId: binding.agentId,
    operatorId: binding.operatorId, generation: binding.generation, grantId: binding.grantId };
}

export function decideMuseCodeExchange(observation: MuseCodeExchangeObservation | undefined, failedChecks: MuseCodeExchangeCheck[], codeTimes?: CodeTimes) {
  if (!observation) return;
  observation.decisionAt = new Date();
  observation.decisionLatencyMs = Math.max(0, Math.round((performance.now() - observation.startedAt) * 1000) / 1000);
  observation.failedChecks = checks.filter(check => failedChecks.includes(check));
  if (codeTimes) observation.codeTimes = { decidedAt: codeTimes.decidedAt, expiresAt: codeTimes.expiresAt };
}

function timing(observation: MuseCodeExchangeObservation, codeTimes: CodeTimes) {
  const authorizationAt = observation.codeTimes?.decidedAt ?? codeTimes.decidedAt;
  const deadlineAt = observation.codeTimes?.expiresAt ?? codeTimes.expiresAt;
  const dates = [observation.receivedAt, observation.decisionAt, authorizationAt, deadlineAt];
  if (dates.some(date => !date || !Number.isFinite(date.getTime())) || !Number.isFinite(observation.decisionLatencyMs)) return null;
  return { receivedAt: observation.receivedAt.toISOString(), decisionAt: observation.decisionAt!.toISOString(),
    authorizationAt: authorizationAt!.toISOString(), deadlineAt: deadlineAt.toISOString(),
    codeAgeMs: observation.decisionAt!.getTime() - authorizationAt!.getTime(), decisionLatencyMs: observation.decisionLatencyMs! };
}

export function publishMuseCodeActivities(publications: ActivityPublication[]) {
  for (const publication of publications) {
    try { publishActivity(publication); }
    catch { logger.warn("Could not publish committed Muse OAuth exchange activity"); }
  }
}

export async function recordMuseCodeSuccess(tx: Db, observation: MuseCodeExchangeObservation, code: CodeTimes,
  grant: typeof mcpOauthGrants.$inferSelect) {
  const binding = observation.binding, times = timing(observation, code);
  if (!binding || binding.grantId !== grant.id || binding.companyId !== grant.companyId || binding.agentId !== grant.agentId
    || binding.operatorId !== grant.userId || !times) throw new Error("Muse OAuth exchange diagnostic scope is unavailable");
  await logActivity(tx, { companyId: binding.companyId, actorType: "system", actorId: "muse-oauth",
    action: "muse.oauth_code_exchange_succeeded", entityType: "agent", entityId: binding.agentId, agentId: binding.agentId,
    responsibleUserIdOverride: grant.userId,
    details: { schemaVersion: 1, bindingId: binding.id, generation: binding.generation, grantId: grant.id, ...times } }, observation.publications);
}

export async function recordMuseCodeRejection(db: Db, resource: string, codeHash: string, observation: MuseCodeExchangeObservation) {
  if (!observation.failedChecks.length || !observation.decisionAt) return;
  try {
    const [source] = await db.select({ grantId: mcpOauthRequests.grantId }).from(mcpOauthRequests).where(eq(mcpOauthRequests.codeHash, codeHash));
    if (!source?.grantId) return;
    const [grant] = await db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, source.grantId));
    if (!grant?.agentId || grant.purpose !== "agent" || grant.resource !== resource) return;
    const scope = observation.binding;
    if (scope && (scope.grantId !== grant.id || scope.companyId !== grant.companyId || scope.agentId !== grant.agentId || scope.operatorId !== grant.userId)) return;
    const [candidate] = await db.select().from(museAgentBindings).where(and(eq(museAgentBindings.grantId, grant.id),
      eq(museAgentBindings.companyId, grant.companyId), eq(museAgentBindings.agentId, grant.agentId), eq(museAgentBindings.operatorId, grant.userId),
      scope ? eq(museAgentBindings.id, scope.id) : undefined, scope ? eq(museAgentBindings.generation, scope.generation) : undefined));
    if (!candidate) return;
    const publications: ActivityPublication[] = [];
    await db.transaction(tx => withExternalAdmissionGuard(tx, candidate.companyId, candidate.agentId, async () => {
      const [binding] = await tx.select().from(museAgentBindings).where(and(eq(museAgentBindings.id, candidate.id),
        eq(museAgentBindings.generation, candidate.generation), eq(museAgentBindings.grantId, grant.id),
        eq(museAgentBindings.companyId, candidate.companyId), eq(museAgentBindings.agentId, candidate.agentId),
        eq(museAgentBindings.operatorId, candidate.operatorId))).for("update");
      if (!binding) return;
      const [code] = await tx.select().from(mcpOauthRequests).where(and(eq(mcpOauthRequests.codeHash, codeHash),
        eq(mcpOauthRequests.grantId, grant.id))).for("update");
      const [currentGrant] = await tx.select().from(mcpOauthGrants).where(and(eq(mcpOauthGrants.id, grant.id),
        eq(mcpOauthGrants.companyId, binding.companyId), eq(mcpOauthGrants.agentId, binding.agentId),
        eq(mcpOauthGrants.userId, binding.operatorId), eq(mcpOauthGrants.purpose, "agent"), eq(mcpOauthGrants.resource, resource))).for("update");
      if (!code || !currentGrant || code.resource !== resource || code.requestedCompanyId !== binding.companyId || code.clientId !== currentGrant.clientId) return;
      const times = timing(observation, code);
      if (!times) return;
      for (const check of observation.failedChecks) {
        const action = `muse.oauth_code_exchange_rejected_${check}`;
        const [existing] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
          eq(activityLog.companyId, binding.companyId), eq(activityLog.actorType, "system"), eq(activityLog.actorId, "muse-oauth"),
          eq(activityLog.entityType, "agent"), eq(activityLog.entityId, binding.agentId), eq(activityLog.agentId, binding.agentId),
          eq(activityLog.responsibleUserId, currentGrant.userId), eq(activityLog.action, action),
          sql`${activityLog.details}->>'bindingId' = ${binding.id}`, sql`${activityLog.details}->>'generation' = ${String(binding.generation)}`,
          sql`${activityLog.details}->>'grantId' = ${currentGrant.id}`)).limit(1);
        if (existing) continue;
        await logActivity(tx as unknown as Db, { companyId: binding.companyId, actorType: "system", actorId: "muse-oauth", action,
          entityType: "agent", entityId: binding.agentId, agentId: binding.agentId, responsibleUserIdOverride: currentGrant.userId,
          details: { schemaVersion: 1, bindingId: binding.id, generation: binding.generation, grantId: currentGrant.id,
            failedChecks: observation.failedChecks, ...times } }, publications);
      }
    }));
    publishMuseCodeActivities(publications);
  } catch { logger.warn("Could not persist Muse OAuth exchange rejection activity"); }
}
