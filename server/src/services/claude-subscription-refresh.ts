import { and, eq } from "drizzle-orm";
import { companySecrets, connectionGrants, toolConnections, type Db } from "@paperclipai/db";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";
import { claudeAccessTokenOf, claudeRefreshDue, ClaudeOauthRefreshError, parseStoredClaudeOauth, refreshClaudeOauth } from "./claude-oauth-credential.js";

type Selection = { connection: typeof toolConnections.$inferSelect; grant: typeof connectionGrants.$inferSelect };

/** Serialize exchanges with reconnect and other controllers. Only the vault holds refresh tokens. */
export async function refreshClaudeSubscription(
  db: Db,
  row: Selection,
  readRaw: (tx: Db, selection: Selection) => Promise<string>,
): Promise<string> {
  const companyId = row.connection.companyId;
  return withAccountHomeSecretMutationLock(undefined, companyId, async () => {
    // Retain a successful exchange across a failed commit. Never exchange the
    // same single-use refresh token a second time during a save retry.
    let replacement: { value: string; base: string; secretId: string; epoch: number; version: number } | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await db.transaction(async tx => {
          const [grant] = await tx.select().from(connectionGrants).where(and(
            eq(connectionGrants.companyId, companyId), eq(connectionGrants.id, row.grant.id),
            eq(connectionGrants.connectionId, row.connection.id),
          )).for("update", { noWait: true });
          if (!grant || grant.status !== "active") throw unprocessable("Reconnect this AI account", { code: "ai_connection_reauth_required" });
          const ref = grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential");
          if (!ref) throw unprocessable("Reconnect this AI account");
          const [secret] = await tx.select().from(companySecrets).where(and(
            eq(companySecrets.companyId, companyId), eq(companySecrets.id, ref.secretId),
          )).for("update", { noWait: true });
          if (!secret) throw unprocessable("Reconnect this AI account");
          const current = await readRaw(tx as unknown as Db, { connection: row.connection, grant });
          if (replacement && current === replacement.value) return { token: claudeAccessTokenOf(current) };
          // A reconnect or an explicit rotation wins over an uncommitted exchange.
          if (replacement && (secret.id !== replacement.secretId || secret.aiSessionEpoch !== replacement.epoch
            || secret.latestVersion !== replacement.version || current !== replacement.base)) {
            throw unprocessable("The AI credential changed. Retry this execution.", { code: "ai_connection_busy" });
          }
          const stored = parseStoredClaudeOauth(current);
          if (!stored || !claudeRefreshDue(stored)) return { token: claudeAccessTokenOf(current) };
          let refreshed = replacement?.value;
          if (!refreshed) {
            try { refreshed = await refreshClaudeOauth(stored); }
            catch (error) {
              if (stored.expiresAt > Date.now()) return { token: stored.accessToken };
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
          await secretService(tx).rotate(secret.id, { value: refreshed, preserveAiSessionEpoch: true }, { userId: grant.subjectUserId });
          await logActivity(tx as unknown as Db, { companyId, actorType: "system", actorId: "claude_refresh",
            action: "ai_connection.credential_refreshed", entityType: "tool_connection", entityId: row.connection.id,
            details: { provider: "anthropic", grantId: grant.id } });
          return { token: claudeAccessTokenOf(refreshed) };
        });
        if (result.reauth) throw unprocessable("Sign in again to restore this AI connection.", { code: "ai_connection_reauth_required" });
        return result.token!;
      } catch (error) {
        if (!replacement || attempt >= 2) throw error;
      }
    }
  }).catch(error => {
    // SQL row contention and the shared file-lock deadline are temporary waits.
    let cause: unknown = error;
    for (let depth = 0; depth < 4 && cause && typeof cause === "object"; depth++) {
      const entry = cause as { code?: unknown; cause?: unknown };
      if (entry.code === "55P03" || entry.code === WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) {
        throw unprocessable("AI credentials are being updated. Retry shortly.", { code: "ai_connection_busy" });
      }
      cause = entry.cause;
    }
    throw error;
  });
}
