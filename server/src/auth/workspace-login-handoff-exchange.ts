/**
 * Ticket exchange, isolated from Better Auth and Express so the whole
 * security matrix (replay, expiry, wrong user/origin/workspace/instance,
 * missing membership, spoofed forwarded headers) is unit-testable.
 *
 * Every dependency is injected. The caller supplies expected identity from
 * *configuration*; this module never reads request headers, which is what makes
 * forwarded-header spoofing structurally impossible rather than merely checked.
 */

import {
  sanitizeWorkspaceHandoffRedirectPath,
  verifyWorkspaceHandoffTicket,
  type WorkspaceHandoffTicketPayload,
  type WorkspaceHandoffVerificationFailure,
} from "./workspace-login-handoff.js";

export type WorkspaceHandoffClonedIdentity = {
  userId: string;
  email: string | null;
  name?: string | null;
  /**
   * Whether the cloned user has an active membership **in the ticket's company**.
   * An unscoped "has some membership" answer would let the exchange hand out a
   * session with no access to the board the caller was opening.
   */
  hasActiveMembership: boolean;
};

export type WorkspaceHandoffExchangeDeps = {
  /** Resolve the cloned user by the id the ticket names, scoped to its company. */
  findClonedIdentity: (
    input: { userId: string; companyId: string },
  ) => Promise<WorkspaceHandoffClonedIdentity | null>;
  /**
   * Record the nonce, returning false when it was already recorded.
   * Must be atomic: this is the only defense against a same-window replay.
   */
  reserveNonce: (input: { nonce: string; expiresAt: Date }) => Promise<boolean>;
  /** Create an instance-scoped session for the verified cloned user. */
  createSession: (userId: string) => Promise<void>;
};

export type WorkspaceHandoffExchangeFailureReason =
  | WorkspaceHandoffVerificationFailure
  | "replayed"
  | "unknown_user"
  | "user_mismatch"
  | "missing_membership"
  | "session_failed";

export type WorkspaceHandoffExchangeResult =
  | { ok: true; redirectTo: string; payload: WorkspaceHandoffTicketPayload }
  | { ok: false; reason: WorkspaceHandoffExchangeFailureReason; payload: WorkspaceHandoffTicketPayload | null };

/**
 * HTTP status for a failed exchange.
 *
 * `not_configured` is the only server-fault case (the guest was started without
 * a key); everything else is a rejected credential and answers 401 so an
 * attacker cannot distinguish "wrong workspace" from "expired" by status alone.
 */
export function workspaceHandoffFailureStatus(reason: WorkspaceHandoffExchangeFailureReason): number {
  if (reason === "not_configured") return 503;
  if (reason === "session_failed") return 500;
  return 401;
}

/**
 * Whether a failure means the workspace itself needs repair rather than the
 * caller needing a fresh ticket. The UI turns these into an explicit
 * "clone is incomplete" state instead of a generic sign-in error.
 */
export function isWorkspaceHandoffRepairReason(reason: WorkspaceHandoffExchangeFailureReason): boolean {
  return reason === "unknown_user" || reason === "missing_membership" || reason === "user_mismatch";
}

export async function exchangeWorkspaceHandoffTicket(input: {
  ticket: string | null | undefined;
  key: string | null | undefined;
  expected: {
    instanceId: string | null;
    executionWorkspaceId: string | null;
    companyId: string | null;
    origin: string | null;
  };
  deps: WorkspaceHandoffExchangeDeps;
  now?: Date;
}): Promise<WorkspaceHandoffExchangeResult> {
  const verification = verifyWorkspaceHandoffTicket({
    ticket: input.ticket,
    key: input.key,
    expected: input.expected,
    now: input.now,
  });
  if (!verification.ok) return { ok: false, reason: verification.reason, payload: null };
  const payload = verification.payload;

  const identity = await input.deps.findClonedIdentity({ userId: payload.sub, companyId: payload.cid });
  if (!identity) return { ok: false, reason: "unknown_user", payload };
  // The email is bound into the signature, so a mismatch means the clone drifted
  // from the source instance (a reused id after a reseed), not a forged ticket.
  if ((identity.email ?? "").trim().toLowerCase() !== payload.email.trim().toLowerCase()) {
    return { ok: false, reason: "user_mismatch", payload };
  }
  if (!identity.hasActiveMembership) return { ok: false, reason: "missing_membership", payload };

  // Reserve last: an identity failure must stay retryable after a repair, while a
  // ticket that got far enough to mint a session is burned even if that mint fails.
  const reserved = await input.deps.reserveNonce({
    nonce: payload.jti,
    expiresAt: new Date(payload.exp * 1000),
  });
  if (!reserved) return { ok: false, reason: "replayed", payload };

  try {
    await input.deps.createSession(identity.userId);
  } catch {
    return { ok: false, reason: "session_failed", payload };
  }

  return {
    ok: true,
    redirectTo: sanitizeWorkspaceHandoffRedirectPath(payload.next),
    payload,
  };
}
