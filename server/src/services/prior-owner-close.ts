const TERMINAL_CLOSE_STATUSES = new Set(["done", "cancelled"]);
const TERMINAL_CLOSE_PASSTHROUGH_KEYS = new Set(["status", "comment"]);

export type PriorOwnerCloseReason =
  | "allow"
  | "not_prior_owner"
  | "revoked_checkout"
  | "revoked_comment";

export type PriorOwnerCloseComment = {
  authorAgentId?: string | null;
  deletedAt?: Date | string | null;
  createdAt?: Date | string | null;
  presentation?: { kind?: string } | null;
};

export type PriorOwnerCloseDecision = {
  allowed: boolean;
  reason: PriorOwnerCloseReason;
};

export function isPriorOwnerTerminalClosePatch(body: Record<string, unknown> | null | undefined): boolean {
  if (!body || !TERMINAL_CLOSE_STATUSES.has(String(body.status ?? ""))) return false;
  if (body.resume === true || body.reopen === true || body.interrupt === true) return false;
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (TERMINAL_CLOSE_PASSTHROUGH_KEYS.has(key)) continue;
    return false;
  }
  return true;
}

export function isRecoverySystemNoticePresentation(
  presentation: { kind?: string } | null | undefined,
): boolean {
  return presentation?.kind === "system_notice";
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function evaluatePriorOwnerTerminalCloseGrant(input: {
  actorAgentId: string;
  currentAssigneeAgentId: string | null;
  previousOwnerAgentId: string | null | undefined;
  recoveryCreatedAt: Date | string | null | undefined;
  checkoutRunAgentId: string | null;
  comments: PriorOwnerCloseComment[];
}): PriorOwnerCloseDecision {
  if (!input.previousOwnerAgentId || input.actorAgentId !== input.previousOwnerAgentId) {
    return { allowed: false, reason: "not_prior_owner" };
  }
  if (
    input.currentAssigneeAgentId &&
    input.checkoutRunAgentId &&
    input.checkoutRunAgentId === input.currentAssigneeAgentId
  ) {
    return { allowed: false, reason: "revoked_checkout" };
  }

  const stolenAt = asDate(input.recoveryCreatedAt);
  const currentAssigneeAgentId = input.currentAssigneeAgentId;
  if (currentAssigneeAgentId && stolenAt) {
    const revokedByComment = input.comments.some((comment) => {
      if (comment.deletedAt) return false;
      if (comment.authorAgentId !== currentAssigneeAgentId) return false;
      const createdAt = asDate(comment.createdAt);
      if (!createdAt || createdAt < stolenAt) return false;
      return !isRecoverySystemNoticePresentation(comment.presentation);
    });
    if (revokedByComment) return { allowed: false, reason: "revoked_comment" };
  }

  return { allowed: true, reason: "allow" };
}
