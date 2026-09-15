const fs = require("fs");

// Co-change notice: parseAuthValue below mirrors parseGrokAuthPayload and
// hasUsableGrokAuthValue in
// packages/adapters/grok-local/src/server/grok-home.ts. If the auth format
// changes (new shape, renamed field), update both sites together.

// Matches the composite `<issuer>::<uuid>` top-level key. See grok-home.ts
// for the full rationale (the greedy `.+` backtracks to the last `::`).
const GROK_IDENTITY_KEY_RE =
  /^.+::[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Parses one already-decoded JSON value into `{ kind: "unusable" }` or
// `{ kind: "usable", identityKey, expiresAtRaw }`. `expiresAtRaw` is the raw,
// still-undecoded `expires_at` field (or `undefined` when absent) — decoding
// it is `readExpiry`'s job, kept separate so a caller can compare two already
// -parsed shapes without touching the filesystem (see `decide` below).
function parseAuthValue(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { kind: "unusable" };
  const keys = Object.keys(raw);
  if (keys.length !== 1) return { kind: "unusable" };
  const [identityKey] = keys;
  if (!GROK_IDENTITY_KEY_RE.test(identityKey)) return { kind: "unusable" };
  const value = raw[identityKey];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { kind: "unusable" };
  const key = value.key;
  const refreshToken = value.refresh_token;
  const hasUsableValue =
    typeof key === "string" &&
    key.trim().length > 0 &&
    typeof refreshToken === "string" &&
    refreshToken.trim().length > 0;
  if (!hasUsableValue) return { kind: "unusable" };
  return { kind: "usable", identityKey, expiresAtRaw: value.expires_at };
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

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// Below this magnitude a numeric `expires_at` is epoch seconds; at or above
// it, epoch milliseconds. A modern epoch-seconds instant is around 1.7e9; a
// modern epoch-millisecond instant is around 1.7e12, so this threshold never
// confuses the two for a real-world timestamp.
const EPOCH_SECONDS_MAX = 1e12;

// Reads one raw `expires_at` value into `{ present, unreadable, ms }`.
//   - `present: false` — the field is absent (missing or null).
//   - `unreadable: true` — the field is present but not one of the three
//     accepted encodings (ISO-8601 string, epoch-seconds number, epoch-
//     milliseconds number).
//   - otherwise `ms` holds the decoded epoch-millisecond value.
function readExpiry(raw) {
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

// Exit contract. Exit 10 = use source; exit 20 = keep destination; exit 21 =
// keep destination, an expiry was present but not a recognized encoding;
// exit 22 = keep destination, the source expiry sat further ahead of the
// host clock than the plausible bound.
const USE_SOURCE = 10;
const KEEP_DESTINATION = 20;
const UNREADABLE_EXPIRY = 21;
const IMPLAUSIBLE_EXPIRY = 22;
const MAX_PLAUSIBLE_EXPIRY_MS = 400 * 24 * 60 * 60 * 1000;

// This predicate answers one direction-agnostic question: should the caller
// replace `destination` with `source`? The caller picks which copy is source
// and which is destination from its own frame of reference (the outbound
// copy-out is the only caller today) purely by argument order — there is no
// `--direction` flag:
//
//   argv[0] (first positional)  = source auth.json path
//   argv[1] (second positional) = destination auth.json path
//
// `decide` takes already-parsed `{ kind, identityKey, expiresAtRaw }` shapes
// plus a caller-supplied `nowMs`, so a test can drive the exact plausibility
// bound without spawning a process and racing wall-clock drift. Guard order,
// first match wins:
//   1. Either side unusable, or the identity keys differ -> KEEP_DESTINATION.
//   2. Either side's expiry is absent -> KEEP_DESTINATION.
//   3. Either side's expiry is present but unreadable -> UNREADABLE_EXPIRY.
//   4. The source expiry sits further ahead of `nowMs` than
//      MAX_PLAUSIBLE_EXPIRY_MS -> IMPLAUSIBLE_EXPIRY. Only the source is
//      bounded, and only against the caller's clock: the source is the
//      sandbox-supplied side, so it must never be allowed to supply the
//      reference time.
//   5. The source expiry is strictly later than the destination expiry
//      -> USE_SOURCE.
//   6. Otherwise (a tie, or the source is older) -> KEEP_DESTINATION.
//
// The predicate only ever reads the two files and exits with a code; it
// never prints token bytes.
function decide(source, destination, nowMs) {
  if (
    source.kind === "unusable" ||
    destination.kind === "unusable" ||
    source.identityKey !== destination.identityKey
  ) {
    return KEEP_DESTINATION;
  }

  const sourceExpiry = readExpiry(source.expiresAtRaw);
  const destinationExpiry = readExpiry(destination.expiresAtRaw);

  if (!sourceExpiry.present || !destinationExpiry.present) {
    return KEEP_DESTINATION;
  }
  if (sourceExpiry.unreadable || destinationExpiry.unreadable) {
    return UNREADABLE_EXPIRY;
  }
  if (sourceExpiry.ms - nowMs > MAX_PLAUSIBLE_EXPIRY_MS) {
    return IMPLAUSIBLE_EXPIRY;
  }
  if (sourceExpiry.ms > destinationExpiry.ms) {
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
  readExpiry,
  USE_SOURCE,
  KEEP_DESTINATION,
  UNREADABLE_EXPIRY,
  IMPLAUSIBLE_EXPIRY,
  MAX_PLAUSIBLE_EXPIRY_MS,
};
