const fs = require("fs");

// Co-change notice: parseAuth below mirrors hasUsableAuthPayload in
// packages/adapters/codex-local/src/server/codex-home.ts. If the auth format
// changes (new shape, renamed field), update both sites together.
function parseAuth(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return { kind: "unusable" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unusable" };
  }

  if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim().length > 0) {
    return { kind: "apikey" };
  }

  const tokens = parsed.tokens;
  if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) {
    return { kind: "unusable" };
  }

  const accountId = typeof tokens.account_id === "string" ? tokens.account_id.trim() : "";
  const hasTokenMaterial = ["id_token", "access_token", "refresh_token"].some((key) => {
    const value = tokens[key];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (!accountId || !hasTokenMaterial) {
    return { kind: "unusable" };
  }

  const lastRefresh = typeof parsed.last_refresh === "string" ? Date.parse(parsed.last_refresh) : NaN;
  return {
    kind: "subscription",
    accountId,
    lastRefresh: Number.isFinite(lastRefresh) ? lastRefresh : null,
  };
}

// Exit codes are direction-agnostic: 20 = keep the host auth.json (inbound: do
// not overwrite the sandbox copy on the way in; outbound: do not copy the
// sandbox copy back to the host); 10 = use the sandbox auth.json.
const KEEP_HOST = 20;
const USE_SANDBOX = 10;

// Parse an optional `--direction=inbound|outbound` flag (default `inbound`) out
// of argv while leaving the two positional auth paths in order. Inbound is the
// original host→sandbox merge decision; outbound is the sandbox→host copy-back
// guard. Fail loudly on an unrecognised direction rather than silently defaulting.
const rawArgs = process.argv.slice(2);
let direction = "inbound";
const positional = [];
for (const arg of rawArgs) {
  if (arg.startsWith("--direction=")) {
    direction = arg.slice("--direction=".length);
  } else {
    positional.push(arg);
  }
}
if (direction !== "inbound" && direction !== "outbound") {
  console.error(`[paperclip] unknown --direction=${direction}; expected inbound|outbound`);
  process.exit(1);
}

const [sandboxAuthPath, hostAuthPath] = positional;
const sandboxAuth = parseAuth(sandboxAuthPath);
const hostAuth = parseAuth(hostAuthPath);

// Shared identity/kind pre-checks. Both directions refuse to move a credential
// unless the two sides are the same usable, subscription-kind identity — an
// unusable side, an api-key credential, a kind mismatch, or a different
// account_id all keep the host copy regardless of direction.
if (
  hostAuth.kind === "unusable" ||
  sandboxAuth.kind === "unusable" ||
  sandboxAuth.kind !== hostAuth.kind ||
  hostAuth.kind === "apikey" ||
  sandboxAuth.accountId !== hostAuth.accountId
) {
  process.exit(KEEP_HOST);
}

if (direction === "outbound") {
  // Copy the sandbox credential back to the host only when it is strictly
  // fresher: both sides must carry a parseable last_refresh and the sandbox one
  // must be strictly greater. Ties and null/unparseable freshness keep the host
  // copy so a spent single-use refresh token is never written back over a good one.
  if (
    sandboxAuth.lastRefresh !== null &&
    hostAuth.lastRefresh !== null &&
    sandboxAuth.lastRefresh > hostAuth.lastRefresh
  ) {
    process.exit(USE_SANDBOX);
  }
  process.exit(KEEP_HOST);
}

// Inbound (default): keep the host copy only when it is strictly fresher than
// the sandbox copy; ties and null/unparseable freshness fall through to the
// sandbox copy.
if (
  hostAuth.lastRefresh !== null &&
  sandboxAuth.lastRefresh !== null &&
  hostAuth.lastRefresh > sandboxAuth.lastRefresh
) {
  process.exit(KEEP_HOST);
}

process.exit(USE_SANDBOX);
