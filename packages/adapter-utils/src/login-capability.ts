// The adapter login capability. An adapter declares this optional capability to
// describe how the server drives an interactive sandbox login. The module holds
// the capability types, the fixed value sets, and one runtime validator. The
// validator fails closed: it rejects a malformed capability shape with a clear
// error, so the loader never accepts a partial capability.
//
// Security (secret handling): the capability data holds no secret. The scalar
// fields carry only a fixed, non-secret value. The function members are code,
// not data; a member can return a runtime secret (for example a minted token),
// but the capability object never stores a secret. API-key-only vendors declare
// no login capability.

/**
 * The login panel mode. `displayed_code` shows a one-time code that the user
 * enters in the browser. `submitted_browser_code` asks the user to paste a code
 * from the browser back into the login flow.
 */
export const ADAPTER_LOGIN_PANEL_MODES = ["displayed_code", "submitted_browser_code"] as const;
export type AdapterLoginPanelMode = (typeof ADAPTER_LOGIN_PANEL_MODES)[number];

/**
 * The sandbox transport that the login command needs. `streamed_exec` runs the
 * command over the streamed exec channel. `pseudo_terminal` runs the command on
 * a real pseudo-terminal, because a pipe emits no login prompt.
 */
export const ADAPTER_LOGIN_SANDBOX_TRANSPORTS = ["streamed_exec", "pseudo_terminal"] as const;
export type AdapterLoginSandboxTransport = (typeof ADAPTER_LOGIN_SANDBOX_TRANSPORTS)[number];

/**
 * The host-side timeout policy. `caller_bounded` lets the caller set the
 * timeout. `fixed` binds the timeout to a fixed adapter value.
 */
export const ADAPTER_LOGIN_TIMEOUT_POLICIES = ["caller_bounded", "fixed"] as const;
export type AdapterLoginTimeoutPolicy = (typeof ADAPTER_LOGIN_TIMEOUT_POLICIES)[number];

/**
 * The optional completion claim that the login flow records on success.
 * `storedSessionId` marks that the flow stored a session identifier.
 */
export const ADAPTER_LOGIN_COMPLETION_CLAIMS = ["storedSessionId"] as const;
export type AdapterLoginCompletionClaim = (typeof ADAPTER_LOGIN_COMPLETION_CLAIMS)[number];

/**
 * The normalized login prompt. `url` is the validated authorization URL. `code`
 * is the one-time code to show, present only in `displayed_code` mode. A prompt
 * carries no credential secret.
 */
export interface AdapterLoginPrompt {
  url: string;
  code?: string;
}

/**
 * The completion context. The server passes it to the completion hook. It
 * carries the non-secret completion state. It carries no credential byte.
 */
export interface AdapterLoginCompletionContext {
  /** The session identifier that the flow stored, when it stored one. */
  storedSessionId?: string;
}

/**
 * The optional adapter login capability. It declares how the server drives an
 * interactive sandbox login for the adapter. The capability data holds no
 * secret. An adapter with no interactive login (for example an API-key-only
 * vendor) declares no capability.
 */
export interface AdapterLoginCapability {
  /** The login panel mode. */
  panelMode: AdapterLoginPanelMode;
  /** The sandbox transport that the login command needs. */
  sandboxTransport: AdapterLoginSandboxTransport;
  /** The host-side timeout policy. */
  timeoutPolicy: AdapterLoginTimeoutPolicy;
  /** Returns the fixed, non-secret login command. */
  getCommand: () => string;
  /**
   * Parses the authorization prompt from the login output. Returns null when the
   * output holds no prompt yet. The parser keeps every input byte out of its
   * result and out of every thrown error.
   */
  parsePrompt: (output: string) => AdapterLoginPrompt | null;
  /**
   * Captures the minted credential from the login output. Returns the raw
   * credential bytes, or null when the output holds no credential yet. Only a
   * flow that prints the credential to the terminal sets it. The result is a
   * runtime secret; the capability data never stores it.
   */
  captureCredential?: (output: string) => Buffer | null;
  /**
   * Runs after a successful login. It records the non-secret completion state.
   * It carries no credential byte.
   */
  onComplete?: (ctx: AdapterLoginCompletionContext) => Promise<void>;
  /** The optional completion claim that the flow records on success. */
  completionClaim?: AdapterLoginCompletionClaim;
}

function isOneOf<T extends readonly string[]>(values: T, candidate: unknown): candidate is T[number] {
  return typeof candidate === "string" && (values as readonly string[]).includes(candidate);
}

/**
 * Validates one login capability. The function fails closed: it throws a clear
 * error for a malformed shape. It checks each scalar field against its fixed
 * value set, checks each required function member, and checks each optional
 * member only when the member is present. `adapterType` names the adapter in the
 * error text.
 */
export function assertValidAdapterLoginCapability(
  value: unknown,
  adapterType: string,
): asserts value is AdapterLoginCapability {
  const prefix = `Adapter "${adapterType}" declares an invalid login capability`;
  if (typeof value !== "object" || value === null) {
    throw new Error(`${prefix}: the capability must be an object.`);
  }
  const cap = value as Record<string, unknown>;

  if (!isOneOf(ADAPTER_LOGIN_PANEL_MODES, cap.panelMode)) {
    throw new Error(
      `${prefix}: "panelMode" must be one of ${ADAPTER_LOGIN_PANEL_MODES.join(", ")}.`,
    );
  }
  if (!isOneOf(ADAPTER_LOGIN_SANDBOX_TRANSPORTS, cap.sandboxTransport)) {
    throw new Error(
      `${prefix}: "sandboxTransport" must be one of ${ADAPTER_LOGIN_SANDBOX_TRANSPORTS.join(", ")}.`,
    );
  }
  if (!isOneOf(ADAPTER_LOGIN_TIMEOUT_POLICIES, cap.timeoutPolicy)) {
    throw new Error(
      `${prefix}: "timeoutPolicy" must be one of ${ADAPTER_LOGIN_TIMEOUT_POLICIES.join(", ")}.`,
    );
  }
  if (typeof cap.getCommand !== "function") {
    throw new Error(`${prefix}: "getCommand" must be a function.`);
  }
  if (typeof cap.parsePrompt !== "function") {
    throw new Error(`${prefix}: "parsePrompt" must be a function.`);
  }
  if (cap.captureCredential !== undefined && typeof cap.captureCredential !== "function") {
    throw new Error(`${prefix}: "captureCredential" must be a function when present.`);
  }
  if (cap.onComplete !== undefined && typeof cap.onComplete !== "function") {
    throw new Error(`${prefix}: "onComplete" must be a function when present.`);
  }
  if (
    cap.completionClaim !== undefined &&
    !isOneOf(ADAPTER_LOGIN_COMPLETION_CLAIMS, cap.completionClaim)
  ) {
    throw new Error(
      `${prefix}: "completionClaim" must be one of ${ADAPTER_LOGIN_COMPLETION_CLAIMS.join(", ")} when present.`,
    );
  }
}

/**
 * Validates the optional login capability of an adapter module. The function is
 * a no-op when the module declares no login capability. It throws a clear error
 * when the module declares a malformed capability, so the loader fails closed.
 */
export function validateAdapterLoginCapability(mod: {
  type?: unknown;
  loginCapability?: unknown;
}): void {
  if (mod.loginCapability === undefined) return;
  const adapterType = typeof mod.type === "string" && mod.type.length > 0 ? mod.type : "unknown";
  assertValidAdapterLoginCapability(mod.loginCapability, adapterType);
}
