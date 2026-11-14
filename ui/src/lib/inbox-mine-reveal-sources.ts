import type { Approval, InboxDismissal, JoinRequest } from "@paperclipai/shared";
import { isApprovalVisibleInMine } from "./inbox";

/**
 * The approvals, join requests and dismissals that Mine showed on its last
 * settled visit, for one user in one company.
 *
 * Approvals and join requests sort in among Mine's task rows by time, so on a
 * first visit Mine waits for their first answer before it shows rows. The
 * saved query cache already restores Mine's own snapshot, so on a returning
 * visit this record answers that wait too: rows show from saved data at once,
 * and every read refreshes in the background. The persisted query cache saves
 * this record per user and company (`persistedQueryScope`).
 *
 * Only what Mine renders is kept: approvals visible in Mine, pending join
 * requests, and the dismissals of those items and of Mine's failed runs. When
 * that is larger than MINE_REVEAL_SOURCES_MAX_BYTES, an empty record marked
 * `incomplete` replaces any older one, so a returning visit waits as a first
 * visit does.
 */
export type MineRevealSources = {
  userId: string;
  companyId: string;
  approvals: Approval[];
  joinRequests: JoinRequest[];
  dismissals: InboxDismissal[];
  incomplete?: true;
};

export const MINE_REVEAL_SOURCES_MAX_BYTES = 256 * 1024;

export const mineRevealSourcesQueryKey = (companyId: string, userId: string | null) =>
  ["inbox", companyId, "mine-reveal-sources", userId] as const;

export function buildMineRevealSources(input: {
  userId: string;
  companyId: string;
  approvals: readonly Approval[];
  joinRequests: readonly JoinRequest[];
  dismissals: readonly InboxDismissal[];
  failedRunIds: readonly string[];
}): MineRevealSources {
  const approvals = input.approvals.filter((approval) => isApprovalVisibleInMine(approval, input.userId));
  const joinRequests = [...input.joinRequests];
  const itemKeys = new Set([
    ...approvals.map((approval) => `approval:${approval.id}`),
    ...joinRequests.map((request) => `join:${request.id}`),
    ...input.failedRunIds.map((id) => `run:${id}`),
  ]);
  const dismissals = input.dismissals.filter((dismissal) => itemKeys.has(dismissal.itemKey));
  const sources: MineRevealSources = { userId: input.userId, companyId: input.companyId, approvals, joinRequests, dismissals };
  return JSON.stringify(sources).length <= MINE_REVEAL_SOURCES_MAX_BYTES ? sources
    : { userId: input.userId, companyId: input.companyId, approvals: [], joinRequests: [], dismissals: [], incomplete: true };
}

/** The saved record, only when it belongs to this user and company. */
export function readMineRevealSources(value: unknown, userId: string | null, companyId: string | null): MineRevealSources | null {
  if (!value || typeof value !== "object" || !userId || !companyId) return null;
  const record = value as Partial<MineRevealSources>;
  if (record.userId !== userId || record.companyId !== companyId || record.incomplete) return null;
  if (!Array.isArray(record.approvals) || !Array.isArray(record.joinRequests) || !Array.isArray(record.dismissals)) return null;
  return record as MineRevealSources;
}
