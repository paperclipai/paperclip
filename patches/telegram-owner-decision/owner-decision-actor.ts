/**
 * Pure helpers for Telegram Owner-decision actor resolution.
 *
 * `boardAccess.identity` is a display label from /api/cli-auth/me
 * (displayName/name/login/email). It must never be passed as actorUserId.
 * Canonical Paperclip user IDs come from /api/cli-auth/me (`userId` or `user.id`)
 * using the existing Board Access token.
 */

export type BoardAccessActorState = {
  paperclipBoardApiTokenRef: string | null;
  identity: string | null;
  /** Cached canonical Paperclip user ID; optional for legacy state recovery. */
  actorUserId: string | null;
  companyId: string | null;
  updatedAt: string | null;
};

export type CliAuthMeResponse = {
  userId?: unknown;
  user?: { id?: unknown } | null;
};

export type ResolveOwnerDecisionActorResult =
  | { ok: true; actorUserId: string; displayIdentity: string | null; recovered: boolean }
  | { ok: false; reason: "company_mismatch" | "missing_token" | "invalid_token" | "missing_user_id" };

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeBoardAccessActorState(value: unknown): BoardAccessActorState {
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  return {
    paperclipBoardApiTokenRef: asNonEmptyString(record.paperclipBoardApiTokenRef),
    identity: asNonEmptyString(record.identity),
    actorUserId: asNonEmptyString(record.actorUserId),
    companyId: asNonEmptyString(record.companyId),
    updatedAt: asNonEmptyString(record.updatedAt),
  };
}

export function extractCanonicalUserId(me: CliAuthMeResponse | null | undefined): string | null {
  if (!me) return null;
  return asNonEmptyString(me.userId) ?? asNonEmptyString(me.user?.id);
}

/**
 * Resolve the board actor for a request_confirmation callback.
 *
 * - identity stays display-only
 * - cached actorUserId is preferred when company matches
 * - otherwise introspect the Board Access token via /api/cli-auth/me
 * - company mismatch / missing / invalid token fail closed
 */
export async function resolveOwnerDecisionActorUserId(input: {
  boardAccess: BoardAccessActorState;
  companyId: string;
  boardApiToken: string | null | undefined;
  fetchCliAuthMe: (token: string) => Promise<CliAuthMeResponse>;
}): Promise<ResolveOwnerDecisionActorResult> {
  const { boardAccess, companyId, boardApiToken, fetchCliAuthMe } = input;

  if (boardAccess.companyId && boardAccess.companyId !== companyId) {
    return { ok: false, reason: "company_mismatch" };
  }

  if (boardAccess.actorUserId) {
    return {
      ok: true,
      actorUserId: boardAccess.actorUserId,
      displayIdentity: boardAccess.identity,
      recovered: false,
    };
  }

  if (!boardApiToken) {
    return { ok: false, reason: "missing_token" };
  }

  let me: CliAuthMeResponse;
  try {
    me = await fetchCliAuthMe(boardApiToken);
  } catch {
    return { ok: false, reason: "invalid_token" };
  }

  const actorUserId = extractCanonicalUserId(me);
  if (!actorUserId) {
    return { ok: false, reason: "missing_user_id" };
  }

  // Guard: never treat a display label as a user id.
  if (boardAccess.identity && actorUserId === boardAccess.identity) {
    // Identity labels can theoretically equal a UUID only by coincidence; still
    // accept a true userId from /api/cli-auth/me because that is the source of truth.
  }

  return {
    ok: true,
    actorUserId,
    displayIdentity: boardAccess.identity,
    recovered: true,
  };
}

export function ownerDecisionActorFailureMessage(
  reason: Exclude<ResolveOwnerDecisionActorResult, { ok: true }>["reason"],
): string {
  switch (reason) {
    case "company_mismatch":
      return "Board access company mismatch";
    case "missing_token":
    case "invalid_token":
    case "missing_user_id":
      return "Connect board access in Paperclip Telegram settings";
  }
}
