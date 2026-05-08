import type { ApprovalRef, InteractionRef, IssueRef } from "./types.js";

/**
 * Defense-in-depth ownership predicates. The server is expected to filter by
 * `createdByUserId` / `touchedByUserId` / `requestedByUserId` (THE-346), but if
 * the server returns extras (older deploy, cache, broader filter), these
 * checks make sure we don't accidentally page a non-owner.
 */

export function issueIsOwnedByUser(issue: IssueRef, userId: string): boolean {
  if (!userId) return false;
  return issue.createdByUserId === userId || issue.assigneeUserId === userId;
}

export function approvalIsForUser(_approval: ApprovalRef, _userId: string): boolean {
  // Approvals have no per-user pending semantic — any board member can decide.
  // We surface every pending approval to Динар (sole board user wired to the
  // bot today). If multiple board users are added we'd need a server-side
  // `pendingForUserId` field per the THE-346 followup note.
  return true;
}

export function interactionIsForUser(
  issue: IssueRef,
  interaction: InteractionRef,
  userId: string,
): boolean {
  if (interaction.status !== "pending") return false;
  // Interactions ride on top of issues. We notify the user if they're the
  // assignee or original creator of the parent issue. Interactions don't
  // carry their own assignee field today.
  return issueIsOwnedByUser(issue, userId);
}
