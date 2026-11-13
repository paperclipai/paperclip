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
// Exit contract. Exit 10 = use source; exit 20 = keep destination; exit 22 =
// keep destination, the source `last_refresh` sat further ahead of the host
// clock than the plausible skew allowance. The predicate only ever reads the
// two files and exits with a code — it never prints token bytes.
const USE_SOURCE = 10;
const KEEP_DESTINATION = 20;
const IMPLAUSIBLE_LAST_REFRESH = 22;
const SEED_IF_DEST_ABSENT_FLAG = "--seed-if-dest-absent";

// A `last_refresh` records an event that already happened, so an honest value
// always sits at or before the host clock. Only clock skew between a sandbox
// and the host explains a small future value. Five minutes is larger than
// real skew on a time-synchronised host, and it is short enough that a source
// which claims a `last_refresh` further ahead than this cannot be trusted.
const MAX_FUTURE_LAST_REFRESH_SKEW_MS = 5 * 60 * 1000;

// `decide` takes already-parsed `{ kind, accountId, lastRefresh }` shapes plus
// a caller-supplied `nowMs` and the `seedIfDestAbsent` flag, so a test can
// drive the exact skew bound without spawning a process and racing wall-clock
// drift. Guard order, first match wins:
//   1. Seed mode, the destination is unusable, and the source is a usable
//      subscription credential -> USE_SOURCE, unless the source fails the
//      skew bound in step 3 below, in which case the absent slot stays
//      absent (IMPLAUSIBLE_LAST_REFRESH). A poisoned seed would out-live
//      every honest refresh, since nothing could ever compare as "strictly
//      newer" than an unbounded future value, so the bound applies here too.
//   2. Either side unusable, a kind mismatch, the destination is an api-key
//      credential, or the two sides carry a different account_id ->
//      KEEP_DESTINATION.
//   3. The source `last_refresh` sits further ahead of `nowMs` than
//      MAX_FUTURE_LAST_REFRESH_SKEW_MS -> IMPLAUSIBLE_LAST_REFRESH. Only the
//      source is bounded, and only against the caller's clock: the source is
//      the sandbox-supplied side, so it must never supply the reference time.
//   4. The source `last_refresh` is strictly greater than the destination's
//      -> USE_SOURCE.
//   5. Otherwise (a tie, a null value on either side, or an older source) ->
//      KEEP_DESTINATION.
function decide(source, destination, nowMs, seedIfDestAbsent) {
  const sourceIsImplausible =
    source.lastRefresh !== null &&
    source.lastRefresh - nowMs > MAX_FUTURE_LAST_REFRESH_SKEW_MS;

  // Seed mode only: fill an ABSENT (unusable) destination slot from a usable
  // subscription source. A subscription-kind source is guaranteed usable and to
  // carry a real account_id (parseAuth returns "subscription" only then), so this
  // is never a random pick. This branch changes ONLY the destination-unusable
  // case; the api-key and unusable-source guards below still keep the destination.
  if (
    seedIfDestAbsent &&
    destination.kind === "unusable" &&
    source.kind === "subscription"
  ) {
    return sourceIsImplausible ? IMPLAUSIBLE_LAST_REFRESH : USE_SOURCE;
  }

  // Fail closed to the destination unless both sides are the same usable,
  // subscription-kind identity — an unusable side, an api-key credential, a kind
  // mismatch, or a different account_id all keep the destination copy.
  if (
    destination.kind === "unusable" ||
    source.kind === "unusable" ||
    source.kind !== destination.kind ||
    destination.kind === "apikey" ||
    source.accountId !== destination.accountId
  ) {
    return KEEP_DESTINATION;
  }

  if (sourceIsImplausible) {
    return IMPLAUSIBLE_LAST_REFRESH;
  }

  // Use the source credential only when it is strictly fresher: both sides must
  // carry a parseable last_refresh and the source one must be strictly greater.
  // Ties and null/unparseable freshness keep the destination copy so a spent
  // single-use refresh token is never written over a good one.
  if (
    source.lastRefresh !== null &&
    destination.lastRefresh !== null &&
    source.lastRefresh > destination.lastRefresh
  ) {
    return USE_SOURCE;
  }

  return KEEP_DESTINATION;
}

if (require.main === module) {
  const rawArgs = process.argv.slice(2);
  const seedIfDestAbsent = rawArgs[0] === SEED_IF_DEST_ABSENT_FLAG;
  const [sourceAuthPath, destinationAuthPath] = seedIfDestAbsent ? rawArgs.slice(1) : rawArgs;
  const sourceAuth = parseAuth(sourceAuthPath);
  const destinationAuth = parseAuth(destinationAuthPath);
  process.exit(decide(sourceAuth, destinationAuth, Date.now(), seedIfDestAbsent));
}

module.exports = {
  decide,
  parseAuth,
  USE_SOURCE,
  KEEP_DESTINATION,
  IMPLAUSIBLE_LAST_REFRESH,
  MAX_FUTURE_LAST_REFRESH_SKEW_MS,
};
