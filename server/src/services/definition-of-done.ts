/**
 * Definition-of-Done mechanical guards.
 *
 * Implements two HTTP guards on PATCH /api/issues/:id:
 *
 *   1. Pre-flight: an issue cannot be assigned to a non-board agent unless its
 *      description contains a structured `Acceptance:` field. Board-owned
 *      issues and self-assignments are exempt.
 *
 *   2. Post-flight: an issue cannot be moved to `status=done` unless the most
 *      recent comment authored by its current `assigneeAgentId` contains a
 *      `Proof:` block. Comments from other agents or the board do not satisfy.
 *
 * Detection here is regex-only (v1). A follow-up may replace this with a
 * structured column for query-ability. See HUM-183.
 */

const LOCAL_BOARD_USER_ID = "local-board";

const ACCEPTANCE_FIELD_RE =
  /(?:^|\n)\s*(?:#{1,6}\s*)?\*{0,2}\s*acceptance\s*\*{0,2}\s*:/i;
const PROOF_FIELD_RE =
  /(?:^|\n)\s*(?:#{1,6}\s*)?\*{0,2}\s*proof\s*\*{0,2}\s*[:\s]/i;

/** Test whether an issue description contains a structured Acceptance field. */
export function descriptionHasAcceptanceField(
  description: string | null | undefined,
): boolean {
  if (typeof description !== "string" || description.trim().length === 0) {
    return false;
  }
  return ACCEPTANCE_FIELD_RE.test(description);
}

/** Test whether a comment body contains a Proof: block. */
export function commentHasProofBlock(
  body: string | null | undefined,
): boolean {
  if (typeof body !== "string" || body.trim().length === 0) {
    return false;
  }
  return PROOF_FIELD_RE.test(body);
}

export type PreflightContext = {
  /** Issue existing on disk before the PATCH applies. */
  existing: {
    description: string | null;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    createdByAgentId: string | null;
    createdByUserId: string | null;
  };
  /** Normalized new assigneeAgentId from the PATCH (undefined = unchanged). */
  requestedAssigneeAgentId: string | null | undefined;
  /** Actor performing the PATCH. */
  actor: {
    actorType: "agent" | "user";
    actorId: string;
    agentId: string | null;
  };
  /** New description if patched in same call, otherwise undefined. */
  requestedDescription?: string | null;
};

export type GuardResult =
  | { allowed: true }
  | { allowed: false; status: 422; error: string };

/**
 * Decide whether a pre-flight Acceptance check should fire and, if so, whether
 * it passes. Returns `{ allowed: true }` for cases that are exempt or pass.
 *
 * Fires only when the PATCH transitions the issue to a *new* non-board,
 * non-self agent assignee. Other PATCHes (status, comment-only, etc.) are not
 * affected.
 */
export function evaluatePreflightAcceptanceGuard(
  ctx: PreflightContext,
): GuardResult {
  const { existing, requestedAssigneeAgentId, actor } = ctx;

  // Caller did not touch assigneeAgentId → no pre-flight gate.
  if (requestedAssigneeAgentId === undefined) {
    return { allowed: true };
  }

  // Clearing assignment or assigning to no one is not gated.
  if (requestedAssigneeAgentId === null) {
    return { allowed: true };
  }

  // No change in assignee → no pre-flight gate (lets unrelated PATCHes pass).
  if (requestedAssigneeAgentId === existing.assigneeAgentId) {
    return { allowed: true };
  }

  // Self-assignment by the same agent is exempt.
  if (
    actor.actorType === "agent" &&
    actor.agentId &&
    actor.agentId === requestedAssigneeAgentId
  ) {
    return { allowed: true };
  }

  // Author self-assignment is exempt (new assignee is the original creator).
  if (
    existing.createdByAgentId &&
    existing.createdByAgentId === requestedAssigneeAgentId
  ) {
    return { allowed: true };
  }

  // Board-owned issue → board can re-route freely. Spec exempts "assignee = local-board".
  const ownerIsBoard =
    existing.assigneeAgentId === null &&
    existing.assigneeUserId === LOCAL_BOARD_USER_ID;
  if (ownerIsBoard) {
    return { allowed: true };
  }

  const effectiveDescription =
    ctx.requestedDescription !== undefined
      ? ctx.requestedDescription
      : existing.description;

  if (descriptionHasAcceptanceField(effectiveDescription)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    status: 422,
    error:
      "Definition of Done guard: cannot assign to an agent without a structured `Acceptance:` field in the issue description. Add an Acceptance line before reassigning.",
  };
}

export type PostflightContext = {
  /** Existing assigneeAgentId on the issue right before the PATCH. */
  existingAssigneeAgentId: string | null;
  /** Existing issue createdAt (used for grandfathering). */
  existingCreatedAt: Date | null;
  /** Whether the PATCH is transitioning status → done. */
  transitioningToDone: boolean;
  /**
   * Latest comment on the issue (any author), or null if none.
   * Caller is responsible for fetching this only when needed.
   */
  latestAssigneeComment:
    | {
        body: string | null;
        authorAgentId: string | null;
        derivedAuthorAgentId?: string | null;
      }
    | null;
  /** Optional enforcement window override (for tests). */
  enforcement?: EnforcementWindow;
};

export type EnforcementWindow = {
  /** When enforcement deploy happened. Undefined = no grandfather window. */
  startAt?: Date | null;
  /** Grace days for in-flight items. Default 7. */
  grandfatherDays?: number;
  /** Override clock for tests. */
  now?: Date;
};

export function readEnforcementWindowFromEnv(env = process.env): EnforcementWindow {
  const raw = env.PAPERCLIP_DOD_GUARD_ENFORCEMENT_START_AT?.trim();
  const startAt = raw ? new Date(raw) : null;
  const validStart = startAt && !Number.isNaN(startAt.getTime()) ? startAt : null;

  const rawDays = env.PAPERCLIP_DOD_GUARD_GRANDFATHER_DAYS?.trim();
  const parsedDays = rawDays ? Number(rawDays) : NaN;
  const grandfatherDays =
    Number.isFinite(parsedDays) && parsedDays >= 0 ? parsedDays : 7;

  return { startAt: validStart, grandfatherDays };
}

/**
 * Decide whether a post-flight Proof check should fire and, if so, whether it
 * passes. Fires only when the PATCH is transitioning to `status=done` and the
 * issue's grandfather window has expired or doesn't apply.
 */
export function evaluatePostflightProofGuard(
  ctx: PostflightContext,
): GuardResult {
  if (!ctx.transitioningToDone) {
    return { allowed: true };
  }

  // Status=done from an unassigned-to-agent issue (e.g. board-owned) is not gated.
  if (!ctx.existingAssigneeAgentId) {
    return { allowed: true };
  }

  if (isWithinGrandfatherWindow(ctx.existingCreatedAt, ctx.enforcement)) {
    return { allowed: true };
  }

  const latest = ctx.latestAssigneeComment;
  const latestAuthor =
    latest?.authorAgentId ?? latest?.derivedAuthorAgentId ?? null;
  if (
    latest &&
    latestAuthor === ctx.existingAssigneeAgentId &&
    commentHasProofBlock(latest.body)
  ) {
    return { allowed: true };
  }

  return {
    allowed: false,
    status: 422,
    error:
      "Definition of Done guard: cannot mark this issue `done` without a `Proof:` block in the latest comment by the assigned agent. Post a Proof comment, then retry.",
  };
}

/**
 * True when the issue was created BEFORE enforcement startAt AND we are still
 * inside the `grandfatherDays` window from `startAt`. Returns false if no
 * enforcement window is configured (production default once env var unset).
 */
export function isWithinGrandfatherWindow(
  issueCreatedAt: Date | null,
  enforcement: EnforcementWindow | undefined,
): boolean {
  if (!enforcement || !enforcement.startAt) return false;
  if (!issueCreatedAt) return false;
  const grandfatherDays = enforcement.grandfatherDays ?? 7;
  const now = enforcement.now ?? new Date();
  const startMs = enforcement.startAt.getTime();
  const expiryMs = startMs + grandfatherDays * 24 * 60 * 60 * 1000;

  return issueCreatedAt.getTime() < startMs && now.getTime() < expiryMs;
}
