import { and, eq } from "drizzle-orm";
import { companySecrets, type Db } from "@paperclipai/db";
import type { AiConnectionRouterSelection } from "@paperclipai/shared";
import { aiConnectionService } from "../ai-connections.js";
import { quotaIdentityFromSessionSnapshot } from "../ai-connection-router.js";
import { POOL_ACCOUNT_DEFAULT_COOLDOWN_MS } from "./pool-failover.js";

type Scope = { companyId: string; agentId: string; userId: string | null;
  selection: AiConnectionRouterSelection; credentialIdentity: string | undefined };
export type LegacyPoolQuotaProof = { secretId: string; epoch: number; retryAt: Date };

async function selectedCredential(db: Db, input: Scope, lock = false) {
  const binding = input.selection.binding;
  if (binding.mode === "responsible_user" || binding.provider !== "anthropic" || binding.method !== "subscription" ||
      !input.credentialIdentity || !input.userId) return null;
  const selected = await aiConnectionService(db).select({ companyId: input.companyId, agentId: input.agentId,
    userId: input.userId, adapterType: "claude_local", binding, model: input.selection.runtimeConfig.model });
  const ref = selected.grant.credentialSecretRefs.find(item => item.configPath === "ai.credential");
  if (!ref) return null;
  const query = db.select({ id: companySecrets.id, epoch: companySecrets.aiSessionEpoch }).from(companySecrets)
    .where(and(eq(companySecrets.companyId, input.companyId), eq(companySecrets.id, ref.secretId)));
  const [secret] = await (lock ? query.for("share") : query);
  return secret && quotaIdentityFromSessionSnapshot(selected.grant.id, input.credentialIdentity) === `secret:${secret.id}:${secret.epoch}`
    ? secret : null;
}

/** CLI text is model-visible. Only the authenticated account observation can
 * authorize a durable account-wide quota effect for legacy Claude. */
export async function observeLegacyPoolQuota(db: Db, input: Scope, now: Date): Promise<LegacyPoolQuotaProof | null> {
  try {
    const before = await selectedCredential(db, input);
    if (!before || !input.userId || input.selection.binding.mode === "responsible_user") return null;
    const usage = await aiConnectionService(db).probeUsage(input.companyId, input.userId,
      input.selection.binding.connectionId, input.selection.binding.grantId);
    const exhausted = usage.status === "ok" && usage.source === "anthropic_oauth" && usage.overage?.enabled === false
      ? usage.limits.filter(limit => limit.scope === null && limit.limitReached === true) : [];
    if (!exhausted.length) return null;
    const after = await selectedCredential(db, input);
    if (!after || after.id !== before.id || after.epoch !== before.epoch) return null;
    const resets = exhausted.map(limit => Date.parse(limit.resetsAt ?? "")).filter(reset => Number.isFinite(reset) && reset > now.getTime());
    return { secretId: before.id, epoch: before.epoch,
      retryAt: new Date(resets.length ? Math.max(...resets) : now.getTime() + POOL_ACCOUNT_DEFAULT_COOLDOWN_MS) };
  } catch { return null; }
}

export async function isCurrentLegacyPoolQuotaProof(db: Db, input: Scope, proof: LegacyPoolQuotaProof) {
  try {
    const current = await selectedCredential(db, input, true);
    return current?.id === proof.secretId && current.epoch === proof.epoch;
  } catch { return false; }
}
