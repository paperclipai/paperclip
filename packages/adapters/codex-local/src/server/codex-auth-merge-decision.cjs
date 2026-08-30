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
// The predicate has two modes, selected by a leading positional flag:
//
//   default (no flag) — fail closed to the destination; used by the host default
//     store, whose fail-closed behavior must never change. An absent or
//     unusable destination keeps the destination (no seed from empty).
//   --seed-if-dest-absent — the opt-in cache-slot mode; used only by the
//     per-identity cache slot helper. It ADDS one behavior on top of the default:
//     when the destination is unusable (absent or unparseable) AND the source is
//     a usable subscription credential, use the source (fill the empty slot). It
//     never relaxes the different-identity, api-key, or unusable-source guards.
//
// A leading positional flag (not an environment variable) keeps the mode
// explicit per call, so a host-default two-path call can never enter seed mode.
//
// Exit 10 = use source; exit 20 = keep destination. The predicate only ever
// reads the two files and exits with a code — it never prints token bytes.
const USE_SOURCE = 10;
const KEEP_DESTINATION = 20;
const SEED_IF_DEST_ABSENT_FLAG = "--seed-if-dest-absent";

const rawArgs = process.argv.slice(2);
const seedIfDestAbsent = rawArgs[0] === SEED_IF_DEST_ABSENT_FLAG;
const [sourceAuthPath, destinationAuthPath] = seedIfDestAbsent ? rawArgs.slice(1) : rawArgs;
const sourceAuth = parseAuth(sourceAuthPath);
const destinationAuth = parseAuth(destinationAuthPath);

// Seed mode only: fill an ABSENT (unusable) destination slot from a usable
// subscription source. A subscription-kind source is guaranteed usable and to
// carry a real account_id (parseAuth returns "subscription" only then), so this
// is never a random pick. This branch changes ONLY the destination-unusable
// case; the api-key and unusable-source guards below still keep the destination.
if (
  seedIfDestAbsent &&
  destinationAuth.kind === "unusable" &&
  sourceAuth.kind === "subscription"
) {
  process.exit(USE_SOURCE);
}

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
