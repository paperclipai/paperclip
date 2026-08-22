/**
 * Signed workspace login handoff (PAP-17572).
 *
 * A board user opening a managed workspace must not have to know which cloned
 * password is current. The authenticated main control plane mints a short-lived,
 * single-use ticket; the isolated workspace verifies it against its own copy of
 * the signing key and creates its own instance-scoped session.
 *
 * Threat model notes that drive the shape below:
 *
 *  - **Nothing browser-supplied is trusted.** The audience is the origin the
 *    control plane published for that runtime and the workspace compares it
 *    against its *configured* public origin. `Host`, `X-Forwarded-Host`,
 *    `X-Forwarded-Proto` and Tailscale identity headers are never consulted, so
 *    a spoofed forwarded header cannot retarget or authorize a ticket.
 *  - **Keys are per workspace.** The control plane keeps the root secret and
 *    hands each guest only `HMAC(root, instanceId|executionWorkspaceId)`. A
 *    compromised workspace therefore cannot mint a ticket for a sibling
 *    workspace, and the guest never sees material that would let it do so.
 *  - **Replay is bounded twice.** A short expiry limits the window and the
 *    workspace records the nonce on first use, so a captured ticket cannot be
 *    exchanged a second time even inside that window.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Ticket envelope version. Bumped whenever the signed payload shape changes. */
export const WORKSPACE_HANDOFF_TICKET_VERSION = "wh1";

/**
 * Default ticket lifetime. Long enough for a click plus a cold guest response,
 * short enough that a ticket leaked through a proxy log is worthless.
 */
export const WORKSPACE_HANDOFF_TICKET_TTL_SECONDS = 90;

/** Tolerated clock skew between the control plane and the isolated workspace. */
export const WORKSPACE_HANDOFF_CLOCK_SKEW_SECONDS = 30;

/** Path the guest exposes for the exchange, relative to the Better Auth mount. */
export const WORKSPACE_HANDOFF_EXCHANGE_PATH = "/workspace-handoff/exchange";

/** Query parameter carrying the ticket. Redacted from request logs by name. */
export const WORKSPACE_HANDOFF_TICKET_QUERY_PARAM = "ticket";

const HANDOFF_KEY_ENV = "PAPERCLIP_WORKSPACE_HANDOFF_KEY";
const HANDOFF_ROOT_SECRET_ENV = "PAPERCLIP_WORKSPACE_HANDOFF_SECRET";
const READINESS_TOKEN_ENV = "PAPERCLIP_WORKSPACE_READINESS_TOKEN";
const EXECUTION_WORKSPACE_ID_ENV = "PAPERCLIP_EXECUTION_WORKSPACE_ID";
const EXECUTION_WORKSPACE_COMPANY_ID_ENV = "PAPERCLIP_EXECUTION_WORKSPACE_COMPANY_ID";

export const WORKSPACE_HANDOFF_KEY_ENV_KEY = HANDOFF_KEY_ENV;
export const WORKSPACE_READINESS_TOKEN_ENV_KEY = READINESS_TOKEN_ENV;
export const WORKSPACE_EXECUTION_WORKSPACE_ID_ENV_KEY = EXECUTION_WORKSPACE_ID_ENV;
export const WORKSPACE_EXECUTION_WORKSPACE_COMPANY_ID_ENV_KEY = EXECUTION_WORKSPACE_COMPANY_ID_ENV;
export const WORKSPACE_READINESS_TOKEN_HEADER = "x-paperclip-workspace-readiness-token";
export const WORKSPACE_READINESS_USER_ID_HEADER = "x-paperclip-workspace-readiness-user-id";
export const WORKSPACE_READINESS_USER_EMAIL_HEADER = "x-paperclip-workspace-readiness-user-email";

export type WorkspaceHandoffTicketPayload = {
  /** Envelope version. */
  v: typeof WORKSPACE_HANDOFF_TICKET_VERSION;
  /** Single-use nonce; the guest records it on first exchange. */
  jti: string;
  /** Cloned user id the guest must sign in. */
  sub: string;
  /** Expected email of that cloned user, compared case-insensitively. */
  email: string;
  /** Execution workspace the ticket is scoped to. */
  ws: string;
  /**
   * Company whose board this workspace represents.
   *
   * Bound because "the cloned user has *some* active membership" is not the
   * question worth asking: a multi-company clone can satisfy it while leaving the
   * signed-in user with no access to the company they were opening, which lands
   * them on an empty board with no explanation.
   */
  cid: string;
  /** Isolated instance id the ticket is scoped to. */
  iid: string;
  /** Origin the control plane published for this runtime. */
  aud: string;
  /** Issuing instance id, recorded for audit. */
  iss: string;
  /** Seconds since epoch. */
  iat: number;
  exp: number;
  /** Relative path to land on after the exchange. */
  next: string;
};

export type WorkspaceHandoffVerificationFailure =
  | "not_configured"
  | "malformed"
  | "unsupported_version"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "origin_mismatch"
  | "instance_mismatch"
  | "workspace_mismatch"
  | "company_mismatch";

export type WorkspaceHandoffVerificationResult =
  | { ok: true; payload: WorkspaceHandoffTicketPayload }
  | { ok: false; reason: WorkspaceHandoffVerificationFailure };

function base64UrlEncode(value: Buffer): string {
  return value.toString("base64url");
}

function base64UrlDecode(value: string): Buffer | null {
  // `Buffer.from` silently drops invalid characters, so round-trip to prove the
  // input really was canonical base64url before trusting the bytes.
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0) return null;
  return base64UrlEncode(decoded) === value ? decoded : null;
}

function sign(key: string, message: string): Buffer {
  return createHmac("sha256", key).update(message).digest();
}

function constantTimeMatches(expected: Buffer, provided: Buffer): boolean {
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * Normalize an origin for comparison: scheme + host + explicit non-default port.
 * Returns null when the input is not an absolute http(s) URL, so an unparseable
 * or relative value can never accidentally compare equal.
 */
export function normalizeWorkspaceHandoffOrigin(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return parsed.origin;
}

/**
 * Reduce a caller-supplied landing target to a safe same-origin path.
 *
 * Anything absolute, protocol-relative, or backslash-escaped collapses to `/`.
 * A handoff must never double as an open redirect.
 */
export function sanitizeWorkspaceHandoffRedirectPath(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "/";
  if (!trimmed.startsWith("/")) return "/";
  // `//host` and `/\host` are both browser-recognized protocol-relative forms.
  if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) return "/";
  // Control characters and raw whitespace can split a `Location` header.
  if (/[\u0000-\u0020\u007f]/.test(trimmed)) return "/";
  return trimmed;
}

/**
 * Derive the per-workspace signing key handed to one guest instance.
 *
 * Domain-separated from every other use of the root secret and bound to both
 * identities, so a key only ever validates tickets for the exact workspace it
 * was issued to.
 */
export function deriveWorkspaceHandoffKey(input: {
  rootSecret: string;
  instanceId: string;
  executionWorkspaceId: string;
}): string {
  return createHmac("sha256", input.rootSecret)
    .update(`paperclip.workspace-login-handoff.${WORKSPACE_HANDOFF_TICKET_VERSION}\n`)
    .update(`${input.instanceId}\n`)
    .update(`${input.executionWorkspaceId}`)
    .digest("hex");
}

/**
 * Derive the bearer token the control plane presents to read a guest's
 * protected readiness. Separate derivation from {@link deriveWorkspaceHandoffKey}
 * so a probe token that leaks through an HTTP client log cannot sign tickets.
 */
export function deriveWorkspaceReadinessToken(input: {
  rootSecret: string;
  instanceId: string;
  executionWorkspaceId: string;
}): string {
  return createHmac("sha256", input.rootSecret)
    .update(`paperclip.workspace-readiness-probe.${WORKSPACE_HANDOFF_TICKET_VERSION}\n`)
    .update(`${input.instanceId}\n`)
    .update(`${input.executionWorkspaceId}`)
    .digest("hex");
}

/**
 * Root secret for handoff key derivation, on the control-plane side only.
 *
 * A dedicated `PAPERCLIP_WORKSPACE_HANDOFF_SECRET` is preferred. When it is
 * absent we derive dedicated key material from the instance's existing signing
 * secret rather than disabling the feature: the alternative is that every
 * already-deployed instance silently falls back to "remember the cloned
 * password", which is the defect this work exists to remove. The derivation is
 * one-way and domain-separated, so the handoff key is never equal to — and
 * cannot be used to recover — the secret it came from.
 */
export function resolveWorkspaceHandoffRootSecret(
  env: NodeJS.ProcessEnv = process.env,
): { secret: string; source: "dedicated" | "derived" } | null {
  const dedicated = env[HANDOFF_ROOT_SECRET_ENV]?.trim();
  if (dedicated) return { secret: dedicated, source: "dedicated" };

  const fallback = env.BETTER_AUTH_SECRET?.trim() || env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
  if (!fallback) return null;
  return {
    secret: createHmac("sha256", fallback)
      .update(`paperclip.workspace-login-handoff.root.${WORKSPACE_HANDOFF_TICKET_VERSION}`)
      .digest("hex"),
    source: "derived",
  };
}

/** The verification key injected into this (guest) process, when present. */
export function resolveWorkspaceHandoffLocalKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env[HANDOFF_KEY_ENV]?.trim() || null;
}

/** The readiness-probe token injected into this (guest) process, when present. */
export function resolveWorkspaceReadinessLocalToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return env[READINESS_TOKEN_ENV]?.trim() || null;
}

/** The execution workspace this (guest) process was provisioned for. */
export function resolveWorkspaceHandoffLocalWorkspaceId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env[EXECUTION_WORKSPACE_ID_ENV]?.trim() || null;
}

/** The company whose board this (guest) workspace represents. */
export function resolveWorkspaceHandoffLocalCompanyId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env[EXECUTION_WORKSPACE_COMPANY_ID_ENV]?.trim() || null;
}

export function issueWorkspaceHandoffTicket(input: {
  key: string;
  userId: string;
  email: string;
  executionWorkspaceId: string;
  companyId: string;
  instanceId: string;
  origin: string;
  issuerInstanceId: string;
  next?: string | null;
  ttlSeconds?: number;
  now?: Date;
  nonce?: string;
}): { ticket: string; payload: WorkspaceHandoffTicketPayload } {
  const origin = normalizeWorkspaceHandoffOrigin(input.origin);
  if (!origin) {
    throw new Error("Workspace login handoff needs an absolute http(s) target origin");
  }
  const issuedAtMs = (input.now ?? new Date()).getTime();
  const issuedAt = Math.floor(issuedAtMs / 1000);
  const ttlSeconds = Math.max(1, Math.floor(input.ttlSeconds ?? WORKSPACE_HANDOFF_TICKET_TTL_SECONDS));
  const payload: WorkspaceHandoffTicketPayload = {
    v: WORKSPACE_HANDOFF_TICKET_VERSION,
    jti: input.nonce ?? randomBytes(18).toString("base64url"),
    sub: input.userId,
    email: input.email,
    ws: input.executionWorkspaceId,
    cid: input.companyId,
    iid: input.instanceId,
    aud: origin,
    iss: input.issuerInstanceId,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    next: sanitizeWorkspaceHandoffRedirectPath(input.next),
  };
  const encodedPayload = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const signedMessage = `${WORKSPACE_HANDOFF_TICKET_VERSION}.${encodedPayload}`;
  const signature = base64UrlEncode(sign(input.key, signedMessage));
  return { ticket: `${signedMessage}.${signature}`, payload };
}

/** Absolute exchange URL for a minted ticket. */
export function buildWorkspaceHandoffExchangeUrl(input: { origin: string; ticket: string }): string {
  const origin = normalizeWorkspaceHandoffOrigin(input.origin);
  if (!origin) throw new Error("Workspace login handoff needs an absolute http(s) target origin");
  const url = new URL(`/api/auth${WORKSPACE_HANDOFF_EXCHANGE_PATH}`, origin);
  url.searchParams.set(WORKSPACE_HANDOFF_TICKET_QUERY_PARAM, input.ticket);
  return url.toString();
}

function isPayloadShape(value: unknown): value is WorkspaceHandoffTicketPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.jti === "string" && candidate.jti.length > 0
    && typeof candidate.sub === "string" && candidate.sub.length > 0
    && typeof candidate.email === "string" && candidate.email.length > 0
    && typeof candidate.ws === "string" && candidate.ws.length > 0
    && typeof candidate.cid === "string" && candidate.cid.length > 0
    && typeof candidate.iid === "string" && candidate.iid.length > 0
    && typeof candidate.aud === "string" && candidate.aud.length > 0
    && typeof candidate.iss === "string"
    && Number.isFinite(candidate.iat)
    && Number.isFinite(candidate.exp)
    && typeof candidate.next === "string"
  );
}

/**
 * Verify a ticket against this workspace's own key and identity.
 *
 * `expected` must come from persisted configuration. Passing header-derived
 * values would reintroduce exactly the spoofing path this design closes.
 */
export function verifyWorkspaceHandoffTicket(input: {
  ticket: string | null | undefined;
  key: string | null | undefined;
  expected: {
    instanceId: string | null;
    executionWorkspaceId: string | null;
    companyId: string | null;
    origin: string | null;
  };
  now?: Date;
  clockSkewSeconds?: number;
}): WorkspaceHandoffVerificationResult {
  const key = input.key?.trim();
  if (!key) return { ok: false, reason: "not_configured" };

  const expectedOrigin = normalizeWorkspaceHandoffOrigin(input.expected.origin);
  const expectedInstanceId = input.expected.instanceId?.trim();
  const expectedWorkspaceId = input.expected.executionWorkspaceId?.trim();
  const expectedCompanyId = input.expected.companyId?.trim();
  // Fail closed on unresolved local identity: without it the checks below would
  // degrade into "any validly signed ticket wins".
  if (!expectedOrigin) return { ok: false, reason: "origin_mismatch" };
  if (!expectedInstanceId) return { ok: false, reason: "instance_mismatch" };
  if (!expectedWorkspaceId) return { ok: false, reason: "workspace_mismatch" };
  if (!expectedCompanyId) return { ok: false, reason: "company_mismatch" };

  const ticket = input.ticket?.trim();
  if (!ticket) return { ok: false, reason: "malformed" };
  const segments = ticket.split(".");
  if (segments.length !== 3) return { ok: false, reason: "malformed" };
  const [version, encodedPayload, encodedSignature] = segments as [string, string, string];
  if (version !== WORKSPACE_HANDOFF_TICKET_VERSION) return { ok: false, reason: "unsupported_version" };

  const providedSignature = base64UrlDecode(encodedSignature);
  if (!providedSignature) return { ok: false, reason: "malformed" };
  const expectedSignature = sign(key, `${version}.${encodedPayload}`);
  // Signature first: never parse attacker-controlled JSON we have not authenticated.
  if (!constantTimeMatches(expectedSignature, providedSignature)) return { ok: false, reason: "bad_signature" };

  const decodedPayload = base64UrlDecode(encodedPayload);
  if (!decodedPayload) return { ok: false, reason: "malformed" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodedPayload.toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isPayloadShape(parsed)) return { ok: false, reason: "malformed" };
  if (parsed.v !== WORKSPACE_HANDOFF_TICKET_VERSION) return { ok: false, reason: "unsupported_version" };

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const skew = Math.max(0, Math.floor(input.clockSkewSeconds ?? WORKSPACE_HANDOFF_CLOCK_SKEW_SECONDS));
  if (parsed.exp + skew < nowSeconds) return { ok: false, reason: "expired" };
  if (parsed.iat - skew > nowSeconds) return { ok: false, reason: "not_yet_valid" };
  if (parsed.exp <= parsed.iat) return { ok: false, reason: "malformed" };

  if (normalizeWorkspaceHandoffOrigin(parsed.aud) !== expectedOrigin) {
    return { ok: false, reason: "origin_mismatch" };
  }
  if (parsed.iid !== expectedInstanceId) return { ok: false, reason: "instance_mismatch" };
  if (parsed.ws !== expectedWorkspaceId) return { ok: false, reason: "workspace_mismatch" };
  if (parsed.cid !== expectedCompanyId) return { ok: false, reason: "company_mismatch" };

  return {
    ok: true,
    payload: { ...parsed, next: sanitizeWorkspaceHandoffRedirectPath(parsed.next) },
  };
}

/** Verification-key identifier safe to log: proves which key, reveals no key bytes. */
export function workspaceHandoffKeyFingerprint(key: string): string {
  return createHmac("sha256", "paperclip.workspace-login-handoff.fingerprint").update(key).digest("hex").slice(0, 12);
}

/**
 * Strip the ticket from a URL or URL-ish string before it reaches a log sink.
 * Applied by the request logger and by the guest's own audit records.
 */
export function redactWorkspaceHandoffTicket(value: string): string {
  if (!value.includes(WORKSPACE_HANDOFF_TICKET_QUERY_PARAM)) return value;
  return value.replace(
    new RegExp(`([?&]${WORKSPACE_HANDOFF_TICKET_QUERY_PARAM}=)[^&#\\s]+`, "gi"),
    "$1[redacted]",
  );
}
