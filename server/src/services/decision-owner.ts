import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships, issueComments, issues } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueRequesterService } from "./issue-requester.js";
import { normalizeUserId } from "./user-ids.js";

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

async function findRootHumanRequester(db: Db, args: {
  companyId: string;
  issueIds?: string[];
}): Promise<DecisionOwnerResolution | null> {
  const resolution = await issueRequesterService(db).resolveRootHumanRequesterForIssues(args);
  return resolution
    ? {
        userId: resolution.userId,
        source: "root_human_requester",
        issueId: resolution.issueId,
      }
    : null;
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
