// The Claude setup-token login session service. It owns a company-scoped,
// owner-bound login session that holds one live setup-token process and one
// sandbox lease for the whole login. The login is a two-way round-trip: the
// `claude setup-token` process holds the flow state in memory, so the server
// keeps one live process and the lease alive inside one long-lived server
// process. The service never re-spawns the command per request and never splits
// the round-trip across separate runs.
//
// The service gives the harness these operations against the one live session:
// start the session, read the login prompt, submit one browser code, cancel the
// session, expire the session on a timeout, and receive the token. Every
// operation verifies the company, the owner user, and the target agent. A
// missing session and a cross-scope session both return the same not-found
// error.
//
// Security controls folded here:
//   * SR-1 (no secret in a log): the service keeps the full login URL, the
//     browser code, and the token out of every log, activity detail, error, and
//     telemetry sink. It surfaces the full URL only through the authorized owner
//     read response, and it exposes a sanitized URL form to every other reader.
//   * SR-3 (owner binding, atomic one-code): an opaque random session id, an
//     immutable scope, and a single compare-and-set transition from
//     `awaiting_code` to `submitting`. The service rejects every later submit.
//   * SR-4 (durable cleanup and caps): a non-secret cleanup record, an external
//     lease expiry no later than the session deadline, idempotent cleanup on
//     every terminal path, a startup reaper, per-owner/agent/company caps, and a
//     start rate limit.
//   * SR-5 (two login-URL representations): the full URL is transport-only; every
//     sink receives the sanitized URL form.
//   * SR-6 and SR-7 (fail-closed TLS transport guard): a centralized guard that
//     the route applies to the confidential read-prompt and receive-token
//     responses. The guard is a pure function in this module so it stays unit
//     testable.

import { randomBytes } from "node:crypto";

/** The session states. The four terminal states end the login. */
export type SetupTokenSessionState =
  | "starting"
  | "awaiting_code"
  | "submitting"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

/** The four terminal states. Cleanup runs once when a session reaches one. */
export const SETUP_TOKEN_TERMINAL_STATES: readonly SetupTokenSessionState[] = [
  "completed",
  "failed",
  "timed_out",
  "cancelled",
];

export function isTerminalSessionState(state: SetupTokenSessionState): boolean {
  return SETUP_TOKEN_TERMINAL_STATES.includes(state);
}

/**
 * The immutable owner scope of a session. Every operation verifies all three
 * fields against the stored scope. The service builds the scope once at start
 * and never changes it.
 */
export interface SetupTokenSessionScope {
  companyId: string;
  ownerUserId: string;
  targetAgentId: string;
}

/** The terminal outcome of the live login process. */
export type SetupTokenLoginOutcome = "success" | "failure" | "timeout" | "cancelled";

/**
 * The live login process the service drives for one session. A production
 * factory binds this to the setup-token runner over a sandbox pseudo-terminal.
 * A unit test binds it to a fake. The process holds the flow state in memory.
 */
export interface SetupTokenLoginProcess {
  /** Resolves with the terminal outcome when the login process ends. */
  readonly done: Promise<SetupTokenLoginOutcome>;
  /**
   * Forwards the one browser code to the live process. The service calls it one
   * time, only after the single `awaiting_code` to `submitting` transition wins.
   */
  submitCode(code: string): void;
  /**
   * Stops the direct child process. The service calls it before it releases the
   * lease. The method must be safe to call more than one time.
   */
  stop(): void;
}

/** The prompt sink the factory calls one time when it surfaces the sign-in URL. */
export type SetupTokenPromptSink = (prompt: { url: string }) => void;

/**
 * The credential sink the factory calls one time when the login binds the minted
 * token from the success record. The service holds the token in memory only and
 * returns it one time through receive-token. The sink never logs the token.
 */
export type SetupTokenCredentialSink = (token: string) => void;

/**
 * Builds the live login process for one session. The factory receives the
 * prompt sink, the credential sink, the host timeout, and an abort signal that
 * the service aborts on cancel and on expiry. The factory delivers the token one
 * time through the credential sink.
 */
export type SetupTokenLoginProcessFactory = (params: {
  scope: SetupTokenSessionScope;
  onPrompt: SetupTokenPromptSink;
  onCredential: SetupTokenCredentialSink;
  timeoutMs: number;
  signal: AbortSignal;
}) => SetupTokenLoginProcess;

/** An opaque sandbox lease handle. The service holds one per session. */
export interface SetupTokenLease {
  id: string;
}

/**
 * Acquires and releases the sandbox lease for a login session. The production
 * manager wraps the environment runtime. The service sets an external lease
 * expiry no later than the session deadline through the `deadline` field.
 */
export interface SetupTokenLeaseManager {
  acquire(input: { scope: SetupTokenSessionScope; deadline: number }): Promise<SetupTokenLease>;
  release(lease: SetupTokenLease): Promise<void>;
  /** Releases a lease by id. The startup reaper uses this after a restart. */
  releaseById(leaseId: string): Promise<void>;
}

/**
 * The non-secret cleanup record. It holds only ids, the deadline, and the
 * terminal state. It never holds a URL, a code, a token, or a raw process chunk
 * (SR-4). The service persists it at start so a restart can reap the lease.
 */
export interface SetupTokenCleanupRecord {
  sessionId: string;
  companyId: string;
  ownerUserId: string;
  targetAgentId: string;
  leaseId: string;
  deadline: number;
  state: SetupTokenSessionState;
}

/**
 * The durable store for the non-secret cleanup record. A restart reads the
 * store and reaps a lease whose session is terminal or past its deadline. The
 * store persists no secret.
 */
export interface SetupTokenCleanupStore {
  record(record: SetupTokenCleanupRecord): Promise<void>;
  markState(sessionId: string, state: SetupTokenSessionState): Promise<void>;
  remove(sessionId: string): Promise<void>;
  /** Returns each record whose session is terminal or whose deadline is past. */
  listReapable(now: number): Promise<SetupTokenCleanupRecord[]>;
}

/** A per-key start rate limiter. It matches the invite-rate-limit shape. */
export interface SetupTokenRateLimiter {
  consume(key: string): { allowed: boolean; retryAfterSeconds: number };
}

export interface SetupTokenSessionCaps {
  perOwner: number;
  perAgent: number;
  perCompany: number;
}

export const DEFAULT_SETUP_TOKEN_SESSION_CAPS: SetupTokenSessionCaps = {
  perOwner: 1,
  perAgent: 1,
  perCompany: 3,
};

/** The default host timeout for one login session. */
export const DEFAULT_SETUP_TOKEN_SESSION_TTL_MS = 5 * 60_000;

/**
 * The default retention window for a completed token. The service releases the
 * sandbox lease at once on success, but it keeps the token in memory for this
 * window, so the authorized owner can receive it one time. A short window bounds
 * how long the service holds the secret if the owner never receives it (SR-4).
 */
export const DEFAULT_SETUP_TOKEN_RETENTION_MS = 60_000;

// The fixed, non-secret error texts. The route returns these verbatim and
// echoes no input. A missing session and a cross-scope session share one text,
// so a caller cannot tell them apart.
export const SETUP_TOKEN_SESSION_NOT_FOUND = "Setup-token login session not found.";
export const SETUP_TOKEN_SUBMIT_CONFLICT = "The setup-token login session cannot accept this code.";
export const SETUP_TOKEN_RATE_LIMITED = "Too many setup-token login attempts. Try again later.";
export const SETUP_TOKEN_CAP_EXCEEDED = "Too many active setup-token login sessions.";
export const SETUP_TOKEN_TRANSPORT_INSECURE =
  "This response requires a secure transport and is not available on this request.";
// The fixed error for a token that is not ready, or that the owner already
// received. It never tells the two cases apart, so it leaks no session state.
export const SETUP_TOKEN_TOKEN_UNAVAILABLE = "The setup-token is not available for this session.";
export const SETUP_TOKEN_START_FAILED = "The setup-token login session could not start.";

/** A typed error the route maps to a fixed status and the fixed text above. */
export class SetupTokenSessionError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SetupTokenSessionError";
    this.status = status;
  }
}

/**
 * Builds the sanitized login-URL form for every non-owner sink (SR-5). The
 * function removes the query, the fragment, and the credentials, so no OAuth
 * parameter and no secret reaches a log, an activity detail, an error, a trace,
 * or client telemetry. It keeps the origin and the path for a useful diagnostic.
 * It returns a fixed placeholder for a value it cannot parse, so it never falls
 * back to the raw input.
 */
export function toSanitizedLoginUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[unparsable-login-url]";
  }
}

// --- SR-6 and SR-7: the confidential-response transport guard ----------------

/**
 * The startup transport configuration for the confidential responses. The
 * server resolves it once at startup. `trustedProxies` is the dedicated,
 * explicit proxy IP or CIDR allowlist for the confidential routes. The global
 * `TRUST_PROXY` setting does not appear here, so `TRUST_PROXY=true` and a
 * hop-count value never satisfy the guard (SR-7).
 */
export interface ConfidentialTransportConfig {
  deploymentMode: "local_trusted" | "authenticated";
  trustedProxies: string[];
}

/** The per-request transport signals the guard reads from the raw socket. */
export interface ConfidentialTransportRequest {
  /** The raw TLS bit on the immediate socket. It ignores `trust proxy`. */
  socketEncrypted: boolean;
  /** The immediate peer address. It ignores `trust proxy`. */
  remoteAddress: string | undefined;
  /** The `X-Forwarded-Proto` header value. The guard reads its first hop only. */
  forwardedProto: string | undefined;
}

export interface ConfidentialTransportDecision {
  allowed: boolean;
  reason: string;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase();
  if (normalized === "::1" || normalized === "localhost") return true;
  // Express reports an IPv4 loopback peer as `::ffff:127.0.0.1` on a dual stack.
  const withoutV4Prefix = normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized;
  return withoutV4Prefix.startsWith("127.");
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/**
 * Returns true when `address` matches `entry`. `entry` is a single IPv4 or IPv6
 * address, or an IPv4 CIDR range. The function normalizes an IPv4-mapped IPv6
 * peer (`::ffff:a.b.c.d`) to its IPv4 form first. It matches an IPv6 entry only
 * by an exact, case-insensitive string, because the confidential allowlist
 * expects a small set of known proxy addresses.
 */
function addressMatchesEntry(address: string, entry: string): boolean {
  const peer = address.trim().toLowerCase();
  const candidate = entry.trim().toLowerCase();
  if (candidate.length === 0) return false;

  const peerV4 = peer.startsWith("::ffff:") ? peer.slice("::ffff:".length) : peer;

  if (candidate.includes("/")) {
    const [network, prefixText] = candidate.split("/");
    const prefix = Number(prefixText);
    const networkInt = ipv4ToInt(network);
    const peerInt = ipv4ToInt(peerV4);
    if (networkInt === null || peerInt === null) return false;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    if (prefix === 0) return true;
    const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
    return (networkInt & mask) === (peerInt & mask);
  }

  if (candidate === peer || candidate === peerV4) return true;
  const candidateInt = ipv4ToInt(candidate);
  const peerInt = ipv4ToInt(peerV4);
  return candidateInt !== null && peerInt !== null && candidateInt === peerInt;
}

function peerMatchesAllowlist(address: string | undefined, allowlist: string[]): boolean {
  if (!address) return false;
  return allowlist.some((entry) => addressMatchesEntry(address, entry));
}

function forwardedProtoFirstHop(forwardedProto: string | undefined): string | null {
  if (!forwardedProto) return null;
  const first = forwardedProto.split(",")[0]?.trim().toLowerCase();
  return first && first.length > 0 ? first : null;
}

/**
 * Decides whether the request may receive a confidential response (the full
 * login URL or the token). The guard fails closed. It never trusts a
 * client-supplied header for the TLS decision unless the immediate peer is on
 * the dedicated proxy allowlist. It never reads the global `trust proxy`
 * setting.
 *
 * The guard allows a confidential response only in these cases:
 *   1. The immediate socket is TLS. A direct TLS request is always valid (SR-6).
 *   2. The deployment is `local_trusted` and the peer is loopback. This is the
 *      only local exception (SR-6).
 *   3. The peer is on the dedicated proxy allowlist and the forwarded protocol's
 *      first hop is `https`. A `TRUST_PROXY=true` or hop-count value does not
 *      reach this branch, because the guard never reads it (SR-7).
 *
 * Every other request fails closed and the route returns the fixed no-secret
 * error.
 */
export function evaluateConfidentialTransport(
  config: ConfidentialTransportConfig,
  request: ConfidentialTransportRequest,
): ConfidentialTransportDecision {
  if (request.socketEncrypted) {
    return { allowed: true, reason: "direct_tls" };
  }
  if (config.deploymentMode === "local_trusted" && isLoopbackAddress(request.remoteAddress)) {
    return { allowed: true, reason: "local_trusted_loopback" };
  }
  if (
    config.trustedProxies.length > 0 &&
    peerMatchesAllowlist(request.remoteAddress, config.trustedProxies) &&
    forwardedProtoFirstHop(request.forwardedProto) === "https"
  ) {
    return { allowed: true, reason: "allowlisted_proxy_tls" };
  }
  return { allowed: false, reason: "insecure_transport" };
}

/**
 * Assesses the confidential transport at startup (SR-7). The server disables
 * proxy-forwarded confidential responses when the dedicated allowlist is empty.
 * A direct TLS request and a `local_trusted` loopback request still pass at
 * runtime, because the runtime guard checks them first. The server logs the
 * returned reason so an operator can see why forwarded requests fail closed.
 */
export function assessConfidentialStartup(config: ConfidentialTransportConfig): {
  proxyForwardingEnabled: boolean;
  reason: string;
} {
  if (config.trustedProxies.length > 0) {
    return { proxyForwardingEnabled: true, reason: "proxy_allowlist_configured" };
  }
  return {
    proxyForwardingEnabled: false,
    reason:
      config.deploymentMode === "local_trusted"
        ? "no_proxy_allowlist_local_trusted_loopback_only"
        : "no_proxy_allowlist_direct_tls_only",
  };
}

// --- The session service -----------------------------------------------------

interface StoredSession {
  id: string;
  scope: SetupTokenSessionScope;
  state: SetupTokenSessionState;
  deadline: number;
  lease: SetupTokenLease;
  process: SetupTokenLoginProcess;
  abort: AbortController;
  // The full login URL. The service holds it in memory only and returns it only
  // through the authorized owner read response (SR-5).
  loginUrl: string | null;
  // The minted token. The service holds it in memory only, from the credential
  // sink until the authorized owner receives it one time or the retention window
  // ends (SR-1, SR-4).
  token: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  // The retention timer for a completed token. The service arms it after a
  // successful login and clears it when the owner receives the token.
  retentionTimer: ReturnType<typeof setTimeout> | null;
  cleanupDone: boolean;
}

/** The public read view of a session prompt. */
export interface SetupTokenPromptView {
  state: SetupTokenSessionState;
  /** The full login URL, present only when the prompt has surfaced (SR-5). */
  loginUrl: string | null;
}

export interface SetupTokenSessionServiceOptions {
  factory: SetupTokenLoginProcessFactory;
  leases: SetupTokenLeaseManager;
  store: SetupTokenCleanupStore;
  rateLimiter: SetupTokenRateLimiter;
  caps?: SetupTokenSessionCaps;
  ttlMs?: number;
  /** The retention window for a completed token. Defaults to the constant. */
  tokenRetentionMs?: number;
  now?: () => number;
  /** Returns an opaque, cryptographically random session id. */
  generateSessionId?: () => string;
  /** A non-leaking diagnostic sink. It receives only fixed status lines. */
  log?: (line: string) => void;
}

function defaultSessionId(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The setup-token login session service. It holds every live session in memory
 * and persists a non-secret cleanup record for each. It bounds active sessions
 * per owner, per agent, and per company, and it rate-limits the start path.
 */
export class SetupTokenSessionService {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly factory: SetupTokenLoginProcessFactory;
  private readonly leases: SetupTokenLeaseManager;
  private readonly store: SetupTokenCleanupStore;
  private readonly rateLimiter: SetupTokenRateLimiter;
  private readonly caps: SetupTokenSessionCaps;
  private readonly ttlMs: number;
  private readonly tokenRetentionMs: number;
  private readonly now: () => number;
  private readonly generateSessionId: () => string;
  private readonly log: (line: string) => void;

  constructor(options: SetupTokenSessionServiceOptions) {
    this.factory = options.factory;
    this.leases = options.leases;
    this.store = options.store;
    this.rateLimiter = options.rateLimiter;
    this.caps = options.caps ?? DEFAULT_SETUP_TOKEN_SESSION_CAPS;
    this.ttlMs = options.ttlMs ?? DEFAULT_SETUP_TOKEN_SESSION_TTL_MS;
    this.tokenRetentionMs = options.tokenRetentionMs ?? DEFAULT_SETUP_TOKEN_RETENTION_MS;
    this.now = options.now ?? Date.now;
    this.generateSessionId = options.generateSessionId ?? defaultSessionId;
    this.log = options.log ?? (() => {});
  }

  private countActive(predicate: (session: StoredSession) => boolean): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (!isTerminalSessionState(session.state) && predicate(session)) count += 1;
    }
    return count;
  }

  /**
   * Starts a login session. It rate-limits the start, enforces the caps,
   * acquires the lease with an external expiry no later than the deadline,
   * persists the non-secret cleanup record, and starts the one live process.
   * It returns the opaque session id and no token.
   */
  async start(scope: SetupTokenSessionScope): Promise<{ sessionId: string; state: SetupTokenSessionState }> {
    const rate = this.rateLimiter.consume(`${scope.companyId}:${scope.ownerUserId}`);
    if (!rate.allowed) {
      throw new SetupTokenSessionError(429, SETUP_TOKEN_RATE_LIMITED);
    }
    if (this.countActive((s) => s.scope.ownerUserId === scope.ownerUserId) >= this.caps.perOwner) {
      throw new SetupTokenSessionError(429, SETUP_TOKEN_CAP_EXCEEDED);
    }
    if (this.countActive((s) => s.scope.targetAgentId === scope.targetAgentId) >= this.caps.perAgent) {
      throw new SetupTokenSessionError(429, SETUP_TOKEN_CAP_EXCEEDED);
    }
    if (this.countActive((s) => s.scope.companyId === scope.companyId) >= this.caps.perCompany) {
      throw new SetupTokenSessionError(429, SETUP_TOKEN_CAP_EXCEEDED);
    }

    const sessionId = this.generateSessionId();
    const deadline = this.now() + this.ttlMs;
    const lease = await this.leases.acquire({ scope, deadline });

    await this.store.record({
      sessionId,
      companyId: scope.companyId,
      ownerUserId: scope.ownerUserId,
      targetAgentId: scope.targetAgentId,
      leaseId: lease.id,
      deadline,
      state: "starting",
    });

    const abort = new AbortController();
    const session: StoredSession = {
      id: sessionId,
      scope,
      state: "starting",
      deadline,
      lease,
      // The factory replaces this placeholder synchronously below.
      process: undefined as unknown as SetupTokenLoginProcess,
      abort,
      loginUrl: null,
      token: null,
      timer: null,
      retentionTimer: null,
      cleanupDone: false,
    };

    let process: SetupTokenLoginProcess;
    try {
      process = this.factory({
        scope,
        onPrompt: (prompt) => this.onPrompt(session, prompt),
        onCredential: (token) => this.onCredential(session, token),
        timeoutMs: this.ttlMs,
        signal: abort.signal,
      });
    } catch {
      // The factory could not start the process. Release the lease and drop the
      // durable record, then return a fixed, non-secret error.
      await this.releaseLeaseSafely(lease);
      await this.store.remove(sessionId).catch(() => {});
      throw new SetupTokenSessionError(503, SETUP_TOKEN_START_FAILED);
    }

    session.process = process;
    session.timer = setTimeout(() => {
      void this.expireInternal(sessionId);
    }, this.ttlMs);
    // A timer must never keep the process alive on its own.
    if (typeof session.timer.unref === "function") session.timer.unref();

    this.sessions.set(sessionId, session);
    // The process outcome drives the terminal state and the cleanup.
    void process.done.then(
      (outcome) => this.onProcessDone(session, outcome),
      () => this.onProcessDone(session, "failure"),
    );

    return { sessionId, state: session.state };
  }

  private onPrompt(session: StoredSession, prompt: { url: string }): void {
    if (isTerminalSessionState(session.state)) return;
    // Hold the full URL in memory only. Never log it (SR-1, SR-5).
    session.loginUrl = prompt.url;
    if (session.state === "starting") {
      session.state = "awaiting_code";
      void this.store.markState(session.id, "awaiting_code").catch(() => {});
    }
  }

  /**
   * Receives the minted token from the login process. The service holds the
   * token in memory only, until the authorized owner receives it one time or the
   * retention window ends. It never logs the token (SR-1). It ignores a token
   * that arrives after a non-success terminal state.
   */
  private onCredential(session: StoredSession, token: string): void {
    if (isTerminalSessionState(session.state) && session.state !== "completed") return;
    session.token = token;
  }

  /**
   * Resolves a session for an operation. It returns the session only when the
   * id exists and the stored scope equals the caller scope in all three fields.
   * A missing session and a cross-scope session both throw the same not-found
   * error, so a caller cannot tell them apart (SR-3).
   */
  private resolveOwned(sessionId: string, scope: SetupTokenSessionScope): StoredSession {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.scope.companyId !== scope.companyId ||
      session.scope.ownerUserId !== scope.ownerUserId ||
      session.scope.targetAgentId !== scope.targetAgentId
    ) {
      throw new SetupTokenSessionError(404, SETUP_TOKEN_SESSION_NOT_FOUND);
    }
    return session;
  }

  /**
   * Returns the prompt view for the authorized owner. The full login URL rides
   * only in this response (SR-5). The route sets `Cache-Control: no-store` and
   * applies the confidential transport guard before it calls this method.
   */
  readPrompt(sessionId: string, scope: SetupTokenSessionScope): SetupTokenPromptView {
    const session = this.resolveOwned(sessionId, scope);
    return { state: session.state, loginUrl: session.loginUrl };
  }

  /**
   * Submits the one browser code. It performs the single compare-and-set from
   * `awaiting_code` to `submitting`, then forwards the code to the live process
   * one time. It rejects every later submit, including one after an
   * invalid-code retry (SR-3).
   */
  submitCode(sessionId: string, scope: SetupTokenSessionScope, code: string): { state: SetupTokenSessionState } {
    const session = this.resolveOwned(sessionId, scope);
    if (session.state !== "awaiting_code") {
      throw new SetupTokenSessionError(409, SETUP_TOKEN_SUBMIT_CONFLICT);
    }
    session.state = "submitting";
    void this.store.markState(session.id, "submitting").catch(() => {});
    session.process.submitCode(code);
    return { state: session.state };
  }

  /**
   * Cancels a session. It stops the direct child before it releases the lease.
   * It is idempotent: a cancel on a terminal session returns the terminal state.
   */
  async cancel(sessionId: string, scope: SetupTokenSessionScope): Promise<{ state: SetupTokenSessionState }> {
    const session = this.resolveOwned(sessionId, scope);
    if (isTerminalSessionState(session.state)) {
      return { state: session.state };
    }
    await this.terminate(session, "cancelled");
    return { state: session.state };
  }

  /**
   * Expires a session on a timeout. It stops the direct child before it releases
   * the lease. The harness can call it, and the deadline timer calls the same
   * path internally.
   */
  async expire(sessionId: string, scope: SetupTokenSessionScope): Promise<{ state: SetupTokenSessionState }> {
    const session = this.resolveOwned(sessionId, scope);
    if (isTerminalSessionState(session.state)) {
      return { state: session.state };
    }
    await this.terminate(session, "timed_out");
    return { state: session.state };
  }

  private async expireInternal(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || isTerminalSessionState(session.state)) return;
    await this.terminate(session, "timed_out");
  }

  /**
   * Returns the token for the authorized owner one time. The service returns the
   * token only from a completed session that still holds it. It clears the token
   * and drops the retained session at once, so a second receive returns the same
   * not-found error as a missing session. It returns the fixed unavailable error
   * when the token is not ready or the owner already received it. The route
   * applies the confidential transport guard and sets `Cache-Control: no-store`
   * before it calls this method.
   */
  receiveToken(sessionId: string, scope: SetupTokenSessionScope): { token: string } {
    // The scope check still runs, so a cross-scope caller gets the same
    // not-found error, not the unavailable error.
    const session = this.resolveOwned(sessionId, scope);
    if (session.state !== "completed" || session.token === null) {
      throw new SetupTokenSessionError(409, SETUP_TOKEN_TOKEN_UNAVAILABLE);
    }
    const token = session.token;
    // One-shot delivery: clear the token and drop the retained session, so the
    // service never returns the token a second time (SR-1).
    this.purgeRetained(session.id);
    return { token };
  }

  /**
   * Stops the direct child, then runs the idempotent cleanup. The order stops
   * the child before the lease release on every terminal path (SR-4).
   */
  private async terminate(session: StoredSession, state: SetupTokenSessionState): Promise<void> {
    if (isTerminalSessionState(session.state)) return;
    session.state = state;
    session.abort.abort();
    try {
      session.process.stop();
    } catch {
      this.log("[paperclip] Setup-token session: the process stop step errored.");
    }
    await this.runCleanup(session, state);
  }

  /**
   * Maps the live process outcome to the terminal state and runs the cleanup.
   * A cancel or an expire already set the state, so this call is a no-op then.
   */
  private async onProcessDone(session: StoredSession, outcome: SetupTokenLoginOutcome): Promise<void> {
    if (isTerminalSessionState(session.state) && session.cleanupDone) return;
    const state: SetupTokenSessionState =
      outcome === "success"
        ? "completed"
        : outcome === "timeout"
        ? "timed_out"
        : outcome === "cancelled"
        ? "cancelled"
        : "failed";
    if (!isTerminalSessionState(session.state)) {
      session.state = state;
    }
    await this.runCleanup(session, session.state);
  }

  /**
   * Runs the idempotent cleanup for a terminal session: clear the timer, mark
   * the durable record terminal, release the lease, and drop the in-memory
   * session. It clears the in-memory login URL reference promptly (SR-3, SR-5).
   * A cleanup failure stays retryable and records no process output (SR-4).
   *
   * A completed session that still holds a token stays in memory until the
   * authorized owner receives it one time or the retention window ends. The
   * cleanup still releases the sandbox lease at once; it only holds the token in
   * memory, not the sandbox (SR-4).
   */
  private async runCleanup(session: StoredSession, state: SetupTokenSessionState): Promise<void> {
    if (session.cleanupDone) return;
    session.cleanupDone = true;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    // Clear the secret-bearing reference promptly. Best-effort only (SR-5).
    session.loginUrl = null;
    try {
      await this.store.markState(session.id, state);
    } catch {
      this.log("[paperclip] Setup-token session: the cleanup record update failed; it stays retryable.");
    }
    await this.releaseLeaseSafely(session.lease);
    try {
      await this.store.remove(session.id);
    } catch {
      this.log("[paperclip] Setup-token session: the cleanup record removal failed; it stays retryable.");
    }
    if (state === "completed" && session.token !== null) {
      // Retain the token in memory for the owner to receive it one time. The
      // retention timer purges it if the owner never receives it (SR-4).
      session.retentionTimer = setTimeout(() => this.purgeRetained(session.id), this.tokenRetentionMs);
      if (typeof session.retentionTimer.unref === "function") session.retentionTimer.unref();
      return;
    }
    this.sessions.delete(session.id);
  }

  /**
   * Purges a retained completed session. It clears the token reference, clears
   * the retention timer, and drops the in-memory session. The owner receive path
   * and the retention timer both call it (SR-1, SR-4).
   */
  private purgeRetained(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.token = null;
    if (session.retentionTimer) {
      clearTimeout(session.retentionTimer);
      session.retentionTimer = null;
    }
    this.sessions.delete(sessionId);
  }

  private async releaseLeaseSafely(lease: SetupTokenLease): Promise<void> {
    try {
      await this.leases.release(lease);
    } catch {
      // The lease release stays retryable and alertable. The startup reaper
      // releases any lease that a crash or a failure left behind.
      this.log("[paperclip] Setup-token session: the lease release failed; the reaper retries it.");
    }
  }

  /**
   * The startup reaper. It reads the durable store and releases any lease whose
   * session is terminal or past its deadline. It runs after a restart, so it
   * frees a lease that a crash left behind (SR-4). A release failure stays
   * retryable: the reaper leaves the record for a later run.
   */
  async reap(now: number = this.now()): Promise<{ released: number; failed: number }> {
    const records = await this.store.listReapable(now);
    let released = 0;
    let failed = 0;
    for (const record of records) {
      try {
        await this.leases.releaseById(record.leaseId);
        await this.store.remove(record.sessionId);
        released += 1;
      } catch {
        failed += 1;
        this.log("[paperclip] Setup-token reaper: a lease release failed; it stays retryable.");
      }
    }
    return { released, failed };
  }

  /**
   * The graceful-shutdown cleanup. It cancels every live session, so the server
   * stops each direct child before it releases each lease (SR-4).
   */
  async shutdown(): Promise<void> {
    const live = [...this.sessions.values()].filter((s) => !isTerminalSessionState(s.state));
    for (const session of live) {
      await this.terminate(session, "cancelled");
    }
  }

  /** Returns the count of live sessions. The route and the tests use it. */
  activeSessionCount(): number {
    return this.countActive(() => true);
  }
}
