/**
 * The canonical check code both Codex Test engines emit when a sandbox target
 * has no ready authentication. The user interface reads this stable code to
 * decide login eligibility. The user interface does not read the message text
 * or the top-level status.
 *
 * The name is neutral. It carries no vendor name and no login-flow word, because
 * a Test result can sync to public packages.
 */
export const ADAPTER_AUTH_MISSING_CHECK_CODE = "adapter_auth_missing";
