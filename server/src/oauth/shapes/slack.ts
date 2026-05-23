import type { ProviderShape } from "../types.js";

/**
 * Slack OAuth v2 token + account-info shape.
 *
 * Slack's `oauth.v2.access` response is unusual: when a user-token is granted
 * the access/refresh tokens live under `authed_user`, while bot-token responses
 * keep them at the top level. We probe for `authed_user.access_token` first and
 * fall back to the flat layout.
 *
 * `auth.test` returns `{ team: { id, name } }`; we surface those as the account
 * id/label.
 */
export const slackShape: ProviderShape = {
  parseTokenResponse(raw) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("response_shape_violation");
    }
    const r = raw as Record<string, unknown>;
    const user = (r as { authed_user?: Record<string, unknown> }).authed_user;
    if (user && typeof user.access_token === "string") {
      return {
        accessToken: user.access_token,
        refreshToken:
          typeof user.refresh_token === "string" ? user.refresh_token : undefined,
        expiresInSeconds:
          typeof user.expires_in === "number" ? user.expires_in : undefined,
        scope:
          typeof user.scope === "string"
            ? user.scope.split(",").filter(Boolean)
            : undefined,
      };
    }
    if (typeof r.access_token !== "string") {
      throw new Error("response_shape_violation: no access_token");
    }
    return {
      accessToken: r.access_token,
      refreshToken:
        typeof r.refresh_token === "string" ? r.refresh_token : undefined,
      expiresInSeconds:
        typeof r.expires_in === "number" ? r.expires_in : undefined,
      scope:
        typeof r.scope === "string"
          ? r.scope.split(",").filter(Boolean)
          : undefined,
    };
  },
  parseAccountInfo(raw) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("response_shape_violation");
    }
    const r = raw as { team?: { id?: unknown; name?: unknown } };
    if (typeof r.team?.id !== "string") {
      throw new Error("response_shape_violation: no team.id");
    }
    return {
      accountId: r.team.id,
      accountLabel: typeof r.team.name === "string" ? r.team.name : undefined,
    };
  },
};
