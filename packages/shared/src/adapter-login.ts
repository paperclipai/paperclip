// The host-owned sign-in contract for adapters that Paperclip signs in on a
// login pseudo-terminal (PTY). Server admission, plugin manifest validation, and
// environment presentation read the same closed map, so an adapter either has a
// Core sign-in everywhere or nowhere.

/**
 * The closed set of login command identities. The host resolves the key from the
 * trusted adapter type. A plugin worker maps the key to a compile-time command,
 * so a request never carries a command string.
 */
export type AdapterLoginCommandKey = "claude" | "codex" | "grok";

const LOGIN_COMMAND_KEY_BY_ADAPTER_TYPE: Readonly<Record<string, AdapterLoginCommandKey>> = {
  claude_local: "claude",
  codex_local: "codex",
  grok_local: "grok",
};

/**
 * Where a completed sign-in leaves its credential. A `terminal` sign-in prints a
 * token that the host reads from the login output. A `file` sign-in saves the
 * provider's credential file in the session home, and the host reads that file
 * back from the environment that ran the login.
 */
export const ADAPTER_LOGIN_CREDENTIAL_SOURCE: Readonly<Record<AdapterLoginCommandKey, "terminal" | "file">> = {
  claude: "terminal",
  codex: "file",
  grok: "file",
};

/** The login command key for an adapter type, or undefined when Paperclip has no sign-in for it. */
export function adapterLoginCommandKey(adapterType: string): AdapterLoginCommandKey | undefined {
  return Object.hasOwn(LOGIN_COMMAND_KEY_BY_ADAPTER_TYPE, adapterType)
    ? LOGIN_COMMAND_KEY_BY_ADAPTER_TYPE[adapterType]
    : undefined;
}

/** Reports whether a value is a member of the closed login command key set. */
export function isAdapterLoginCommandKey(value: unknown): value is AdapterLoginCommandKey {
  return typeof value === "string" && Object.hasOwn(ADAPTER_LOGIN_CREDENTIAL_SOURCE, value);
}

/** Every adapter type that Paperclip can sign in, sorted. */
export function adapterLoginTypes(): string[] {
  return Object.keys(LOGIN_COMMAND_KEY_BY_ADAPTER_TYPE).sort();
}
