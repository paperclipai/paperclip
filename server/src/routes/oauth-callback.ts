import { Router, type RequestHandler } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  oauthAuthorizationStates,
  oauthConnections,
} from "@paperclipai/db/schema/oauth";
import { exchangeToken, fetchAccountInfo } from "../oauth/http.js";
import { oauthLogger } from "../oauth/logger.js";
import { validateReturnUrl } from "../oauth/redirect-allowlist.js";
import type { ProviderRegistry } from "../oauth/registry.js";

export interface OAuthCallbackDeps {
  // Drizzle db handle; loosely typed so the route does not pull the full
  // @paperclipai/db Db type into route code.
  db: any;
  registry: ProviderRegistry;
  publicUrl: string;
  // Narrow method bag — the callback needs to upsert OAuth token secrets and
  // (on account-mismatch rollback) remove freshly-written ones to avoid
  // orphans referenced by no connection row.
  secretService: {
    upsertSecretByName: (
      companyId: string,
      input: { name: string; value: string },
    ) => Promise<{ id: string }>;
    remove?: (secretId: string) => Promise<unknown>;
  };
}

function back(
  deps: OAuthCallbackDeps,
  returnUrl: string | null | undefined,
  query: Record<string, string>,
): string {
  const safe = validateReturnUrl(returnUrl ?? undefined, deps.publicUrl);
  const url = new URL(safe, deps.publicUrl);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }
  return url.pathname + url.search;
}

function secretName(
  providerId: string,
  accountId: string,
  kind: "access" | "refresh",
): string {
  return `oauth:${providerId}:${accountId}:${kind}`;
}

export function oauthCallbackRoute(deps: OAuthCallbackDeps): RequestHandler {
  const r = Router({ mergeParams: true });

  r.get("/", async (req, res) => {
    const providerId = (req.params as { providerId: string }).providerId;
    const stateId = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const providerError =
      typeof req.query.error === "string" ? req.query.error : "";

    // Atomic state claim: mark consumed_at in a single UPDATE that requires
    // consumed_at IS NULL and expires_at > now(). Closes the TOCTOU window
    // between SELECT-time expiry/consumed checks and the eventual UPDATE that
    // would otherwise let two concurrent callbacks both pass the checks and
    // both attempt token exchange. RETURNING gives us the row contents we
    // need without a second SELECT on the happy path.
    const claimNow = new Date();
    const claimResult: Array<typeof oauthAuthorizationStates.$inferSelect> =
      await deps.db
        .update(oauthAuthorizationStates)
        .set({ consumedAt: claimNow })
        .where(
          and(
            eq(oauthAuthorizationStates.id, stateId),
            isNull(oauthAuthorizationStates.consumedAt),
            gt(oauthAuthorizationStates.expiresAt, claimNow),
          ),
        )
        .returning();

    if (claimResult.length === 0) {
      // Lost the race, already consumed, expired, or missing. SELECT to
      // disambiguate so we can return the right user-facing error code.
      const probe = await deps.db.query.oauthAuthorizationStates.findFirst({
        where: eq(oauthAuthorizationStates.id, stateId),
      });
      if (!probe) {
        return res.redirect(
          302,
          back(deps, null, { oauth_error: "invalid_state" }),
        );
      }
      if (probe.consumedAt) {
        return res.redirect(
          302,
          back(deps, probe.returnUrl, { oauth_error: "replay" }),
        );
      }
      // Row exists, not consumed, but failed the expires_at predicate.
      return res.redirect(
        302,
        back(deps, probe.returnUrl, { oauth_error: "invalid_state" }),
      );
    }

    const stateRow = claimResult[0];

    // Provider-mismatch check happens after the claim: a callback that
    // arrives at a different provider's URL has already used the state in an
    // unauthorized way, so consuming it here is the right outcome — the
    // legitimate provider's callback would just hit "replay" and the user
    // would restart the flow.
    if (stateRow.providerId !== providerId) {
      return res.redirect(
        302,
        back(deps, stateRow.returnUrl, { oauth_error: "provider_mismatch" }),
      );
    }

    if (providerError === "access_denied") {
      return res.redirect(
        302,
        back(deps, stateRow.returnUrl, { oauth_error: "user_cancelled" }),
      );
    }

    const provider = deps.registry.get(providerId);
    if (!provider) {
      return res.redirect(
        302,
        back(deps, stateRow.returnUrl, { oauth_error: "provider_not_found" }),
      );
    }

    let tokenRaw: Record<string, unknown>;
    try {
      tokenRaw = await exchangeToken({
        url: provider.config.endpoints.token,
        params: {
          grant_type: "authorization_code",
          code,
          redirect_uri: stateRow.redirectUri,
          code_verifier: stateRow.codeVerifier,
        },
        authMethod: provider.config.authMethod,
        responseFormat: provider.config.responseFormat,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
      });
    } catch (err) {
      oauthLogger.error(
        { provider: providerId, err: { message: (err as Error).message } },
        "token exchange failed",
      );
      return res.redirect(
        302,
        back(deps, stateRow.returnUrl, { oauth_error: "token_exchange_failed" }),
      );
    }

    let parsedToken;
    try {
      if (!provider.shape.parseTokenResponse) {
        throw new Error("provider shape missing parseTokenResponse");
      }
      parsedToken = provider.shape.parseTokenResponse(tokenRaw);
    } catch (err) {
      oauthLogger.error(
        { provider: providerId, err: { message: (err as Error).message } },
        "token shape violation",
      );
      return res.redirect(
        302,
        back(deps, stateRow.returnUrl, {
          oauth_error: "token_exchange_failed",
          detail: "response_shape_violation",
        }),
      );
    }

    let accountRaw: unknown;
    try {
      accountRaw = await fetchAccountInfo(
        provider.config.endpoints.accountInfo,
        parsedToken.accessToken,
      );
    } catch (err) {
      oauthLogger.error(
        { provider: providerId, err: { message: (err as Error).message } },
        "account info fetch failed",
      );
      return res.redirect(
        302,
        back(deps, stateRow.returnUrl, { oauth_error: "account_info_failed" }),
      );
    }

    let parsedAccount;
    try {
      if (!provider.shape.parseAccountInfo) {
        throw new Error("provider shape missing parseAccountInfo");
      }
      parsedAccount = provider.shape.parseAccountInfo(accountRaw);
    } catch {
      return res.redirect(
        302,
        back(deps, stateRow.returnUrl, { oauth_error: "account_info_failed" }),
      );
    }

    // Persist secrets via upsert (deterministic name → idempotent reconnects).
    const accessName = secretName(providerId, parsedAccount.accountId, "access");
    const accessSecret = await deps.secretService.upsertSecretByName(
      stateRow.companyId,
      { name: accessName, value: parsedToken.accessToken },
    );
    let refreshSecret: { id: string } | undefined;
    if (parsedToken.refreshToken) {
      const refreshName = secretName(
        providerId,
        parsedAccount.accountId,
        "refresh",
      );
      refreshSecret = await deps.secretService.upsertSecretByName(
        stateRow.companyId,
        { name: refreshName, value: parsedToken.refreshToken },
      );
    }

    const expiresAt = parsedToken.expiresInSeconds
      ? new Date(Date.now() + parsedToken.expiresInSeconds * 1000)
      : null;
    const finalScopes = parsedToken.scope ?? stateRow.scopesRequested ?? [];

    // Track the secret IDs we just wrote so that, on ACCOUNT_MISMATCH, we
    // can roll them back. Without this, a mismatched callback leaves
    // orphaned encrypted access/refresh tokens that no connection row
    // references — names matching `oauth:<provider>:<accountId>:access` /
    // `:refresh`. The connection upsert runs in its own transaction below;
    // those secret writes are NOT inside that transaction (they require
    // their own DB writes for versions/encryption metadata via the
    // secret-service factory bound to the outer db), so a transactional
    // rollback alone cannot undo them.
    //
    // We use Option C from the design notes: connection writes stay in a
    // single transaction; on rollback we explicitly `secretService.remove`
    // any freshly-persisted secrets. Option B (passing `tx` through the
    // secret service) is the cleaner long-term fix but requires a wider
    // refactor of the secret-service factory.
    const newSecretIds: string[] = [accessSecret.id];
    if (refreshSecret) newSecretIds.push(refreshSecret.id);

    try {
      await deps.db.transaction(async (tx: any) => {
        const existing = await tx.query.oauthConnections.findFirst({
          where: and(
            eq(oauthConnections.companyId, stateRow.companyId),
            eq(oauthConnections.providerId, providerId),
          ),
        });
        if (
          existing &&
          existing.accountId &&
          parsedAccount.accountId !== existing.accountId
        ) {
          throw new Error("ACCOUNT_MISMATCH");
        }
        if (existing) {
          await tx
            .update(oauthConnections)
            .set({
              status: "active",
              scopes: finalScopes,
              accountId: parsedAccount.accountId,
              accountLabel: parsedAccount.accountLabel ?? null,
              accessTokenSecretId: accessSecret.id,
              refreshTokenSecretId:
                refreshSecret?.id ?? existing.refreshTokenSecretId,
              accessTokenExpiresAt: expiresAt,
              lastRefreshedAt: new Date(),
              lastError: null,
              lastErrorAt: null,
              refreshAttemptCount: 0,
              updatedAt: new Date(),
            })
            .where(eq(oauthConnections.id, existing.id));
        } else {
          await tx.insert(oauthConnections).values({
            companyId: stateRow.companyId,
            providerId,
            status: "active",
            accountId: parsedAccount.accountId,
            accountLabel: parsedAccount.accountLabel ?? null,
            scopes: finalScopes,
            accessTokenSecretId: accessSecret.id,
            refreshTokenSecretId: refreshSecret?.id ?? null,
            accessTokenExpiresAt: expiresAt,
            lastRefreshedAt: new Date(),
          });
        }
        // State row was already atomically consumed at the top of this
        // handler, so there is no separate UPDATE to consume it here.
      });
    } catch (err) {
      if ((err as Error).message === "ACCOUNT_MISMATCH") {
        // Roll back the secret writes that landed before mismatch was
        // detected. `remove` is idempotent and best-effort — swallow
        // failures so a secrets cleanup hiccup doesn't override the
        // user-visible mismatch error redirect.
        if (typeof deps.secretService.remove === "function") {
          for (const secretId of newSecretIds) {
            await deps.secretService.remove(secretId).catch((removeErr) => {
              oauthLogger.warn(
                {
                  provider: providerId,
                  secretId,
                  err: { message: (removeErr as Error).message },
                },
                "failed to roll back orphan OAuth secret after account mismatch",
              );
            });
          }
        }
        return res.redirect(
          302,
          back(deps, stateRow.returnUrl, { oauth_error: "account_mismatch" }),
        );
      }
      throw err;
    }

    return res.redirect(
      302,
      back(deps, stateRow.returnUrl, { oauth_connected: providerId }),
    );
  });

  return r;
}
