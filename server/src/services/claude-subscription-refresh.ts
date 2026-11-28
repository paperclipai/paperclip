import { createHash } from "node:crypto";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { companySecrets, connectionGrants, heartbeatRuns, toolConnections, type Db } from "@paperclipai/db";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { aiConnectionConfigurationFailure } from "./ai-connection-configuration-failure.js";
import { logActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";
import { AI_CREDENTIAL_HOLDER_KEY } from "./run-ai-credential-holder.js";
import { registerIdleLocalWorkProbe } from "./idle-local-work.js";
import { claudeRenewalAfterRejection, hasPendingClaudeExchange, pendingClaudeExchanges, type PendingClaudeExchange } from "./claude-pending-exchanges.js";
import { isTransientLockContention, retryTransientLockContention } from "./transient-lock-contention.js";
import { CLAUDE_REFRESH_FORCE_MS, CLAUDE_REFRESH_MARGIN_MS, claudeAccessTokenOf, claudeRefreshDue, claudeScopesAllowRun, ClaudeOauthRefreshError, parseStoredClaudeOauth, refreshClaudeOauth } from "./claude-oauth-credential.js";

type Replacement = PendingClaudeExchange;
// One pending obligation per grant, kept in `claude-pending-exchanges.ts`. No
// timer or secondary credential store. A temporary vault outage must not
// discard a single-use provider exchange.
export { claudeRenewalAfterRejection, hasPendingClaudeExchange };
// An unsaved pair is the only working refresh token of its sign-in. An idle
// shutdown must wait for its save.
registerIdleLocalWorkProbe(() => pendingClaudeExchanges.blocksIdle() ? "present" : "none");

/**
 * An account test or an agent verification holds a token like a run does, but
 * it has no run row. Each one in flight is counted here, per grant, from the
 * moment it receives the token until it releases the hold.
 */
export type ClaudeProbeHold = { release?: () => void };
const probeHolders = new Map<string, Set<{ until: number }>>();
// A hold protects one token. Once that token has expired the hold protects
// nothing, so a hold that was never released stops counting then.
function probeHeld(key: string): boolean {
  const holds = probeHolders.get(key);
  if (!holds) return false;
  for (const hold of holds) if (hold.until <= Date.now()) holds.delete(hold);
  if (!holds.size) probeHolders.delete(key);
  return holds.size > 0;
}
export type ClaudeRefreshOptions = { currentRunId?: string; probeHold?: ClaudeProbeHold };

type Selection = { connection: typeof toolConnections.$inferSelect; grant: typeof connectionGrants.$inferSelect };

/** Serialize exchanges with reconnect and other controllers. Only the vault holds refresh tokens. */
export async function refreshClaudeSubscription(
  db: Db,
  row: Selection,
  readRaw: (tx: Db, selection: Selection) => Promise<string>,
  options: ClaudeRefreshOptions = {},
): Promise<string> {
  const companyId = row.connection.companyId;
  return withAccountHomeSecretMutationLock(undefined, companyId, async () => {
    // Retain a successful exchange across a failed commit. Never exchange the
    // same single-use refresh token a second time during a save retry.
    const grantId = row.grant.id;
    const holdKey = `${companyId}:${grantId}`;
    let replacement = pendingClaudeExchanges.get(companyId, grantId);
    let recheckedRecovery = false;
    for (let attempt = 0; ; attempt++) {
      let committed = false;
      try {
        // Another preparation's freshness read holds a share lock on the same
        // rows for one statement. Retry briefly instead of failing the run. A
        // retry after an exchange reuses the retained pair.
        const result = await retryTransientLockContention(() => db.transaction(async tx => {
          const [grant] = await tx.select().from(connectionGrants).where(and(
            eq(connectionGrants.companyId, companyId), eq(connectionGrants.id, row.grant.id),
            eq(connectionGrants.connectionId, row.connection.id),
          )).for("update", { noWait: true });
          if (!grant || grant.status !== "active") {
            pendingClaudeExchanges.delete(companyId, grantId);
            throw aiConnectionConfigurationFailure("ai_connection_unavailable", "Reconnect this AI account", { connectionId: row.connection.id });
          }
          const ref = grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential");
          if (!ref) throw unprocessable("Reconnect this AI account");
          const [secret] = await tx.select().from(companySecrets).where(and(
            eq(companySecrets.companyId, companyId), eq(companySecrets.id, ref.secretId),
          )).for("update", { noWait: true });
          if (!secret) throw unprocessable("Reconnect this AI account");
          const current = await readRaw(tx as unknown as Db, { connection: row.connection, grant });
          if (replacement && current === replacement.value) return { value: current, recovered: true };
          // A reconnect or an explicit rotation wins over an uncommitted exchange.
          if (replacement && (secret.id !== replacement.secretId || secret.aiSessionEpoch !== replacement.epoch
            || secret.latestVersion !== replacement.version || current !== replacement.base)) {
            pendingClaudeExchanges.delete(companyId, grantId);
            replacement = undefined;
          }
          const stored = parseStoredClaudeOauth(current);
          if (!stored || (!replacement && !claudeRefreshDue(stored))) return { value: current };
          // The provider revokes the previous access token the moment it issues a
          // new one, and a run cannot replace the token it started with. Renew
          // early only while no other run holds this token; once it is about to
          // expire those runs lose it either way.
          if (!replacement && claudeScopesAllowRun(stored) && stored.expiresAt - CLAUDE_REFRESH_FORCE_MS > Date.now()) {
            const [held] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
              eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running"),
              or(sql`${heartbeatRuns.contextSnapshot}->'aiConnection'->>'grantId' = ${grant.id}`,
                sql`${heartbeatRuns.contextSnapshot}->>${AI_CREDENTIAL_HOLDER_KEY} = ${grant.id}`),
              ...(options.currentRunId ? [ne(heartbeatRuns.id, options.currentRunId)] : []),
            )).limit(1);
            if (held || probeHeld(holdKey)) return { value: current };
          }
          const recovering = Boolean(replacement);
          let refreshed = replacement?.value;
          if (!refreshed) {
            try { refreshed = await refreshClaudeOauth(stored); }
            catch (error) {
              if (stored.expiresAt > Date.now()) {
                if (claudeScopesAllowRun(stored)) return { value: current };
                throw unprocessable("Claude sign-in could not supply an inference-only token. Retry or reconnect.", { code: "ai_connection_busy" });
              }
              if (!(error instanceof ClaudeOauthRefreshError) || !error.rejected) {
                throw unprocessable("Claude sign-in could not be renewed. Retry shortly.", { code: "ai_connection_busy" });
              }
              await tx.update(connectionGrants).set({ status: "needs_reauthorization", updatedAt: new Date() }).where(eq(connectionGrants.id, grant.id));
              await tx.update(toolConnections).set({ healthStatus: "error", healthMessage: "Sign in again to restore this AI connection.", updatedAt: new Date() }).where(eq(toolConnections.id, row.connection.id));
              await logActivity(tx as unknown as Db, { companyId, actorType: "system", actorId: "claude_refresh",
                action: "ai_connection.authentication_failed", entityType: "tool_connection", entityId: row.connection.id,
                details: { provider: "anthropic", grantId: grant.id } });
              return { reauth: true };
            }
          }
          replacement ??= { value: refreshed, base: current, secretId: secret.id, epoch: secret.aiSessionEpoch, version: secret.latestVersion };
          // The pair is wanted while its grant is active and the saved secret
          // is still the one it was exchanged from. A reconnect or an explicit
          // rotation changes the secret and wins over the pair.
          const pair = replacement;
          pendingClaudeExchanges.set(companyId, grantId, pair, async () => {
            try {
              const [current] = await db.select({ status: connectionGrants.status, epoch: companySecrets.aiSessionEpoch, version: companySecrets.latestVersion })
                .from(connectionGrants).innerJoin(companySecrets, and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, pair.secretId)))
                .where(and(eq(connectionGrants.companyId, companyId), eq(connectionGrants.id, grantId)));
              return current?.status === "active" && current.epoch === pair.epoch && current.version === pair.version;
            } catch (err) {
              // The pair is kept: it may hold the only working refresh token.
              // It keeps the server from an idle shutdown until a check succeeds.
              logger.warn({ err, companyId, grantId }, "could not check whether an unsaved Claude sign-in pair is still wanted");
              throw err;
            }
          });
          await secretService(tx).rotate(secret.id, { value: refreshed, preserveAiSessionEpoch: true }, { userId: grant.subjectUserId });
          await logActivity(tx as unknown as Db, { companyId, actorType: "system", actorId: "claude_refresh",
            action: "ai_connection.credential_refreshed", entityType: "tool_connection", entityId: row.connection.id,
            details: { provider: "anthropic", grantId: grant.id } });
          // A stored end of 0 is the mark of a token that the provider refused.
          return { value: refreshed, recovered: recovering, afterRejection: (parseStoredClaudeOauth(replacement.base) ?? stored).expiresAt === 0 };
        }));
        committed = true;
        // Only a confirmed commit or an explicit generation discard settles this obligation.
        pendingClaudeExchanges.delete(companyId, grantId);
        if (result.afterRejection !== undefined) {
          claudeRenewalAfterRejection.set(companyId, grantId, result.afterRejection
            ? createHash("sha256").update(claudeAccessTokenOf(result.value!)).digest("hex").slice(0, 16) : null);
        }
        if (result.reauth) throw aiConnectionConfigurationFailure("ai_connection_unavailable", "Sign in again to restore this AI connection.", { connectionId: row.connection.id });
        const credential = parseStoredClaudeOauth(result.value!);
        if (result.recovered && credential && claudeRefreshDue(credential) && !recheckedRecovery) {
          // First commit the retained pair. It may have expired during a vault
          // outage; renew its saved refresh token before handing it to a run.
          // One recheck is enough: a newly issued but unusable token fails closed.
          recheckedRecovery = true;
          replacement = undefined;
          attempt = -1;
          continue;
        }
        if (credential && credential.expiresAt <= Date.now()) {
          throw unprocessable("Claude sign-in expired during preparation. Retry shortly.", { code: "ai_connection_busy" });
        }
        if (credential && !claudeScopesAllowRun(credential)) {
          // Keep the rotated pair in the vault, but never expose broad permissions.
          throw unprocessable("Claude sign-in could not supply an inference-only token. Retry or reconnect.", { code: "ai_connection_busy" });
        }
        // Record the run that receives the token as its holder before the
        // company credential lock is released. The run's own `aiConnection`
        // is saved only after its preparation finishes; without this mark,
        // another renewal in that interval would not see the run and would
        // revoke its token. Each renewal takes the same lock, so none can run
        // between the commit above and this write.
        if (options.currentRunId) {
          const [marked] = await db.update(heartbeatRuns)
            .set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ [AI_CREDENTIAL_HOLDER_KEY]: row.grant.id })}::jsonb` })
            .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, options.currentRunId)))
            .returning({ id: heartbeatRuns.id });
          // A token handed to a run that has no row would have no holder.
          if (!marked) throw unprocessable("The run that requested this AI credential no longer exists. Retry shortly.", { code: "ai_connection_busy" });
        }
        if (options.probeHold && !options.probeHold.release) {
          const hold = { until: credential?.expiresAt ?? Infinity };
          const holds = probeHolders.get(holdKey) ?? new Set();
          probeHolders.set(holdKey, holds.add(hold));
          options.probeHold.release = () => {
            options.probeHold!.release = () => undefined;
            holds.delete(hold);
            if (!holds.size && probeHolders.get(holdKey) === holds) probeHolders.delete(holdKey);
          };
        }
        return claudeAccessTokenOf(result.value!);
      } catch (error) {
        if (committed || !replacement || attempt >= 2) throw error;
      }
    }
  }).catch(error => {
    // SQL contention that outlasts its retries and the shared file-lock
    // deadline are temporary waits.
    let fileLockTimeout = false;
    for (let cause: unknown = error, depth = 0; depth < 4 && cause && typeof cause === "object"; depth++) {
      const entry = cause as { code?: unknown; cause?: unknown };
      if (entry.code === WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) fileLockTimeout = true;
      cause = entry.cause;
    }
    if (fileLockTimeout || isTransientLockContention(error)) {
      throw unprocessable("AI credentials are being updated. Retry shortly.", { code: "ai_connection_busy" });
    }
    throw error;
  });
}
