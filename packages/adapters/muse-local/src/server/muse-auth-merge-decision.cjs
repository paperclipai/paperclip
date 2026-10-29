const fs = require("node:fs");

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const EPOCH_SECONDS_MAX = 1e12;

// Exit contract matching Codex and Grok:
// Exit 10 = use source (install sandbox credential onto host)
// Exit 20 = keep destination (leave host copy untouched)
// Exit 21 = unreadable expiry / freshness
// Exit 22 = implausible expiry / freshness (skew exceeded)
const USE_SOURCE = 10;
const KEEP_DESTINATION = 20;
const UNREADABLE_EXPIRY = 21;
const IMPLAUSIBLE_EXPIRY = 22;

const MAX_FUTURE_LAST_REFRESH_SKEW_MS = 5 * 60 * 1000;
const MAX_PLAUSIBLE_EXPIRY_MS = 400 * 24 * 60 * 60 * 1000;

function parseAuthValue(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "unusable" };
  }

  // Check token material
  let hasToken = false;
  if (typeof raw.token === "string" && raw.token.trim().length > 0) hasToken = true;
  else if (typeof raw.access_token === "string" && raw.access_token.trim().length > 0) hasToken = true;
  else if (typeof raw.key === "string" && raw.key.trim().length > 0) hasToken = true;
  else if (typeof raw.apiKey === "string" && raw.apiKey.trim().length > 0) hasToken = true;
  else if (typeof raw.api_key === "string" && raw.api_key.trim().length > 0) hasToken = true;
  else if (raw.tokens && typeof raw.tokens === "object" && !Array.isArray(raw.tokens)) {
    if (
      ["token", "access_token", "refresh_token", "id_token"].some(
        (k) => typeof raw.tokens[k] === "string" && raw.tokens[k].trim().length > 0,
      )
    ) {
      hasToken = true;
    }
  }
  if (!hasToken) {
    return { kind: "unusable" };
  }

  // Extract identity
  let identity = null;
  const directId =
    raw.account_id ??
    raw.accountId ??
    raw.user_id ??
    raw.userId ??
    raw.email ??
    raw.username ??
    raw.id;
  if (typeof directId === "string" && directId.trim().length > 0) {
    identity = directId.trim();
  } else if (raw.tokens && typeof raw.tokens === "object") {
    const tokensId =
      raw.tokens.account_id ??
      raw.tokens.accountId ??
      raw.tokens.user_id ??
      raw.tokens.userId ??
      raw.tokens.email;
    if (typeof tokensId === "string" && tokensId.trim().length > 0) {
      identity = tokensId.trim();
    }
  } else if (raw.account && typeof raw.account === "object") {
    const accId = raw.account.id ?? raw.account.email;
    if (typeof accId === "string" && accId.trim().length > 0) {
      identity = accId.trim();
    }
  } else if (raw.user && typeof raw.user === "object") {
    const uId = raw.user.id ?? raw.user.email;
    if (typeof uId === "string" && uId.trim().length > 0) {
      identity = uId.trim();
    }
  }

  // Extract freshness (last_refresh, updated_at, expires_at)
  const freshnessRaw =
    raw.last_refresh ??
    raw.lastRefresh ??
    raw.updated_at ??
    raw.updatedAt ??
    raw.timestamp ??
    raw.expires_at ??
    raw.expiresAt ??
    raw.tokens?.last_refresh ??
    raw.tokens?.expires_at;

  const isExpiry =
    (raw.expires_at !== undefined ||
      raw.expiresAt !== undefined ||
      raw.tokens?.expires_at !== undefined) &&
    raw.last_refresh === undefined &&
    raw.lastRefresh === undefined &&
    raw.updated_at === undefined &&
    raw.updatedAt === undefined &&
    raw.timestamp === undefined;

  return {
    kind: "usable",
    identity,
    freshnessRaw,
    isExpiry,
  };
}

function parseAuthFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return { kind: "unusable" };
  }
  return parseAuthValue(parsed);
}

function readFreshness(raw) {
  if (raw === undefined || raw === null) return { present: false, unreadable: false, ms: null };
  if (typeof raw === "string") {
    if (ISO_8601_RE.test(raw)) {
      const ms = Date.parse(raw);
      if (Number.isFinite(ms)) return { present: true, unreadable: false, ms };
    }
    return { present: true, unreadable: true, ms: null };
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < EPOCH_SECONDS_MAX ? raw * 1000 : raw;
    return { present: true, unreadable: false, ms };
  }
  return { present: true, unreadable: true, ms: null };
}

function decide(source, destination, nowMs) {
  if (
    source.kind === "unusable" ||
    destination.kind === "unusable" ||
    !source.identity ||
    !destination.identity ||
    source.identity !== destination.identity
  ) {
    return KEEP_DESTINATION;
  }

  const sourceFreshness = readFreshness(source.freshnessRaw);
  const destinationFreshness = readFreshness(destination.freshnessRaw);

  if (!sourceFreshness.present || !destinationFreshness.present) {
    return KEEP_DESTINATION;
  }
  if (sourceFreshness.unreadable || destinationFreshness.unreadable) {
    return UNREADABLE_EXPIRY;
  }

  const maxAllowedSkew = source.isExpiry
    ? MAX_PLAUSIBLE_EXPIRY_MS
    : MAX_FUTURE_LAST_REFRESH_SKEW_MS;
  if (sourceFreshness.ms - nowMs > maxAllowedSkew) {
    return IMPLAUSIBLE_EXPIRY;
  }

  if (sourceFreshness.ms > destinationFreshness.ms) {
    return USE_SOURCE;
  }

  return KEEP_DESTINATION;
}

if (require.main === module) {
  const [sourceAuthPath, destinationAuthPath] = process.argv.slice(2);
  const source = parseAuthFile(sourceAuthPath);
  const destination = parseAuthFile(destinationAuthPath);
  process.exit(decide(source, destination, Date.now()));
}

module.exports = {
  decide,
  parseAuthValue,
  parseAuthFile,
  readFreshness,
  USE_SOURCE,
  KEEP_DESTINATION,
  UNREADABLE_EXPIRY,
  IMPLAUSIBLE_EXPIRY,
  MAX_FUTURE_LAST_REFRESH_SKEW_MS,
  MAX_PLAUSIBLE_EXPIRY_MS,
};
