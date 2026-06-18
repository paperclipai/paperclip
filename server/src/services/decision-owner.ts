import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships, issueComments, issues } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { instanceSettingsService } from "./instance-settings.js";

const MAX_ISSUE_PARENT_WALK_DEPTH = 50;

type IssueOwnerRow = {
  id: string;
  companyId: string;
  parentId: string | null;
  createdByUserId: string | null;
};

export type DecisionOwnerResolutionSource =
  | "explicit_user"
  | "source_comment_author"
  | "root_human_requester"
  | "current_board_actor"
  | "configured_default_board_owner"
  | "none";

export interface DecisionOwnerResolution {
  userId: string | null;
  source: DecisionOwnerResolutionSource;
  issueId?: string | null;
  commentId?: string | null;
}

function normalizeUserId(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

async function findSourceCommentAuthor(db: Db, args: {
  companyId: string;
  sourceCommentId: string | null | undefined;
}): Promise<DecisionOwnerResolution | null> {
  if (!args.sourceCommentId) return null;
  const comment = await db
    .select({
      id: issueComments.id,
      authorUserId: issueComments.authorUserId,
    })
    .from(issueComments)
    .where(and(eq(issueComments.id, args.sourceCommentId), eq(issueComments.companyId, args.companyId)))
    .then((rows) => rows[0] ?? null);
  const userId = comment ? normalizeUserId(comment.authorUserId) : null;
  return userId
    ? { userId, source: "source_comment_author", commentId: comment!.id }
    : null;
}

async function assertActiveCompanyUser(db: Db, args: {
  companyId: string;
  userId: string;
}) {
  const membership = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, args.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, args.userId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .then((rows) => rows[0] ?? null);

  if (!membership) {
    throw badRequest("Explicit decision owner must be an active user in this company");
  }
}

async function findRootHumanRequesterForIssue(db: Db, args: {
  companyId: string;
  issueId: string;
}): Promise<DecisionOwnerResolution | null> {
  const path: IssueOwnerRow[] = [];
  let cursor: string | null = args.issueId;
  const seen = new Set<string>();

  while (cursor && !seen.has(cursor) && path.length < MAX_ISSUE_PARENT_WALK_DEPTH) {
    seen.add(cursor);
    const row: IssueOwnerRow | null = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        parentId: issues.parentId,
        createdByUserId: issues.createdByUserId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, args.companyId), eq(issues.id, cursor)))
      .then((rows) => rows[0] ?? null);
    if (!row) break;
    path.push(row);
    cursor = row.parentId;
  }

  const rootmostHumanIssue = [...path]
    .reverse()
    .find((issue) => normalizeUserId(issue.createdByUserId));
  const userId = normalizeUserId(rootmostHumanIssue?.createdByUserId ?? null);
  return userId
    ? { userId, source: "root_human_requester", issueId: rootmostHumanIssue!.id }
    : null;
}

async function findRootHumanRequester(db: Db, args: {
  companyId: string;
  issueIds?: string[];
}): Promise<DecisionOwnerResolution | null> {
  const issueIds = Array.from(new Set((args.issueIds ?? []).filter(Boolean)));
  for (const issueId of issueIds) {
    const resolution = await findRootHumanRequesterForIssue(db, {
      companyId: args.companyId,
      issueId,
    });
    if (resolution) return resolution;
  }
  return null;
}

async function findConfiguredDefaultOwner(db: Db): Promise<DecisionOwnerResolution | null> {
  const settings = await instanceSettingsService(db).getGeneral();
  const configured = normalizeUserId(settings.defaultDecisionOwnerUserId)
    ?? normalizeUserId(process.env.PAPERCLIP_DEFAULT_DECISION_OWNER_USER_ID)
    ?? normalizeUserId(process.env.PAPERCLIP_DEFAULT_BOARD_USER_ID);
  return configured
    ? { userId: configured, source: "configured_default_board_owner" }
    : null;
}

export async function resolveDecisionOwnerUserId(db: Db, args: {
  companyId: string;
  explicitUserId?: string | null;
  sourceCommentId?: string | null;
  issueIds?: string[];
  currentUserId?: string | null;
}): Promise<DecisionOwnerResolution> {
  const explicitUserId = normalizeUserId(args.explicitUserId);
  if (explicitUserId) {
    await assertActiveCompanyUser(db, {
      companyId: args.companyId,
      userId: explicitUserId,
    });
    return { userId: explicitUserId, source: "explicit_user" };
  }

  const rootHumanRequester = await findRootHumanRequester(db, {
    companyId: args.companyId,
    issueIds: args.issueIds,
  });
  if (rootHumanRequester) return rootHumanRequester;

  const sourceCommentAuthor = await findSourceCommentAuthor(db, {
    companyId: args.companyId,
    sourceCommentId: args.sourceCommentId,
  });
  if (sourceCommentAuthor) return sourceCommentAuthor;

  const currentUserId = normalizeUserId(args.currentUserId);
  if (currentUserId) {
    return { userId: currentUserId, source: "current_board_actor" };
  }

  return await findConfiguredDefaultOwner(db)
    ?? { userId: null, source: "none" };
}

export async function loadIssueIdentifiers(db: Db, companyId: string, issueIds: string[]) {
  const uniqueIssueIds = Array.from(new Set(issueIds));
  if (uniqueIssueIds.length === 0) return [];
  return db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, uniqueIssueIds)));
}
