/**
 * Which Google Antigravity connections can run where. Configuration save and
 * Test refuse an unsupported choice up front with these messages; the run-time
 * check stays only as a defense, as a named permanent startup rejection.
 */
export const ANTIGRAVITY_REMOTE_UNAVAILABLE = "antigravity_remote_unavailable";
export const ANTIGRAVITY_REMOTE_SIGN_IN_UNSUPPORTED = "antigravity_remote_sign_in_unsupported";
export const ANTIGRAVITY_WARM_SIGN_IN_UNSUPPORTED = "antigravity_warm_sign_in_unsupported";

export type AntigravityConnectionRefusal = {
  code: typeof ANTIGRAVITY_REMOTE_UNAVAILABLE | typeof ANTIGRAVITY_REMOTE_SIGN_IN_UNSUPPORTED | typeof ANTIGRAVITY_WARM_SIGN_IN_UNSUPPORTED;
  message: string;
};

export function antigravityConnectionRefusal(input: {
  /** A Google API key is the connection, rather than a Google sign-in. */
  apiKey: boolean;
  remote: boolean;
  lifecycleMode?: "per_turn" | "warm";
  releasePending: boolean;
}): AntigravityConnectionRefusal | null {
  if (input.remote && input.releasePending) {
    return { code: ANTIGRAVITY_REMOTE_UNAVAILABLE,
      message: "Google Antigravity runs only on the Paperclip host for now. Choose the Paperclip host as this agent's environment." };
  }
  if (input.apiKey) return null;
  if (input.remote) {
    return { code: ANTIGRAVITY_REMOTE_SIGN_IN_UNSUPPORTED,
      message: "Google sign-in for Google Antigravity works only on the Paperclip host. To run this agent in a cloud environment, connect a Google API key instead." };
  }
  if (input.lifecycleMode === "warm") {
    return { code: ANTIGRAVITY_WARM_SIGN_IN_UNSUPPORTED,
      message: "Google sign-in for Google Antigravity runs one turn at a time. Turn off warm sessions for this agent, or connect a Google API key instead." };
  }
  return null;
}

/** A run reached execution with a connection its target cannot use. Retrying
 * cannot change the saved choice, so it is a permanent, named refusal. */
export class AntigravityConnectionConfigurationError extends Error {
  readonly code: AntigravityConnectionRefusal["code"];
  constructor(refusal: AntigravityConnectionRefusal) {
    super(refusal.message);
    this.name = "AntigravityConnectionConfigurationError";
    this.code = refusal.code;
  }
}
