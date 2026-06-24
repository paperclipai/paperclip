import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import type { IssueRootHumanRequester } from "@paperclipai/shared";
import { normalizeUserId } from "./user-ids.js";

const MAX_ISSUE_PARENT_WALK_DEPTH = 50;

type IssueRequesterPathNode = {
  id: string;
  identifier: string | null;
  title: string;
  parentId?: string | null;
  createdByUserId: string | null;
};

/**
 * Resolves requester attribution from an already-loaded issue path.
 *
 * `ancestors` must be ordered closest-parent first through rootmost ancestor,
 * matching `issueService.getAncestors()` and the DB parent walk in this file.
 */
export function resolveRootHumanRequesterFromIssuePath(args: {
  issue: IssueRequesterPathNode;
  ancestors: IssueRequesterPathNode[];
}): IssueRootHumanRequester | null {
  const rootmostHumanAncestor = [...args.ancestors]
    .reverse()
    .find((ancestor) => normalizeUserId(ancestor.createdByUserId));
  const ancestorUserId = normalizeUserId(rootmostHumanAncestor?.createdByUserId);
  if (rootmostHumanAncestor && ancestorUserId) {
    return {
      userId: ancestorUserId,
      issueId: rootmostHumanAncestor.id,
      identifier: rootmostHumanAncestor.identifier,
      title: rootmostHumanAncestor.title,
      source: "ancestor",
    };
  }

  const currentIssueUserId = normalizeUserId(args.issue.createdByUserId);
  return currentIssueUserId
    ? {
        userId: currentIssueUserId,
        issueId: args.issue.id,
        identifier: args.issue.identifier,
        title: args.issue.title,
        source: "current_issue",
      }
    : null;
}

async function resolveRootHumanRequesterForIssue(db: Db, args: {
  companyId: string;
  issueId: string;
}): Promise<IssueRootHumanRequester | null> {
  const path: IssueRequesterPathNode[] = [];
  let cursor: string | null = args.issueId;
  const seen = new Set<string>();

  while (cursor && !seen.has(cursor) && path.length < MAX_ISSUE_PARENT_WALK_DEPTH) {
    seen.add(cursor);
    const row: IssueRequesterPathNode | null = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        parentId: issues.parentId,
        createdByUserId: issues.createdByUserId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, args.companyId), eq(issues.id, cursor)))
      .then((rows) => rows[0] ?? null);
    if (!row) break;
    path.push(row);
    cursor = row.parentId ?? null;
  }

  const issue = path[0];
  if (!issue) return null;
  return resolveRootHumanRequesterFromIssuePath({
    issue,
    ancestors: path.slice(1),
  });
}

async function resolveRootHumanRequesterForIssues(db: Db, args: {
  companyId: string;
  issueIds?: string[];
}): Promise<IssueRootHumanRequester | null> {
  const issueIds = Array.from(new Set((args.issueIds ?? []).filter(Boolean)));
  for (const issueId of issueIds) {
    const resolution = await resolveRootHumanRequesterForIssue(db, {
      companyId: args.companyId,
      issueId,
    });
    if (resolution) return resolution;
  }
  return null;
}

export function issueRequesterService(db: Db) {
  return {
    resolveRootHumanRequesterForIssue: (args: {
      companyId: string;
      issueId: string;
    }) => resolveRootHumanRequesterForIssue(db, args),
    resolveRootHumanRequesterForIssues: (args: {
      companyId: string;
      issueIds?: string[];
    }) => resolveRootHumanRequesterForIssues(db, args),
  };
}
