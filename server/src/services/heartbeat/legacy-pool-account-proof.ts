import { and, eq } from "drizzle-orm";
import { companySecrets, type Db } from "@paperclipai/db";
import type { AiConnectionRouterSelection } from "@paperclipai/shared";
import { aiConnectionService } from "../ai-connections.js";
import { quotaIdentityFromSessionSnapshot } from "../ai-connection-router.js";
import { POOL_ACCOUNT_DEFAULT_COOLDOWN_MS } from "../ai-connection-pool-cooldown.js";

type Scope = { companyId: string; agentId: string; userId: string | null;
  selection: AiConnectionRouterSelection; credentialIdentity: string | undefined };
export type LegacyPoolAccountProof = { secretId: string; epoch: number; version: number; retryAt: Date; providerEvidence: "anthropic_oauth_usage_v1" | "codex_wham_v1" | "saved_account_http_401_v1" };

async function selectedCredential(db: Db, input: Scope, lock = false) {
  const binding = input.selection.binding;
  if (binding.mode === "responsible_user" || !["anthropic", "openai"].includes(binding.provider) || binding.method !== "subscription" ||
      !input.credentialIdentity || !input.userId) return null;
  const selected = await aiConnectionService(db).select({ companyId: input.companyId, agentId: input.agentId,
    userId: input.userId, adapterType: binding.provider === "openai" ? "codex_local" : "claude_local", binding, model: input.selection.runtimeConfig.model });
  const ref = selected.grant.credentialSecretRefs.find(item => item.configPath === "ai.credential");
  if (!ref) return null;
  const query = db.select({ id: companySecrets.id, epoch: companySecrets.aiSessionEpoch, latestVersion: companySecrets.latestVersion }).from(companySecrets)
    .where(and(eq(companySecrets.companyId, input.companyId), eq(companySecrets.id, ref.secretId)));
  const [secret] = await (lock ? query.for("share") : query);
  return secret && quotaIdentityFromSessionSnapshot(selected.grant.id, input.credentialIdentity) === `secret:${secret.id}:${secret.epoch}`
    ? { ...secret, version: typeof ref.versionSelector === "number" ? ref.versionSelector : secret.latestVersion } : null;
}

/** CLI text is model-visible. Only an observation using the saved credential
 * can authorize a durable account-wide failure effect for a legacy provider. */
export async function observeLegacyPoolAccountFailure(db: Db, input: Scope, now: Date, kind: "quota" | "auth"): Promise<LegacyPoolAccountProof | null> {
  try {
    const before = await selectedCredential(db, input);
    if (!before || !input.userId || input.selection.binding.mode === "responsible_user") return null;
    const usage = await aiConnectionService(db).probeUsage(input.companyId, input.userId,
      input.selection.binding.connectionId, input.selection.binding.grantId);
    let providerEvidence: LegacyPoolAccountProof["providerEvidence"];
    let retryAt: Date;
    if (kind === "auth") {
      if (usage.errorCode !== "authentication_required" || usage.providerStatus !== 401) return null;
      providerEvidence = "saved_account_http_401_v1";
      retryAt = new Date(now.getTime() + POOL_ACCOUNT_DEFAULT_COOLDOWN_MS);
    } else {
      const evidence = usage.source === "anthropic_oauth" ? "anthropic_oauth_usage_v1"
        : usage.source === "codex_wham" ? "codex_wham_v1" : null;
      const accountDenied = usage.source === "anthropic_oauth" ? usage.overage?.enabled === false
        : usage.source === "codex_wham" && usage.overage?.available === false && usage.overage.unlimited === false;
      const exhausted = usage.status === "ok" && evidence && accountDenied
        ? usage.limits.filter(limit => limit.scope === null && limit.limitReached === true &&
            (usage.source !== "codex_wham" || limit.allowed === false)) : [];
      if (!exhausted.length || !evidence) return null;
      providerEvidence = evidence;
      const resets = exhausted.map(limit => Date.parse(limit.resetsAt ?? "")).filter(reset => Number.isFinite(reset) && reset > now.getTime());
      retryAt = new Date(resets.length ? Math.max(...resets) : now.getTime() + POOL_ACCOUNT_DEFAULT_COOLDOWN_MS);
    }
    const after = await selectedCredential(db, input);
    if (!after || after.id !== before.id || after.epoch !== before.epoch || (kind === "auth" && after.version !== before.version)) return null;
    return { secretId: before.id, epoch: before.epoch, version: before.version, providerEvidence, retryAt };
  } catch { return null; }
}

export async function isCurrentLegacyPoolAccountProof(db: Db, input: Scope, proof: LegacyPoolAccountProof) {
  try {
    const current = await selectedCredential(db, input, true);
    return current?.id === proof.secretId && current.epoch === proof.epoch &&
      (proof.providerEvidence !== "saved_account_http_401_v1" || current.version === proof.version);
  } catch { return false; }
}

export function legacyPoolAccountEvidenceMatches(kind: "quota" | "auth", provider: unknown, evidence: unknown) {
  if (provider !== "anthropic" && provider !== "openai") return false;
  return evidence === (kind === "auth" ? "saved_account_http_401_v1"
    : provider === "anthropic" ? "anthropic_oauth_usage_v1" : "codex_wham_v1");
}
