import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH } from "./trust-preset-resolver.js";

export interface LockedIssueAncestryRow {
  id: string;
  identifier: string | null;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
}

const ANCESTRY_LOCK_VERIFY_ATTEMPTS = 3;

/**
 * Pin an issue's parent chain for the rest of the transaction so the
 * authorization decisions that walk it (a task-bridge key's parent-tree
 * boundary, a run's low-trust boundary) decide against the same chain the
 * commit persists: a concurrent reparent of any locked row queues behind
 * this transaction instead of moving the subtree mid-decision.
 *
 * Every lock is acquired in one globally sorted pass over the full set —
 * direct parents and ancestors alike. Locking the direct parents first and
 * the ancestors bottom-up per parent let two transactions with overlapping
 * ancestor/descendant sets take the same rows in opposite order, which
 * Postgres resolves by aborting one of them as a deadlock.
 *
 * The chain is discovered without locks first, then verified against the
 * rows as actually locked; a reparent that lands inside that window is
 * chased with a bounded number of follow-up lock passes (the only
 * acquisitions that can run out of global order) before giving up with a
 * retryable conflict.
 *
 * The returned map's rows carry each locked row's current values, in
 * acquisition order.
 */
export const lockIssueAncestryForAuthorization = async (
  db: Db,
  companyId: string,
  directParentIds: string[],
  options: {
    directParentLockMode: "update" | "share";
    /** Ancestor levels to lock above the direct parents; 0 locks the direct parents only. */
    ancestorDepth?: number;
  },
): Promise<Map<string, LockedIssueAncestryRow>> => {
  const directIds = [...new Set(directParentIds)];
  const locked = new Map<string, LockedIssueAncestryRow>();
  if (directIds.length === 0) return locked;
  const ancestorDepth = options.ancestorDepth ?? LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH;

  const candidateIds = new Set(directIds);
  let frontier = directIds;
  for (let depth = 0; frontier.length > 0 && depth < ancestorDepth; depth += 1) {
    const rows = await db
      .select({ id: issues.id, parentId: issues.parentId })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, frontier)));
    const next: string[] = [];
    for (const row of rows) {
      if (row.parentId && !candidateIds.has(row.parentId)) {
        candidateIds.add(row.parentId);
        next.push(row.parentId);
      }
    }
    frontier = next;
  }

  const directIdSet = new Set(directIds);
  const lockBatch = async (ids: Iterable<string>) => {
    for (const id of [...ids].sort()) {
      if (locked.has(id)) continue;
      const row = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          companyId: issues.companyId,
          projectId: issues.projectId,
          parentId: issues.parentId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.id, id)))
        .for(directIdSet.has(id) ? options.directParentLockMode : "share")
        .then((rows) => rows[0] ?? null);
      if (row) locked.set(row.id, row);
    }
  };
  await lockBatch(candidateIds);

  for (let attempt = 0; attempt < ANCESTRY_LOCK_VERIFY_ATTEMPTS; attempt += 1) {
    const escaped = new Set<string>();
    for (const directId of directIds) {
      let cursor = locked.get(directId)?.parentId ?? null;
      for (let depth = 0; cursor && depth < ancestorDepth; depth += 1) {
        const row = locked.get(cursor);
        if (!row) {
          escaped.add(cursor);
          break;
        }
        cursor = row.parentId ?? null;
      }
    }
    if (escaped.size === 0) return locked;
    await lockBatch(escaped);
  }
  throw conflict("Issue ancestry changed concurrently during authorization; retry the request");
};
