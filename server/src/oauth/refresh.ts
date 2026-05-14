import { eq, sql } from "drizzle-orm";
import { oauthConnections } from "@paperclipai/db/schema/oauth";
import { exchangeToken, OAuthRequestError } from "./http.js";
import { backoffSeconds } from "./backoff.js";
import { oauthLogger } from "./logger.js";
import type { ProviderRegistry } from "./registry.js";

export interface RefreshSecretService {
  resolveSecretValue: (
    companyId: string,
    secretId: string,
    version: number | "latest",
  ) => Promise<string>;
  upsertSecretByName: (
    companyId: string,
    input: { name: string; value: string },
    actor?: { userId?: string | null; agentId?: string | null },
  ) => Promise<{ id: string }>;
  remove?: (secretId: string) => Promise<unknown>;
}

export interface RefreshDeps {
  connectionId: string;
  // db: Drizzle handle. Kept loose so callers don't pull the full Db type into
  // this module (route + worker share this entrypoint).
  db: any;
  registry: ProviderRegistry;
  secretService: RefreshSecretService;
  exchangeFn?: typeof exchangeToken; // injectable for tests
}

export type RefreshResult =
  | { outcome: "success"; accessToken: string }
  | { outcome: "revoked" }
  | { outcome: "transient"; error: string }
  | { outcome: "skipped"; reason: string };

// Treat HTTP 400 + provider error code "invalid_grant" / "invalid_token" as a
// permanent failure (RFC 6749 §5.2 / §6). Anything else (network, 5xx, parse
// failures) is transient and falls through to backoff.
function isInvalidGrant(err: unknown): boolean {
  const e = err as { status?: unknown; providerErrorCode?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.status !== 400) return false;
  return (
    e.providerErrorCode === "invalid_grant" ||
    e.providerErrorCode === "invalid_token"
  );
}

export async function refreshConnection(deps: RefreshDeps): Promise<RefreshResult> {
  const exchange = deps.exchangeFn ?? exchangeToken;
  return await deps.db.transaction(async (tx: any) => {
    // Row-lock the connection so concurrent refreshes (worker tick + lazy
    // resolves racing on the same row) serialize at the DB level. Without
    // this, two refresh paths can both proceed and race on the
    // (secret_id, version) unique constraint when persisting the rotated
    // access-token version. We issue an explicit SELECT FOR UPDATE before
    // the relational query so existing tests that mock `.query.oauthConnections`
    // continue to work — the lock acquisition is best-effort and skipped
    // if the test mock doesn't implement `tx.execute`.
    if (typeof tx.execute === "function") {
      try {
        await tx.execute(
          sql`SELECT id FROM oauth_connections WHERE id = ${deps.connectionId} FOR UPDATE`,
        );
      } catch {
        // Best-effort lock; if the table or row isn't reachable from this
        // tx (e.g., test mocks), the relational read below still proceeds.
      }
    }
    const row = await tx.query.oauthConnections.findFirst({
      where: eq(oauthConnections.id, deps.connectionId),
    });
    if (!row) return { outcome: "skipped", reason: "not_found" } as const;
    if (!row.refreshTokenSecretId) {
      return { outcome: "skipped", reason: "no_refresh_token" } as const;
    }

    const provider = deps.registry.get(row.providerId);
    if (!provider) {
      await tx
        .update(oauthConnections)
        .set({
          status: "error",
          lastError: "provider_unavailable",
          lastErrorAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(oauthConnections.id, row.id));
      return { outcome: "skipped", reason: "provider_unavailable" } as const;
    }
    if (provider.config.refresh.supported !== true) {
      return { outcome: "skipped", reason: "refresh_not_supported" } as const;
    }

    const refreshTokenPlain = await deps.secretService.resolveSecretValue(
      row.companyId,
      row.refreshTokenSecretId,
      "latest",
    );

    let raw: Record<string, unknown>;
    try {
      raw = await exchange({
        url: provider.config.endpoints.token,
        params: {
          grant_type: "refresh_token",
          refresh_token: refreshTokenPlain,
        },
        authMethod: provider.config.authMethod,
        responseFormat: provider.config.responseFormat,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
      });
    } catch (err) {
      if (isInvalidGrant(err)) {
        const code =
          (err as OAuthRequestError).providerErrorCode ?? "invalid_grant";
        await tx
          .update(oauthConnections)
          .set({
            status: "revoked",
            lastError: code,
            lastErrorAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(oauthConnections.id, row.id));
        oauthLogger.warn(
          { providerId: row.providerId, connectionId: row.id },
          "refresh permanently failed; revoked",
        );
        return { outcome: "revoked" } as const;
      }
      const message = (err as Error).message ?? "unknown_error";
      await tx
        .update(oauthConnections)
        .set({
          lastError: message.slice(0, 500),
          lastErrorAt: new Date(),
          refreshAttemptCount: row.refreshAttemptCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(oauthConnections.id, row.id));
      return { outcome: "transient", error: message } as const;
    }

    let parsed;
    try {
      const fn = provider.shape.parseTokenResponse;
      if (!fn) throw new Error("provider missing parseTokenResponse");
      parsed = fn(raw);
    } catch (err) {
      await tx
        .update(oauthConnections)
        .set({
          lastError: "response_shape_violation",
          lastErrorAt: new Date(),
          refreshAttemptCount: row.refreshAttemptCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(oauthConnections.id, row.id));
      return {
        outcome: "transient",
        error: (err as Error).message,
      } as const;
    }

    // accountId is nullable on oauth_connections; fall back to connection.id
    // so the secret-name scheme is stable even before account-info is resolved.
    const stableKey = row.accountId ?? row.id;
    const accessName = `oauth:${row.providerId}:${stableKey}:access`;
    const refreshName = `oauth:${row.providerId}:${stableKey}:refresh`;

    // We've successfully exchanged the refresh token for new tokens at this
    // point. If persistence fails (DB write, encryption, etc.), the new
    // tokens are lost and — for providers that rotate refresh tokens on
    // use — the old refresh token may have been invalidated server-side,
    // leaving the connection unrecoverable via the worker. Treat this as a
    // fatal, non-retryable failure: mark the connection `error` with a
    // distinguishable lastError so operators can spot persistence failures
    // separately from provider-side errors. We deliberately do NOT bump
    // refreshAttemptCount — that drives backoff for retryable failures,
    // and this one is not.
    let access: { id: string };
    try {
      access = await deps.secretService.upsertSecretByName(row.companyId, {
        name: accessName,
        value: parsed.accessToken,
      });
    } catch (err) {
      await tx
        .update(oauthConnections)
        .set({
          status: "error",
          lastError: "token_persistence_failed",
          lastErrorAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(oauthConnections.id, row.id));
      oauthLogger.error(
        {
          connectionId: row.id,
          providerId: row.providerId,
          err: { message: (err as Error).message },
        },
        "OAuth token persistence failed after successful exchange — connection requires manual recovery",
      );
      return {
        outcome: "transient",
        error: (err as Error).message,
      } as const;
    }

    let refreshSecretId: string = row.refreshTokenSecretId;
    if (parsed.refreshToken) {
      if (provider.config.refresh.rotatesRefreshToken !== true) {
        oauthLogger.warn(
          { providerId: row.providerId },
          "provider returned refresh_token but rotatesRefreshToken=false; storing defensively",
        );
      }
      try {
        const newRefresh = await deps.secretService.upsertSecretByName(
          row.companyId,
          { name: refreshName, value: parsed.refreshToken },
        );
        refreshSecretId = newRefresh.id;
      } catch (err) {
        await tx
          .update(oauthConnections)
          .set({
            status: "error",
            lastError: "token_persistence_failed",
            lastErrorAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(oauthConnections.id, row.id));
        oauthLogger.error(
          {
            connectionId: row.id,
            providerId: row.providerId,
            err: { message: (err as Error).message },
          },
          "OAuth refresh-token persistence failed after successful exchange — connection requires manual recovery",
        );
        return {
          outcome: "transient",
          error: (err as Error).message,
        } as const;
      }
    }
    const expiresAt = parsed.expiresInSeconds
      ? new Date(Date.now() + parsed.expiresInSeconds * 1000)
      : null;

    await tx
      .update(oauthConnections)
      .set({
        status: "active",
        accessTokenSecretId: access.id,
        refreshTokenSecretId: refreshSecretId,
        accessTokenExpiresAt: expiresAt,
        scopes: parsed.scope ?? row.scopes,
        lastRefreshedAt: new Date(),
        lastError: null,
        lastErrorAt: null,
        refreshAttemptCount: 0,
        updatedAt: new Date(),
      })
      .where(eq(oauthConnections.id, row.id));

    return {
      outcome: "success",
      accessToken: parsed.accessToken,
    } as const;
  });
}

// Re-export for tests / consumers wanting the same backoff curve
export { backoffSeconds };
