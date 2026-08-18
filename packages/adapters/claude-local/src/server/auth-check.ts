/**
 * The canonical check code the Claude Test engine emits when a sandbox target
 * has no ready authentication. The user interface reads this stable code to
 * decide login eligibility. The user interface does not read the message text
 * or the top-level status.
 *
 * The name is neutral. It carries no vendor name and no login-flow word, because
 * a Test result can sync to public packages. The value matches the code the
 * Codex Test engine emits, so the user interface can gate login from one code
 * across adapters.
 */
export const ADAPTER_AUTH_MISSING_CHECK_CODE = "adapter_auth_missing";
