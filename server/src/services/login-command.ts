// The host-owned login command contract for the shared login pseudo-terminal
// (PTY). The shared login PTY runs one fixed command. The host selects that
// command from a closed internal key, never from a request, a configuration, a
// plugin manifest, or the worker routing key. This module holds the closed key
// union, the exhaustive resolver from the trusted adapter type, and the
// server-controlled session home helpers.
//
// Security boundary: the key is the only command authority. The provider driver
// key routes the worker; it confers no command authority. A caller cannot pass a
// command, so the sandbox pseudo-terminal never runs an arbitrary process.

/**
 * The closed set of login command identities. The host resolves the key from the
 * trusted adapter type. The worker maps the key to a compile-time command. The
 * union is exhaustive: a value outside it fails closed before the worker RPC.
 */
export type LoginCommandKey = "claude" | "codex";

/**
 * The exhaustive map from the trusted adapter type to the login command key. The
 * host reads only this map. It never reads the key from a request, a
 * configuration, a plugin manifest, or the provider driver key.
 */
const ADAPTER_TYPE_TO_LOGIN_COMMAND_KEY: Readonly<Record<string, LoginCommandKey>> = {
  claude_local: "claude",
  codex_local: "codex",
};

/** The fixed non-secret error an unsupported adapter type returns. */
export const LOGIN_COMMAND_UNSUPPORTED_ADAPTER = "LOGIN_PTY_UNSUPPORTED_ADAPTER";
/** The fixed non-secret error an invalid session home returns. */
export const LOGIN_SESSION_HOME_INVALID = "LOGIN_PTY_INVALID_SESSION_HOME";

/**
 * Resolves the login command key from the trusted adapter type. It reads only the
 * exhaustive first-party map. It throws the fixed non-secret error for an adapter
 * type that has no mapped key, so an unknown adapter fails closed before the
 * worker RPC.
 */
export function resolveLoginCommandKey(adapterType: string): LoginCommandKey {
  const key = ADAPTER_TYPE_TO_LOGIN_COMMAND_KEY[adapterType];
  if (!key) {
    throw new Error(LOGIN_COMMAND_UNSUPPORTED_ADAPTER);
  }
  return key;
}

/** Reports whether a value is a member of the closed login command key set. */
export function isLoginCommandKey(value: unknown): value is LoginCommandKey {
  return value === "claude" || value === "codex";
}

/**
 * Reports whether the trusted adapter type maps to a login command key. The
 * admission guard reads this predicate, so an adapter type with no mapped key
 * fails closed at admission. The device login opener resolves the same closed
 * map later, so admission and command resolution stay consistent.
 */
export function isLoginCommandSupportedAdapterType(adapterType: string): boolean {
  return ADAPTER_TYPE_TO_LOGIN_COMMAND_KEY[adapterType] !== undefined;
}

/**
 * The fixed root for a login session home. The server derives one per-session
 * home under this root. The path shape is exact, so the provider revalidates it
 * before it touches the filesystem.
 */
export const LOGIN_SESSION_HOME_ROOT = "/tmp/paperclip-adapter-login";

/** Matches one lowercase-hyphenated UUID (version 4 layout not enforced). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The exact absolute path shape for a login session home. The path is the fixed
 * root, one slash, and one UUID. The anchors reject a relative path, a path
 * traversal, whitespace, a control character, and a shell metacharacter, because
 * none of those match the UUID or the fixed root.
 */
const SESSION_HOME_PATTERN = new RegExp(
  `^${LOGIN_SESSION_HOME_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
);

/**
 * Derives the session home from a session UUID. It builds the exact
 * `/tmp/paperclip-adapter-login/<uuid>` path. It throws the fixed non-secret
 * error when the id is not a UUID, so a malformed id never becomes a home.
 */
export function deriveLoginSessionHome(sessionUuid: string): string {
  if (!UUID_PATTERN.test(sessionUuid)) {
    throw new Error(LOGIN_SESSION_HOME_INVALID);
  }
  return `${LOGIN_SESSION_HOME_ROOT}/${sessionUuid}`;
}

/**
 * Validates the exact session home path shape. It throws the fixed non-secret
 * error for an empty, a relative, a traversal, a whitespace, a control-character,
 * or a shell-metacharacter candidate. The server validates before the worker RPC;
 * the provider revalidates before the filesystem operation.
 */
export function validateLoginSessionHome(sessionHome: string): void {
  if (!SESSION_HOME_PATTERN.test(sessionHome)) {
    throw new Error(LOGIN_SESSION_HOME_INVALID);
  }
}
