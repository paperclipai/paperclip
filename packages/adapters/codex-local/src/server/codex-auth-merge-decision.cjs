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

// This predicate answers a single, direction-agnostic question: should the
// caller replace the `destination` auth.json with the `source` auth.json? The
// caller picks which copy is source and which is destination from its own frame
// of reference (an inbound restore, an outbound copy-back, …) purely by argument
// order — there is no `--direction` flag and no hard-coded sandbox/host notion:
//
//   argv[0] (first positional)  = source auth.json path
//   argv[1] (second positional) = destination auth.json path
//
// Exit 10 = use source; exit 20 = keep destination. The predicate only ever
// reads the two files and exits with a code — it never prints token bytes.
const USE_SOURCE = 10;
const KEEP_DESTINATION = 20;

const [sourceAuthPath, destinationAuthPath] = process.argv.slice(2);
const sourceAuth = parseAuth(sourceAuthPath);
const destinationAuth = parseAuth(destinationAuthPath);

// Fail closed to the destination unless both sides are the same usable,
// subscription-kind identity — an unusable side, an api-key credential, a kind
// mismatch, or a different account_id all keep the destination copy.
if (
  destinationAuth.kind === "unusable" ||
  sourceAuth.kind === "unusable" ||
  sourceAuth.kind !== destinationAuth.kind ||
  destinationAuth.kind === "apikey" ||
  sourceAuth.accountId !== destinationAuth.accountId
) {
  process.exit(KEEP_DESTINATION);
}

// Use the source credential only when it is strictly fresher: both sides must
// carry a parseable last_refresh and the source one must be strictly greater.
// Ties and null/unparseable freshness keep the destination copy so a spent
// single-use refresh token is never written over a good one.
if (
  sourceAuth.lastRefresh !== null &&
  destinationAuth.lastRefresh !== null &&
  sourceAuth.lastRefresh > destinationAuth.lastRefresh
) {
  process.exit(USE_SOURCE);
}

process.exit(KEEP_DESTINATION);
