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
// operation verifies the company, the owner user, and the adapter. A missing
// session and a cross-scope session both return the same not-found error.
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
import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { adapterAuthSessions } from "@paperclipai/db";
import type { AgentAdapterType } from "@paperclipai/shared";

// The setup-token login flow supports only the `claude_local` adapter. The
// unified `adapter_auth_sessions` table also holds the Codex device-login rows,
// so every store scan filters by this adapter to reach only the setup-token
// rows.
const SETUP_TOKEN_ADAPTER_TYPE: AgentAdapterType = "claude_local";

/**
 * The session states. The four terminal states end the login. The `stored`
 * state is not terminal: a session enters `stored` after a successful
 * owner-bound secret write, and the durable row then persists as a one-time
 * claim. The create path consumes the claim, or the reaper removes the row after
 * the deadline.
 */
export type SetupTokenSessionState =
  | "starting"
  | "awaiting_code"
  | "submitting"
  | "stored"
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
 * The immutable owner scope of a session. The service builds the scope once at
 * start and never changes it. The session identity is the company, the owner,
 * and the adapter. Every operation verifies these three fields against the
 * stored scope.
 *
 * The active company credential slot is scoped to the company, the owner, and
 * the adapter. Two owners in one company no longer conflict. The scope drops the
 * environment term from the slot, so the same owner cannot hold one active login
 * per environment.
 */
export interface SetupTokenSessionScope {
  companyId: string;
  ownerUserId: string;
  // The adapter of the login. It is part of the session identity.
  adapterType: string;
  // The environment of the login. The store persists it on the row, but it is
  // not part of the session identity: a caller never addresses a session by the
  // environment, and the active slot no longer includes the environment.
  environmentId: string;
  // The optional confirmed-overwrite capture. The client sends it when a stored
  // token fails the agent test. The secret writer reads it and rotates the
  // stored value under the captured version instead of a first write. It is not
  // part of the session identity: the non-start routes rebuild the scope without
  // it, so the full-scope match ignores it (see `resolveOwned`).
  confirmedOverwrite?: { expectedSecretId: string; expectedLatestVersion: number } | null;
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
 * token from the success record. The sink is asynchronous: it awaits the
 * owner-bound secret write and rejects on a storage failure. The factory (or the
 * runner it wraps) awaits this sink before it reports success, so a storage
 * failure ends the login as a failure. The sink never logs the token and never
 * returns it.
 */
export type SetupTokenCredentialSink = (token: string) => Promise<void>;

/**
 * The atomic credential-claim writer. The service awaits it one time with the
 * minted token, the owner scope, and the durable session id. It runs one
 * control-plane transaction that first transitions the exact durable row to
 * `stored` with a full-scope conditional update, then performs the owner-bound
 * secret compare-and-set on the same transaction handle. The commit establishes
 * the encrypted secret and the `stored` claim together. It resolves on a
 * successful commit. It rejects and rolls back the whole transaction on a
 * zero-row transition or on a storage failure, so neither the secret nor the
 * claim commits. The service holds the token only for this call; it never stores
 * it.
 */
export type SetupTokenSecretWriter = (input: {
  scope: SetupTokenSessionScope;
  sessionId: string;
  token: string;
}) => Promise<void>;

/**
 * Builds the live login process for one session. The factory receives the
 * prompt sink, the credential sink, the host timeout, and an abort signal that
 * the service aborts on cancel and on expiry. The factory awaits the credential
 * sink one time before it reports success.
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
 * The non-secret cleanup record. It holds only ids, the deadline, the claim
 * marker, and the state. It never holds a URL, a code, a token, or a raw process
 * chunk. The service persists it at start so a restart can reap the lease. The
 * record carries the environment, so the store writes the non-null environment
 * column on the row.
 */
export interface SetupTokenCleanupRecord {
  sessionId: string;
  companyId: string;
  ownerUserId: string;
  adapterType: string;
  environmentId: string;
  leaseId: string;
  deadline: number;
  state: SetupTokenSessionState;
  // The claim-consumption marker. It is null while a `stored` claim is live. The
  // create path sets it one time when it consumes the claim.
  boundAt: number | null;
}

/**
 * The immutable identity of a cleanup record. It is the company, the owner, the
 * adapter, and the public session id. Every durable write matches on all four
 * fields, so a write never updates a row by the session id alone.
 */
export interface SetupTokenCleanupIdentity {
  sessionId: string;
  companyId: string;
  ownerUserId: string;
  adapterType: string;
}

/**
 * The durable store for the non-secret cleanup record. A restart reads the
 * store and reaps a lease whose session is terminal, past its deadline, or
 * already consumed. The store persists no secret.
 */
export interface SetupTokenCleanupStore {
  record(record: SetupTokenCleanupRecord): Promise<void>;
  /**
   * Marks the state only when the full owner scope and the session id match. The
   * write never updates a row by the session id alone.
   */
  markState(identity: SetupTokenCleanupIdentity, state: SetupTokenSessionState): Promise<void>;
  /**
   * Deletes the record only when the full owner scope and the session id match.
   * The delete never removes a row by the session id alone, so a cross-scope
   * caller cannot delete a foreign row.
   */
  remove(identity: SetupTokenCleanupIdentity): Promise<void>;
  /**
   * Returns each record whose session is terminal, whose deadline is past, or
   * whose claim is already consumed.
   */
  listReapable(now: number): Promise<SetupTokenCleanupRecord[]>;
  /**
   * Consumes a `stored` claim with one conditional write. The predicate carries
   * the full owner scope, the session id, `state = stored`, an unexpired
   * deadline that it checks with `clock_timestamp()`, and an unconsumed marker.
   * The write sets `bound_at` one time and returns the row on a valid consume.
   * It returns null for a missing, foreign-scope, expired, non-`stored`, or
   * already-consumed claim. It never reads the state or the expiry in a separate
   * step. The agent-service transaction calls this method.
   */
  consumeStoredClaim(identity: SetupTokenCleanupIdentity): Promise<SetupTokenCleanupRecord | null>;
}

/** The counts one reaper sweep produced over the durable cleanup store. */
export interface SetupTokenReapResult {
  /** The reapable records whose lease released and whose row cleared. */
  released: number;
  /** The reapable records whose lease release failed. The row stays for a retry. */
  failed: number;
}

/**
 * The shared setup-token reap logic. It reads the durable store and releases any
 * lease whose session is terminal, past its deadline, or already consumed. It
 * runs after a restart and on the scheduler interval, so it frees a lease that a
 * crash left behind (SR-4). A release failure stays retryable: the sweep leaves
 * the record for a later run. The standalone reaper and the in-flight session
 * service both call this function, so both flows use one reap convention.
 */
export async function reapSetupTokenLeases(
  deps: {
    store: Pick<SetupTokenCleanupStore, "listReapable" | "remove">;
    leases: Pick<SetupTokenLeaseManager, "releaseById">;
    log?: (line: string) => void;
  },
  now: number,
): Promise<SetupTokenReapResult> {
  const log = deps.log ?? (() => {});
  const records = await deps.store.listReapable(now);
  let released = 0;
  let failed = 0;
  for (const record of records) {
    try {
      await deps.leases.releaseById(record.leaseId);
      await deps.store.remove({
        sessionId: record.sessionId,
        companyId: record.companyId,
        ownerUserId: record.ownerUserId,
        adapterType: record.adapterType,
      });
      released += 1;
    } catch {
      failed += 1;
      log("[paperclip] Setup-token reaper: a lease release failed; it stays retryable.");
    }
  }
  return { released, failed };
}

/** A per-key start rate limiter. It matches the invite-rate-limit shape. */
export interface SetupTokenRateLimiter {
  consume(key: string): { allowed: boolean; retryAfterSeconds: number };
}

export interface SetupTokenSessionCaps {
  // The active-session cap per company, owner, and adapter slot. The slot cap
  // mirrors the database active-slot unique index as defense in depth.
  perOwner: number;
  perCompany: number;
}

export const DEFAULT_SETUP_TOKEN_SESSION_CAPS: SetupTokenSessionCaps = {
  perOwner: 1,
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
// The fixed error for a completion that is not ready. The session is not
// `completed` with a stored secret yet. It leaks no session state.
export const SETUP_TOKEN_TOKEN_UNAVAILABLE = "The setup-token is not available for this session.";
export const SETUP_TOKEN_START_FAILED = "The setup-token login session could not start.";
// The fixed error for a sandbox provider that does not advertise the setup-token
// login capability. Only a provider that implements the setup-token
// pseudo-terminal methods can host the login. The route returns this specific,
// typed error and starts no session, so an unsupported provider never reaches a
// session row, a lease, or a pseudo-terminal.
export const SETUP_TOKEN_PROVIDER_UNSUPPORTED =
  "The sandbox provider does not support the Claude setup-token login.";
export const SETUP_TOKEN_PROVIDER_UNSUPPORTED_CODE = "setup_token_provider_unsupported";
// The fixed error for a failed owner-bound secret write. It carries no token and
// no storage detail, so it leaks no secret.
export const SETUP_TOKEN_STORAGE_FAILED = "The setup-token login could not store the credential.";

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
  /**
   * The explicit operator declaration that every client request reaches this
   * server through a platform edge that terminates TLS (a managed PaaS such as
   * Railway, Render, or Fly, where the app socket is always plain HTTP and the
   * edge-proxy peer addresses are not operator-visible, so `trustedProxies`
   * cannot express them). Unlike the global `TRUST_PROXY` setting, which the
   * guard deliberately never reads (SR-7), this is a dedicated, single-purpose
   * statement about the confidential login routes only. When declared, a
   * request is confidential unless the edge itself labels the client hop as
   * plain `http` in `X-Forwarded-Proto`. Defaults to false.
   */
  edgeTlsTerminated?: boolean;
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
 *   3. The operator declared platform edge TLS termination
 *      (`edgeTlsTerminated`) and the edge does not label the client hop as
 *      plain `http`. The declaration is a deliberate, single-purpose operator
 *      statement about these routes; it is never derived from `TRUST_PROXY`
 *      (SR-7).
 *   4. The peer is on the dedicated proxy allowlist and the forwarded protocol's
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
  if (config.edgeTlsTerminated === true) {
    // The declaration asserts the client hop is TLS for every request the
    // platform admits. Believe the edge when it explicitly says otherwise: a
    // first-hop `http` label means the platform accepted a plain-HTTP client
    // connection, so that request still fails closed.
    if (forwardedProtoFirstHop(request.forwardedProto) !== "http") {
      return { allowed: true, reason: "operator_edge_tls_termination" };
    }
    return { allowed: false, reason: "edge_labeled_plain_http" };
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
 * proxy-forwarded confidential responses when the dedicated allowlist is empty
 * and the operator has not declared platform edge TLS termination.
 * A direct TLS request and a `local_trusted` loopback request still pass at
 * runtime, because the runtime guard checks them first. The server logs the
 * returned reason so an operator can see why forwarded requests fail closed.
 */
export function assessConfidentialStartup(config: ConfidentialTransportConfig): {
  proxyForwardingEnabled: boolean;
  reason: string;
} {
  if (config.edgeTlsTerminated === true) {
    return { proxyForwardingEnabled: true, reason: "edge_tls_termination_declared" };
  }
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

/**
 * A synchronous capacity hold for the enforced caps. The service reserves the
 * capacity for the slot and the company before the first `await` in
 * {@link SetupTokenSessionService.start}, so two concurrent starts for one slot
 * never both pass the cap. The service holds the reservation for the whole
 * session lifetime and releases it exactly one time: on an early start failure or
 * on the terminal cleanup. The `released` flag makes the release idempotent.
 */
interface CapReservation {
  released: boolean;
  companyId: string;
  // The company, owner, and adapter slot key. The reservation counts one active
  // session per slot, so it mirrors the database active-slot unique index.
  slotKey: string;
}

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
  // True after the owner-bound secret write succeeds. The service never holds the
  // token: the credential sink writes it to the secret store and the service
  // records only this non-secret marker.
  secretStored: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  // The retention timer for a completed, stored session. The service arms it
  // after a successful secret write and clears it when the owner reads the
  // completion, so the in-memory session drops even if the owner never reads it.
  retentionTimer: ReturnType<typeof setTimeout> | null;
  cleanupDone: boolean;
  // The per-session mutex tail. It serializes the owner-bound secret write
  // against a cancel, an expiry, and the process-done transition, so a terminal
  // transition and the write never interleave (complete mediation). The service
  // holds this lock across the awaited secret write, so a cancel or an expiry
  // that arrives during the write waits for the write to settle first.
  lock: Promise<void>;
  // The synchronous capacity hold for the enforced caps. The cleanup releases it
  // exactly one time when the session reaches a terminal state.
  reservation: CapReservation;
}

/** The public read view of a session prompt. */
export interface SetupTokenPromptView {
  state: SetupTokenSessionState;
  /** The full login URL, present only when the prompt has surfaced (SR-5). */
  loginUrl: string | null;
}

/**
 * The owner descriptor of a session. The company-and-environment routes read it
 * to build the response contract. It carries the immutable environment and the
 * session deadline, plus the current state and the full login URL. The route
 * projects it: the public status response drops the login URL; the owner prompt
 * response returns the login URL through the confidential transport guard.
 */
export interface SetupTokenSessionDescriptor {
  sessionId: string;
  state: SetupTokenSessionState;
  environmentId: string;
  /** The session deadline in epoch milliseconds. */
  deadline: number;
  /** The full login URL, present only after the prompt surfaces. */
  loginUrl: string | null;
}

/**
 * The completion contract for the authorized owner. It carries the non-secret
 * `storedSessionId` claim and no token. The `storedSessionId` is the
 * durable session id; the agent-create transaction consumes it as the one-time
 * stored-session claim.
 */
export interface SetupTokenCompletionView {
  storedSessionId: string;
}

export interface SetupTokenSessionServiceOptions {
  factory: SetupTokenLoginProcessFactory;
  leases: SetupTokenLeaseManager;
  store: SetupTokenCleanupStore;
  /**
   * The owner-bound secret writer. The service awaits it one time when the login
   * binds the token. It performs the compare-and-set. The service fails
   * closed on a rejection.
   */
  completeCredential: SetupTokenSecretWriter;
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
  // The live reservation counts per slot and per company. The start path reads
  // and increments these synchronously before the first `await`, so the cap
  // decision and the capacity hold are one atomic step on the event loop. The
  // slot key is the company, the owner, and the adapter.
  private readonly reservedBySlot = new Map<string, number>();
  private readonly reservedByCompany = new Map<string, number>();
  private readonly factory: SetupTokenLoginProcessFactory;
  private readonly leases: SetupTokenLeaseManager;
  private readonly store: SetupTokenCleanupStore;
  private readonly completeCredential: SetupTokenSecretWriter;
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
    this.completeCredential = options.completeCredential;
    this.rateLimiter = options.rateLimiter;
    this.caps = options.caps ?? DEFAULT_SETUP_TOKEN_SESSION_CAPS;
    this.ttlMs = options.ttlMs ?? DEFAULT_SETUP_TOKEN_SESSION_TTL_MS;
    this.tokenRetentionMs = options.tokenRetentionMs ?? DEFAULT_SETUP_TOKEN_RETENTION_MS;
    this.now = options.now ?? Date.now;
    this.generateSessionId = options.generateSessionId ?? defaultSessionId;
    this.log = options.log ?? (() => {});
  }

  /**
   * Builds the durable-record identity for a session. The store matches every
   * write on the company, the owner, the adapter, and the session id, so no write
   * updates a row by the session id alone.
   */
  private identityOf(session: StoredSession): SetupTokenCleanupIdentity {
    return {
      sessionId: session.id,
      companyId: session.scope.companyId,
      ownerUserId: session.scope.ownerUserId,
      adapterType: session.scope.adapterType,
    };
  }

  /**
   * Runs `fn` under the per-session lock. The lock serializes the owner-bound
   * secret write against a cancel, an expiry, and the process-done transition, so
   * a terminal transition and the write never interleave (complete mediation).
   * The caller inside `fn` must not call another locked method, or it deadlocks;
   * the failure path of {@link onCredential} calls {@link terminateLocked}, the
   * lock-free variant, for this reason.
   */
  private async withSessionLock<T>(session: StoredSession, fn: () => Promise<T>): Promise<T> {
    const prior = session.lock;
    let release: () => void = () => {};
    session.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private countActive(predicate: (session: StoredSession) => boolean): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (!isTerminalSessionState(session.state) && predicate(session)) count += 1;
    }
    return count;
  }

  private static incrementCount(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  private static decrementCount(counts: Map<string, number>, key: string): void {
    const next = (counts.get(key) ?? 0) - 1;
    if (next > 0) {
      counts.set(key, next);
    } else {
      counts.delete(key);
    }
  }

  /** Builds the company, owner, and adapter slot key. The reservation and the
   *  database active-slot unique index share this identity. */
  private static slotKey(
    scope: Pick<SetupTokenSessionScope, "companyId" | "ownerUserId" | "adapterType">,
  ): string {
    return [scope.companyId, scope.ownerUserId, scope.adapterType].join("\u0000");
  }

  /**
   * Reserves the capacity for one start under every enforced cap. The method is
   * synchronous, so it runs to completion before the first `await` in
   * {@link start}. Two concurrent starts for one slot cannot interleave inside
   * it: the first reserves the slot, and the second reads the incremented count
   * and fails closed with the fixed 429 cap error. The method holds the per-slot
   * and per-company semantics; the slot is the company, the owner, and the
   * adapter. It increments no counter on a rejection, so a rejected start
   * reserves nothing.
   */
  private reserveCapacity(scope: SetupTokenSessionScope): CapReservation {
    const slotKey = SetupTokenSessionService.slotKey(scope);
    if ((this.reservedBySlot.get(slotKey) ?? 0) >= this.caps.perOwner) {
      throw new SetupTokenSessionError(429, SETUP_TOKEN_CAP_EXCEEDED);
    }
    if ((this.reservedByCompany.get(scope.companyId) ?? 0) >= this.caps.perCompany) {
      throw new SetupTokenSessionError(429, SETUP_TOKEN_CAP_EXCEEDED);
    }
    SetupTokenSessionService.incrementCount(this.reservedBySlot, slotKey);
    SetupTokenSessionService.incrementCount(this.reservedByCompany, scope.companyId);
    return {
      released: false,
      companyId: scope.companyId,
      slotKey,
    };
  }

  /**
   * Releases a capacity reservation exactly one time. The `released` flag makes
   * the release idempotent, so an early start failure and the terminal cleanup
   * never double-release one reservation. The method decrements the same counters
   * that {@link reserveCapacity} incremented.
   */
  private releaseReservation(reservation: CapReservation): void {
    if (reservation.released) return;
    reservation.released = true;
    SetupTokenSessionService.decrementCount(this.reservedBySlot, reservation.slotKey);
    SetupTokenSessionService.decrementCount(this.reservedByCompany, reservation.companyId);
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
    // Reserve the capacity synchronously before the first `await`. This closes
    // the time-of-check/time-of-use window: the lease acquire, the durable write,
    // and the factory creation all run after the reservation, so two concurrent
    // starts for one owner cannot both pass the cap. The service releases the
    // reservation on every early failure below and on the terminal cleanup.
    const reservation = this.reserveCapacity(scope);

    const sessionId = this.generateSessionId();
    const deadline = this.now() + this.ttlMs;

    let lease: SetupTokenLease;
    try {
      lease = await this.leases.acquire({ scope, deadline });
    } catch (error) {
      // The lease acquire failed before any durable state exists. Roll back the
      // reservation and rethrow the original error.
      this.releaseReservation(reservation);
      throw error;
    }

    try {
      await this.store.record({
        sessionId,
        companyId: scope.companyId,
        ownerUserId: scope.ownerUserId,
        adapterType: scope.adapterType,
        environmentId: scope.environmentId,
        leaseId: lease.id,
        deadline,
        state: "starting",
        boundAt: null,
      });
    } catch (error) {
      // The durable write failed, so no record exists for the reaper to read.
      // Release the lease at once, roll back the reservation, and rethrow.
      await this.releaseLeaseSafely(lease);
      this.releaseReservation(reservation);
      throw error;
    }

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
      secretStored: false,
      timer: null,
      retentionTimer: null,
      cleanupDone: false,
      lock: Promise.resolve(),
      reservation,
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
      // The factory could not start the process. Release the lease, drop the
      // durable record, roll back the reservation, then return a fixed,
      // non-secret error.
      await this.releaseLeaseSafely(lease);
      await this.store
        .remove({
          sessionId,
          companyId: scope.companyId,
          ownerUserId: scope.ownerUserId,
          adapterType: scope.adapterType,
        })
        .catch(() => {});
      this.releaseReservation(reservation);
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
      void this.store.markState(this.identityOf(session), "awaiting_code").catch(() => {});
    }
  }

  /**
   * Receives the minted token from the login process and writes it to the
   * owner-bound secret. The service awaits the compare-and-set. The
   * service never stores the token: it passes the token to the writer, then it
   * drops the reference.
   *
   * The service runs the whole sink under the per-session lock, so a cancel or an
   * expiry cannot interleave with the write. A cancel or an expiry that wins the
   * lock first sets a terminal state; the service then writes no secret and fails
   * closed with the fixed, non-secret error. This is complete mediation: a
   * terminal session never commits a secret write.
   *
   * The writer runs one control-plane transaction. Inside it, the writer first
   * transitions the exact durable row to `stored` with a full-scope conditional
   * update, then writes or rotates the secret on the same transaction handle. The
   * commit establishes the encrypted secret and the `stored` claim together, so a
   * crash between the two steps cannot leave a stored token with no valid claim.
   * The service does not mark the durable row separately; the writer owns the
   * transition.
   *
   * On a successful write the service records the non-secret `secretStored`
   * marker. The process outcome then moves the session to `completed`. A cancel or
   * an expiry that arrives after the write committed sees the `secretStored`
   * marker and reports the completed state; it does not erase the claim (see
   * {@link terminateLocked}).
   *
   * On a zero-row transition or on a storage failure the writer rolls back the
   * whole transaction and rejects. The service then fails closed: it moves the
   * session to `failed`, keeps no secret and no claim, and rejects with a fixed,
   * non-secret error. The factory (or the runner it wraps) awaits this sink, so
   * the rejection ends the login as a failure and the process never reports
   * success.
   */
  private async onCredential(session: StoredSession, token: string): Promise<void> {
    await this.withSessionLock(session, async () => {
      // A cancel or an expiry won the lock first and set a terminal state. Do not
      // write the secret for a terminal session. Fail closed with the fixed,
      // non-secret error, so the runner ends the run as a failure.
      if (isTerminalSessionState(session.state)) {
        throw new SetupTokenSessionError(500, SETUP_TOKEN_STORAGE_FAILED);
      }
      try {
        // The writer transitions the durable row to `stored` and writes the
        // secret in one transaction. A zero-row transition or a storage failure
        // rejects and rolls back both.
        await this.completeCredential({ scope: session.scope, sessionId: session.id, token });
      } catch {
        await this.terminateLocked(session, "failed");
        throw new SetupTokenSessionError(500, SETUP_TOKEN_STORAGE_FAILED);
      }
      // The transaction committed while the service held the lock, so a cancel or
      // an expiry could not interleave. Record the non-secret marker. The durable
      // row is already `stored` from the committed transition.
      session.secretStored = true;
    });
  }

  /**
   * Resolves a session for an operation. It returns the session only when the
   * id exists and the stored scope equals the caller scope in all three identity
   * fields: the company, the owner, and the adapter. A missing session and a
   * cross-scope session both throw the same not-found error, so a caller cannot
   * tell them apart. The scope match makes a cross-company, a cross-owner, and a
   * cross-adapter session return the same not-found error as a missing session.
   */
  private resolveOwned(sessionId: string, scope: SetupTokenSessionScope): StoredSession {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.scope.companyId !== scope.companyId ||
      session.scope.ownerUserId !== scope.ownerUserId ||
      session.scope.adapterType !== scope.adapterType
    ) {
      throw new SetupTokenSessionError(404, SETUP_TOKEN_SESSION_NOT_FOUND);
    }
    return session;
  }

  /**
   * Resolves the immutable scope of a company-and-environment session. The
   * caller provides the company, the owner, and the adapter it derived from the
   * request; the route path gives the company, the actor gives the owner, and
   * the route fixes the adapter. The lookup matches these three fields, then
   * returns the full scope, including the intrinsic environment.
   *
   * A caller never supplies the environment on a read, a submit, a cancel, or a
   * completion. The environment is intrinsic to the session, so a foreign
   * environment cannot address the session. A missing session and a
   * cross-company, cross-owner, or cross-adapter session all throw the same
   * not-found error.
   */
  resolveCompanyScope(
    sessionId: string,
    key: { companyId: string; ownerUserId: string; adapterType: string },
  ): SetupTokenSessionScope {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.scope.companyId !== key.companyId ||
      session.scope.ownerUserId !== key.ownerUserId ||
      session.scope.adapterType !== key.adapterType
    ) {
      throw new SetupTokenSessionError(404, SETUP_TOKEN_SESSION_NOT_FOUND);
    }
    return session.scope;
  }

  /**
   * Returns the owner descriptor for a session. The company-and-environment
   * routes read it to build the response contract. The scope check runs first,
   * so a cross-scope caller gets the same not-found error. The route
   * projects the descriptor: the public status response drops the login URL; the
   * owner prompt response returns the login URL behind the transport guard.
   */
  describeOwned(sessionId: string, scope: SetupTokenSessionScope): SetupTokenSessionDescriptor {
    const session = this.resolveOwned(sessionId, scope);
    return {
      sessionId: session.id,
      state: session.state,
      environmentId: session.scope.environmentId,
      deadline: session.deadline,
      loginUrl: session.loginUrl,
    };
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
    void this.store.markState(this.identityOf(session), "submitting").catch(() => {});
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
   * Returns the completion contract for the authorized owner. It returns the
   * non-secret `storedSessionId` claim only from a completed session whose
   * owner-bound secret write succeeded. It returns no token. It
   * returns the fixed unavailable error when the session is not completed with a
   * stored secret. The scope check runs first, so a cross-scope caller gets the
   * same not-found error, not the unavailable error.
   *
   * The read leaves the durable row in place as the one-time stored-session
   * claim; the agent-create transaction consumes it. The route sets
   * `Cache-Control: no-store` before it calls this method.
   */
  completeSession(sessionId: string, scope: SetupTokenSessionScope): SetupTokenCompletionView {
    const session = this.resolveOwned(sessionId, scope);
    if (session.state !== "completed" || !session.secretStored) {
      throw new SetupTokenSessionError(409, SETUP_TOKEN_TOKEN_UNAVAILABLE);
    }
    return { storedSessionId: session.id };
  }

  /**
   * Stops the direct child, then runs the idempotent cleanup under the
   * per-session lock. The lock serializes the terminal transition against the
   * owner-bound secret write, so a cancel or an expiry never interleaves with the
   * write (complete mediation). The order stops the child before the lease
   * release on every terminal path.
   */
  private async terminate(session: StoredSession, state: SetupTokenSessionState): Promise<void> {
    await this.withSessionLock(session, () => this.terminateLocked(session, state));
  }

  /**
   * The lock-free terminal transition. The caller must already hold the
   * per-session lock. The failure path of {@link onCredential} calls it directly,
   * because that path already holds the lock.
   *
   * If the owner-bound secret write already committed, the delivery won the
   * serialized ordering. The service completes the session and keeps the stored
   * claim; it does not cancel, expire, or erase the claim. This makes the
   * terminal API report the completed state after a successful write, rather than
   * erase it.
   */
  private async terminateLocked(session: StoredSession, state: SetupTokenSessionState): Promise<void> {
    if (isTerminalSessionState(session.state)) return;
    const resolved: SetupTokenSessionState = session.secretStored ? "completed" : state;
    session.state = resolved;
    session.abort.abort();
    try {
      session.process.stop();
    } catch {
      this.log("[paperclip] Setup-token session: the process stop step errored.");
    }
    await this.runCleanup(session, resolved);
  }

  /**
   * Maps the live process outcome to the terminal state and runs the cleanup
   * under the per-session lock. A cancel or an expire already set the state, so
   * this call is a no-op then.
   */
  private async onProcessDone(session: StoredSession, outcome: SetupTokenLoginOutcome): Promise<void> {
    await this.withSessionLock(session, async () => {
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
    });
  }

  /**
   * Runs the idempotent cleanup for a terminal session: clear the timer, mark
   * the durable record terminal, release the lease, and drop the in-memory
   * session. It clears the in-memory login URL reference promptly (SR-3, SR-5).
   * A cleanup failure stays retryable and records no process output (SR-4).
   *
   * A completed session with a stored secret keeps its durable row as the
   * one-time stored-session claim: the cleanup marks no terminal state and does
   * not remove the row. The agent-create transaction consumes the claim, or the
   * reaper removes the row after the deadline. The cleanup still releases the
   * sandbox lease at once. It retains the in-memory session for the retention
   * window, so the owner can read the completion once.
   */
  private async runCleanup(session: StoredSession, state: SetupTokenSessionState): Promise<void> {
    if (session.cleanupDone) return;
    session.cleanupDone = true;
    // Release the capacity reservation as the session reaches a terminal state.
    // A terminal session no longer counts against a cap, so the owner regains the
    // slot at once, even while a completed session lingers for the retention read.
    this.releaseReservation(session.reservation);
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    // Clear the secret-bearing reference promptly. Best-effort only (SR-5).
    session.loginUrl = null;
    const storedClaim = state === "completed" && session.secretStored;
    if (!storedClaim) {
      try {
        await this.store.markState(this.identityOf(session), state);
      } catch {
        this.log("[paperclip] Setup-token session: the cleanup record update failed; it stays retryable.");
      }
    }
    await this.releaseLeaseSafely(session.lease);
    if (storedClaim) {
      // Keep the durable row as the stored-session claim. Retain the in-memory
      // session for the owner to read the completion one time.
      session.retentionTimer = setTimeout(() => this.purgeRetained(session.id), this.tokenRetentionMs);
      if (typeof session.retentionTimer.unref === "function") session.retentionTimer.unref();
      return;
    }
    try {
      await this.store.remove(this.identityOf(session));
    } catch {
      this.log("[paperclip] Setup-token session: the cleanup record removal failed; it stays retryable.");
    }
    this.sessions.delete(session.id);
  }

  /**
   * Purges a retained completed session from memory. It clears the retention
   * timer and drops the in-memory session. The durable stored-session claim
   * stays in the store for the create flow or the reaper.
   */
  private purgeRetained(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
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
   * retryable: the reaper leaves the record for a later run. The standalone
   * scheduled reaper calls the same {@link reapSetupTokenLeases} logic.
   */
  async reap(now: number = this.now()): Promise<SetupTokenReapResult> {
    return reapSetupTokenLeases({ store: this.store, leases: this.leases, log: this.log }, now);
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

// --- The durable, database-backed cleanup store ------------------------------
//
// The store reads and writes the unified `adapter_auth_sessions` table. It maps
// the setup-token record fields to the unified columns:
//   - `sessionId`    -> `public_session_id`
//   - `ownerUserId`  -> `started_by_user_id`
//   - `leaseId`      -> `provider_lease_id`
//   - `state`        -> `status`
//   - `deadline`     -> `expires_at`
// The table also holds the Codex device-login rows, so every scan filters by the
// setup-token adapter to reach only the setup-token rows.

type AdapterAuthSessionRow = typeof adapterAuthSessions.$inferSelect;

/** Maps a database row to the non-secret cleanup record. */
function toCleanupRecord(row: AdapterAuthSessionRow): SetupTokenCleanupRecord {
  return {
    sessionId: row.publicSessionId,
    companyId: row.companyId,
    ownerUserId: row.startedByUserId,
    adapterType: row.adapterType,
    environmentId: row.environmentId,
    leaseId: row.providerLeaseId ?? "",
    // The setup-token flow always writes an expiry, so a null value means a
    // corrupt row. Treat it as already expired, so the reaper reclaims it.
    deadline: row.expiresAt ? row.expiresAt.getTime() : 0,
    state: row.status as SetupTokenSessionState,
    boundAt: row.boundAt ? row.boundAt.getTime() : null,
  };
}

/**
 * The database scope predicate. It matches the company, the owner, the adapter,
 * and the public session id, so no write ever addresses a row by the session id
 * alone. The `company_id` and `started_by_user_id` terms hold the server-scoped
 * lookup: a query never keys on the public session id alone.
 */
function setupTokenScopeMatch(identity: SetupTokenCleanupIdentity) {
  return and(
    eq(adapterAuthSessions.publicSessionId, identity.sessionId),
    eq(adapterAuthSessions.companyId, identity.companyId),
    eq(adapterAuthSessions.startedByUserId, identity.ownerUserId),
    eq(adapterAuthSessions.adapterType, identity.adapterType as AgentAdapterType),
  );
}

/**
 * The live pre-`stored` states a session may hold when the credential arrives.
 * The atomic claim writer transitions a row to `stored` only from one of these
 * states. It never transitions a terminal, an already-`stored`, or a foreign row.
 */
export const SETUP_TOKEN_STORED_PREDECESSOR_STATES: readonly SetupTokenSessionState[] = [
  "starting",
  "awaiting_code",
  "submitting",
];

/**
 * Transitions the exact session row to `stored` with one conditional update. The
 * predicate matches the full owner scope and the session id, an allowed
 * predecessor state, an unexpired deadline against `clock_timestamp()`, and an
 * unconsumed `bound_at`. It uses `UPDATE … RETURNING` and returns true only when
 * exactly one row transitions.
 *
 * The atomic claim writer runs this update on the same transaction handle as the
 * secret write, so the commit establishes the `stored` claim and the encrypted
 * secret together. A zero-row result rolls back the whole transaction, so a
 * stale, expired, terminal, foreign-scope, or already-bound row writes no
 * secret.
 */
export async function transitionSetupTokenSessionToStored(
  executor: Db,
  identity: SetupTokenCleanupIdentity,
): Promise<boolean> {
  const changed = await executor
    .update(adapterAuthSessions)
    .set({ status: "stored", updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        setupTokenScopeMatch(identity),
        inArray(adapterAuthSessions.status, [...SETUP_TOKEN_STORED_PREDECESSOR_STATES]),
        gt(adapterAuthSessions.expiresAt, sql`clock_timestamp()`),
        isNull(adapterAuthSessions.boundAt),
      ),
    )
    .returning();
  return changed.length === 1;
}

/**
 * Builds the durable, database-backed cleanup store. It persists only the
 * non-secret record. Every write matches the full owner scope and the session
 * id, so no write updates a row by the session id alone. The
 * claim-consumption write folds the state check, the deadline check, and the
 * consumption into one conditional write.
 */
export function createDbSetupTokenCleanupStore(db: Db): SetupTokenCleanupStore {
  // The store keys every scoped write on the full owner scope plus the session id.
  const scopeMatch = setupTokenScopeMatch;

  return {
    async record(record): Promise<void> {
      // The database generates `id`. The store fills `public_session_id` with the
      // service session id, which the service builds from a CSPRNG at start.
      await db.insert(adapterAuthSessions).values({
        companyId: record.companyId,
        environmentId: record.environmentId,
        adapterType: record.adapterType as AgentAdapterType,
        startedByUserId: record.ownerUserId,
        publicSessionId: record.sessionId,
        providerLeaseId: record.leaseId,
        status: record.state,
        expiresAt: new Date(record.deadline),
        boundAt: record.boundAt === null ? null : new Date(record.boundAt),
      });
    },

    async markState(identity, state): Promise<void> {
      // The compare-and-set predicate matches the company, the owner, and the
      // adapter, so a write never updates a row by the session id alone.
      await db
        .update(adapterAuthSessions)
        .set({ status: state, updatedAt: sql`clock_timestamp()` })
        .where(scopeMatch(identity));
    },

    async remove(identity): Promise<void> {
      // The delete matches the company, the owner, and the adapter, so it never
      // removes a row by the session id alone.
      await db.delete(adapterAuthSessions).where(scopeMatch(identity));
    },

    async listReapable(now): Promise<SetupTokenCleanupRecord[]> {
      // A record is reapable when its session is terminal, its deadline is past,
      // or its claim is already consumed. The scan filters by the setup-token
      // adapter, so it never reaps a Codex device-login row on the shared table.
      // The deadline index supports the scan.
      const rows = await db
        .select()
        .from(adapterAuthSessions)
        .where(
          and(
            eq(adapterAuthSessions.adapterType, SETUP_TOKEN_ADAPTER_TYPE),
            or(
              inArray(adapterAuthSessions.status, [...SETUP_TOKEN_TERMINAL_STATES]),
              lte(adapterAuthSessions.expiresAt, new Date(now)),
              isNotNull(adapterAuthSessions.boundAt),
            ),
          ),
        );
      return rows.map(toCleanupRecord);
    },

    async consumeStoredClaim(identity): Promise<SetupTokenCleanupRecord | null> {
      // One conditional write. The predicate carries the company, the owner, the
      // adapter, the session id, `status = stored`, an unexpired deadline, and an
      // unconsumed marker. It checks the deadline with `clock_timestamp()`, so the
      // database evaluates the current time after any row-lock wait. An expired
      // claim cannot pass the deadline condition. The write sets `bound_at` one
      // time and returns the row only on a valid consume.
      const changed = await db
        .update(adapterAuthSessions)
        .set({ boundAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            scopeMatch(identity),
            eq(adapterAuthSessions.status, "stored"),
            gt(adapterAuthSessions.expiresAt, sql`clock_timestamp()`),
            isNull(adapterAuthSessions.boundAt),
          ),
        )
        .returning();
      const row = changed[0];
      return row ? toCleanupRecord(row) : null;
    },
  };
}
