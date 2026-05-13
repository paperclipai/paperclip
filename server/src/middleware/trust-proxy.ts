/**
 * Parser for the `TRUST_PROXY` env var, which mirrors Express 5's
 * `trust proxy` setting. The default is intentionally *unset* — Express
 * then trusts nothing and `req.ip` / `X-Forwarded-For` cannot be spoofed
 * by arbitrary clients. Operators opt in only when there is a real LB
 * in front of the server.
 *
 * Accepted forms (case-sensitive for the keywords, matching Express):
 *
 *   unset | "" | "false" | "0"   -> undefined (caller skips `app.set`)
 *   "true"                       -> true   (UNSAFE behind untrusted LBs)
 *   "<positive integer>"         -> number (trust N hops)
 *   comma-separated tokens       -> string[] of named subnets + CIDRs
 *
 * Named subnets accepted verbatim by Express: loopback, linklocal,
 * uniquelocal. CIDR validation is intentionally lax (Postel's law):
 * Express only uses the array form for prefix matching, so we just
 * reject obvious garbage. Anything that doesn't match the regex or
 * keyword whitelist throws at startup with a clear error.
 */

export type TrustProxyValue = boolean | number | string[];

const NAMED_SUBNETS: ReadonlySet<string> = new Set([
  "loopback",
  "linklocal",
  "uniquelocal",
]);

// IPv4 with optional /CIDR (0-32), or IPv6 with optional /CIDR (0-128).
// Not 100% RFC-correct on purpose — Express tolerates loose forms and
// we just want to reject obvious typos / shell-quoting accidents.
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}(?:\/(?:3[0-2]|[12]?\d))?$/;
// IPV6_RE is intentionally lax — it is *not* a full RFC 4291 validator.
// It matches any non-empty string of hex digits and colons (plus an
// optional /CIDR suffix in 0-128), which means tokens like ":::",
// "aaaa", or "gggg::1" (the last only if it had hex chars — "gggg" is
// hex-valid) can pass this regex. The colon-presence guard in
// `isValidSubnetToken` rejects purely-numeric strings, but malformed
// IPv6-shaped tokens still slip through to Express.
//
// Trade-off: the goal here is *fast rejection of obvious typos* (e.g.
// "10.0.0/8" missing an octet, shell-quoting accidents, stray
// alphabetics) — not strict parse. When a malformed-but-passed-through
// token reaches Express, Express silently ignores entries it cannot
// parse rather than throwing at startup. The practical impact is a
// silently-unconfigured trust-proxy entry, not a crash.
//
// Operators are therefore expected to verify their TRUST_PROXY config
// by hitting the server through their LB and confirming `req.ip` in the
// request log matches the real client IP. If you tighten this regex,
// also add tests for the rejected forms; see trust-proxy.test.ts.
const IPV6_RE = /^[0-9A-Fa-f:]+(?:\/(?:12[0-8]|1[01]\d|\d{1,2}))?$/;
// Strict positive integer: no leading zeros, no whitespace, no sign.
const STRICT_POS_INT_RE = /^[1-9]\d*$/;

function isValidSubnetToken(token: string): boolean {
  if (NAMED_SUBNETS.has(token)) return true;
  if (IPV4_RE.test(token)) return true;
  // IPv6 must contain at least one colon; the regex above is loose enough
  // that bare numbers like "10" would otherwise sneak through.
  if (token.includes(":") && IPV6_RE.test(token)) return true;
  return false;
}

/**
 * Parse a raw env-var value into the form Express's `app.set("trust proxy", …)`
 * accepts, or `undefined` to mean "leave Express at its safe default."
 *
 * Throws `Error` with an explanatory message if the value is malformed.
 */
export function parseTrustProxyEnv(raw: string | undefined): TrustProxyValue | undefined {
  if (raw === undefined) return undefined;
  // We intentionally trim only the *outer* value — tokens inside the
  // comma list are trimmed individually below. Leading/trailing whitespace
  // inside an integer like " 2 " is rejected by the strict regex.
  const value = raw.trim();
  if (value === "" || value === "false" || value === "0") return undefined;
  if (value === "true") return true;
  if (STRICT_POS_INT_RE.test(value)) return Number(value);
  // Reject the "01" / " 2" forms explicitly — if the value is *purely*
  // digits-or-whitespace but didn't match STRICT_POS_INT_RE, it's a
  // typo, not a subnet list.
  if (/^\s*\d+\s*$/.test(raw)) {
    throw new Error(
      `TRUST_PROXY: invalid integer value ${JSON.stringify(raw)} — use a positive integer with no leading zeros or whitespace`,
    );
  }
  const tokens = value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  for (const token of tokens) {
    if (!isValidSubnetToken(token)) {
      throw new Error(
        `TRUST_PROXY: unrecognized token ${JSON.stringify(token)} — expected one of {loopback, linklocal, uniquelocal} or a CIDR like 10.0.0.0/8 or fd00::/8`,
      );
    }
  }
  return tokens;
}

/**
 * Apply the parsed value to the given Express app. No-op when the value
 * is `undefined`, preserving Express's default (trust nothing).
 */
export function applyTrustProxy(
  app: { set: (key: string, value: TrustProxyValue) => unknown },
  value: TrustProxyValue | undefined,
): void {
  if (value === undefined) return;
  app.set("trust proxy", value);
}
