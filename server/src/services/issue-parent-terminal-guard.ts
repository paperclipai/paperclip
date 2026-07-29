import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { unprocessable } from "../errors.js";

const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

type IssueMutation = {
  id?: string;
  parentId?: string | null;
  status?: string;
  identifier?: string | null;
  title?: string;
};

type Reader = Pick<Db, "select" | "execute">;

function isTerminal(status: string | null | undefined) {
  return status != null && TERMINAL_STATUSES.has(status);
}

function displayIssueRef(issue: { identifier: string | null; id: string }) {
  return issue.identifier || issue.id;
}

/**
 * Serializes every mutation which can change the direct parent/child terminal
 * invariant for one company. PostgreSQL advisory locks are transaction scoped,
 * so the caller must invoke this from the transaction that persists the change.
 */
export async function lockIssueParentTerminalInvariant(dbOrTx: Pick<Db, "execute">, companyId: string) {
  const lockKey = `issue-parent-terminal-invariant:${companyId}`;
  await dbOrTx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

/**
 * Checks the effective state immediately before persistence. `mutations`
 * represents inserts or patches that have not yet been written, allowing batch
 * operations to validate their final state atomically.
 */
export async function assertIssueParentTerminalInvariant(
  dbOrTx: Reader,
  companyId: string,
  mutations: IssueMutation[],
) {
  if (mutations.length === 0) return;

  const existingIds = mutations
    .map((mutation) => mutation.id)
    .filter((id): id is string => Boolean(id));
  const existingRows = existingIds.length === 0
    ? []
    : await dbOrTx
        .select({
          id: issues.id,
          parentId: issues.parentId,
          status: issues.status,
          identifier: issues.identifier,
          title: issues.title,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, existingIds)));
  const existingById = new Map(existingRows.map((row) => [row.id, row]));

  const effectiveMutations = mutations.map((mutation, index) => {
    const existing = mutation.id ? existingById.get(mutation.id) : undefined;
    if (mutation.id && !existing) return null;
    return {
      id: mutation.id ?? `pending:${index}`,
      parentId: mutation.parentId === undefined ? existing?.parentId ?? null : mutation.parentId,
      status: mutation.status === undefined ? existing?.status ?? "backlog" : mutation.status,
      identifier: mutation.identifier === undefined ? existing?.identifier ?? null : mutation.identifier,
      title: mutation.title === undefined ? existing?.title ?? "" : mutation.title,
      hasParentIdPatch: mutation.parentId !== undefined,
      hasStatusPatch: mutation.status !== undefined,
      existing: existing ?? null,
    };
  }).filter((mutation): mutation is NonNullable<typeof mutation> => mutation !== null);

  const affectedParentIds = new Set<string>();
  for (const mutation of effectiveMutations) {
    if (mutation.parentId) affectedParentIds.add(mutation.parentId);
    if (mutation.existing?.parentId) affectedParentIds.add(mutation.existing.parentId);
    if (mutation.existing && (mutation.status !== mutation.existing.status || mutation.parentId !== mutation.existing.parentId)) {
      affectedParentIds.add(mutation.id);
    }
    if (mutation.existing && (mutation.hasStatusPatch || mutation.hasParentIdPatch)) {
      affectedParentIds.add(mutation.id);
    }
  }
  if (affectedParentIds.size === 0) return;

  const affectedParentIdList = [...affectedParentIds];
  const parentRows = await dbOrTx
    .select({ id: issues.id, status: issues.status, identifier: issues.identifier })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, affectedParentIdList)));
  const parentById = new Map(parentRows.map((row) => [row.id, row]));
  const children = await dbOrTx
    .select({
      id: issues.id,
      parentId: issues.parentId,
      status: issues.status,
      identifier: issues.identifier,
      title: issues.title,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.parentId, affectedParentIdList)));
  const mutationById = new Map(effectiveMutations.filter((mutation) => !mutation.id.startsWith("pending:")).map((mutation) => [mutation.id, mutation]));

  for (const mutation of effectiveMutations) {
    if (!mutation.id.startsWith("pending:")) mutationById.set(mutation.id, mutation);
  }

  for (const parentId of affectedParentIdList) {
    const parent = parentById.get(parentId);
    if (!parent) continue;
    const parentMutation = mutationById.get(parentId);
    const effectiveParentStatus = parentMutation?.status ?? parent.status;
    if (!isTerminal(effectiveParentStatus)) continue;

    const effectiveChildren = new Map(children.filter((child) => child.parentId === parentId).map((child) => [child.id, {
      id: child.id,
      parentId: child.parentId,
      status: child.status,
      identifier: child.identifier,
      title: child.title,
    }]));
    for (const mutation of effectiveMutations) {
      const wasChild = mutation.existing?.parentId === parentId;
      const willBeChild = mutation.parentId === parentId;
      if (!wasChild && !willBeChild) continue;
      if (mutation.id.startsWith("pending:")) {
        if (willBeChild) effectiveChildren.set(mutation.id, mutation);
      } else if (!willBeChild) {
        effectiveChildren.delete(mutation.id);
      } else {
        effectiveChildren.set(mutation.id, mutation);
      }
    }
    const blockingChildren = [...effectiveChildren.values()].filter((child) => !isTerminal(child.status));
    if (blockingChildren.length === 0) continue;

    const blockingChildRefs = blockingChildren.map(displayIssueRef);
    throw unprocessable(
      `Cannot mark parent issue ${effectiveParentStatus} while child issues remain open: ${blockingChildRefs.join(", ")}`,
      {
        code: "parent_has_open_children",
        issueId: parent.id,
        issueIdentifier: parent.identifier,
        requestedStatus: effectiveParentStatus,
        blockingChildIssueIds: blockingChildren.map((child) => child.id),
        blockingChildIdentifiers: blockingChildRefs,
        blockingChildren,
      },
    );
  }
}

export function isTerminalIssueStatus(status: string | null | undefined) {
  return isTerminal(status);
}
