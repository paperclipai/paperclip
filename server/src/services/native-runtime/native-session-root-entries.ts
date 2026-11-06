// Contract for the top-level entries of a native session's durable state root
// (`<runner state base>/<scope digest>`). Every writer that targets that root
// must have its entry classified here; native-session-root-entries.test.ts
// scans the known writers so a new entry cannot drift past retirement.

/**
 * Entries owned by one provider session's authority. A continuity break moves
 * them aside together. Backups and archived authority epochs belong to the
 * retired session too: left active, they make a fresh replacement look like
 * lost harness state, or let a later cold rotation revive retired authority.
 */
export const NATIVE_CONTINUITY_STATE_ENTRIES: readonly string[] = [
  "control-plane",
  "runner",
  "codex-home",
  "opencode",
  "acpx",
  "failover-backups",
  "provider-pack-authority.json",
  // Runner transport: each cold authority rotation archives the settled prior
  // epoch here (rotateLocalAuthorityEpoch/rotateExternalAuthorityEpoch).
  "authority-epochs",
  // Runner transport: execution-owned launch preparation keyed by identity.
  "launch-preparation.json",
];

/**
 * Per-launch inputs and process logs that carry no session authority. Every
 * launch rewrites them, so retirement leaves them in place.
 */
export const NATIVE_SESSION_ROOT_LAUNCH_ENTRIES: readonly string[] = [
  // Runner transport writes the resolved runtime context before each launch.
  "runtime-context.json",
  // Local runnerd stdout/stderr diagnostics.
  "diagnostics",
];

/**
 * Known entries that are evidence a finished-owner proof must never override:
 * a plugin Runner receipt, in-flight backup maintenance, and Cursor Cloud's
 * own checkpoint (archived only by its provider runtime). Retirement refuses
 * while any of them is present.
 */
export const NATIVE_SESSION_ROOT_HELD_ENTRIES: readonly string[] = [
  "plugin-runner-state.json",
  "cleanup-activation.json",
  "cursor-cloud",
];

/** Holds archived continuity state; never an owner claim by itself. */
export const NATIVE_CONTINUITY_ARCHIVE_ENTRY = "continuity-breaks";

export function isKnownNativeSessionRootEntry(name: string): boolean {
  return name === NATIVE_CONTINUITY_ARCHIVE_ENTRY ||
    NATIVE_CONTINUITY_STATE_ENTRIES.includes(name) ||
    NATIVE_SESSION_ROOT_LAUNCH_ENTRIES.includes(name);
}

const REPORTABLE_ENTRY_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}/gi;

/**
 * Bounded, redacted names for a refusal message: at most three entries, safe
 * characters only, identifiers collapsed. Anything else reports as "other".
 */
export function describeUnexpectedNativeSessionRootEntries(names: readonly string[]): string {
  const described = [...new Set(names.map(name => REPORTABLE_ENTRY_NAME.test(name)
    ? name.replace(UUID_LIKE, "<id>") : "other"))].sort();
  const shown = described.slice(0, 3);
  return described.length > shown.length ? `${shown.join(",")},+${described.length - shown.length}` : shown.join(",");
}
