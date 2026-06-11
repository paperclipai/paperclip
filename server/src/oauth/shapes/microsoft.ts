import type { ProviderShape } from "../types.js";

/**
 * Microsoft Graph OAuth shape.
 *
 * Token responses follow RFC-6749 but Microsoft sometimes returns the `scope`
 * field with leading/trailing whitespace and tabs, so we split on whitespace
 * runs rather than a single space.
 *
 * `https://graph.microsoft.com/v1.0/me` returns `id`, `displayName`, and
 * (for tenanted apps) a `tid` claim. When both display name and tenant id are
 * present, we prefer the human-readable form `<displayName> (<tenant>)` so the
 * UI can disambiguate accounts across tenants.
 */
export const microsoftShape: ProviderShape = {
  parseTokenResponse(raw) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("response_shape_violation");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.access_token !== "string") {
      throw new Error("response_shape_violation");
    }
    return {
      accessToken: r.access_token,
      refreshToken:
        typeof r.refresh_token === "string" ? r.refresh_token : undefined,
      expiresInSeconds:
        typeof r.expires_in === "number" ? r.expires_in : undefined,
      scope:
        typeof r.scope === "string"
          ? r.scope.trim().split(/\s+/).filter(Boolean)
          : undefined,
    };
  },
  parseAccountInfo(raw) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("response_shape_violation");
    }
    const r = raw as Record<string, unknown>;
    const id = r.id;
    if (typeof id !== "string") {
      throw new Error("response_shape_violation");
    }
    const displayName =
      typeof r.displayName === "string" ? r.displayName : undefined;
    const tid = typeof r.tid === "string" ? r.tid : undefined;
    let label: string | undefined;
    if (displayName && tid) label = `${displayName} (${tid})`;
    else label = displayName;
    return { accountId: id, accountLabel: label };
  },
};
