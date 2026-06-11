import { getByPath } from "./dot-path.js";
import type { ProviderShape } from "./types.js";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function buildDefaultShape(cfg: {
  accountIdField: string;
  accountLabelField: string;
}): ProviderShape {
  return {
    parseTokenResponse(raw) {
      if (typeof raw !== "object" || raw === null) {
        throw new Error("response_shape_violation: not an object");
      }
      const r = raw as Record<string, unknown>;
      if (typeof r.access_token !== "string" || r.access_token.length === 0) {
        throw new Error("response_shape_violation: missing access_token");
      }
      let expiresInSeconds: number | undefined;
      if (r.expires_in !== undefined) {
        const n = Number(r.expires_in);
        if (!Number.isFinite(n) || n < 0 || n > ONE_YEAR_SECONDS) {
          throw new Error("response_shape_violation: invalid expires_in");
        }
        expiresInSeconds = n;
      }
      let scope: string[] | undefined;
      if (typeof r.scope === "string") {
        if (/[^\x20-\x7E]/.test(r.scope)) {
          throw new Error(
            "response_shape_violation: scope contains non-printable characters",
          );
        }
        scope = r.scope.split(/[\s,]+/).filter(Boolean);
      }
      return {
        accessToken: r.access_token,
        refreshToken: typeof r.refresh_token === "string" ? r.refresh_token : undefined,
        expiresInSeconds,
        scope,
      };
    },
    parseAccountInfo(raw) {
      const idVal = getByPath(raw, cfg.accountIdField);
      const labelVal = getByPath(raw, cfg.accountLabelField);
      if (idVal === null || idVal === undefined) {
        throw new Error("response_shape_violation: missing account id");
      }
      const accountId =
        typeof idVal === "string" || typeof idVal === "number"
          ? String(idVal)
          : (() => {
              throw new Error("response_shape_violation: non-scalar account id");
            })();
      const accountLabel =
        typeof labelVal === "string" || typeof labelVal === "number"
          ? String(labelVal)
          : undefined;
      return { accountId, accountLabel };
    },
  };
}
