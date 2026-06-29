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
  | "current_issue_creator"
  | "current_board_actor"
  | "configured_default_board_owner"
  | "none";

export interface DecisionOwnerResolution {
  userId: string | null;
  source: DecisionOwnerResolutionSource;
  issueId?: string | null;
  commentId?: string | null;
}

/**
 * A user can resolve a decision only if they still hold an active, write-capable
 * (non-viewer) company membership. Viewer memberships are read-only (see
 * `assertCompanyAccess` in routes/authz.ts), and a missing/inactive membership
 * cannot accept the interaction/approval the decision owner is locked to. A null
 * membershipRole is treated as write-capable, matching the authz default.
 */
async function hasWriteCapableMembership(db: Db, args: {
  companyId: string;
  userId: string;
}): Promise<boolean> {
  const membership = await db
    .select({ membershipRole: companyMemberships.membershipRole })
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

  if (!membership) return false;
  return membership.membershipRole !== "viewer";
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
  if (!userId) return null;

  // The accept/approval path is locked to this exact target user, so an author
  // who was removed or downgraded to viewer can no longer resolve the decision.
  // Fall through to the next resolver (current issue creator, then the board
  // actor / configured default) instead of targeting them.
  const writeCapable = await hasWriteCapableMembership(db, {
    companyId: args.companyId,
    userId,
  });
  if (!writeCapable) return null;

  return { userId, source: "source_comment_author", commentId: comment!.id };
}

/**
 * Explicit decision owners are caller-specified, so an invalid target is a
 * caller error and we fail loudly instead of silently routing elsewhere. This
 * is the deliberate difference from the inferred resolver paths (ancestor,
 * comment author, issue creator), which fall through to the next candidate when
 * theirs cannot resolve. We still apply the same write-capable membership rule
 * so an explicit viewer/removed user is rejected rather than locked in as an
 * owner who cannot accept the interaction (TWX-1112).
 */
async function assertWriteCapableCompanyUser(db: Db, args: {
  companyId: string;
  userId: string;
}) {
  const writeCapable = await hasWriteCapableMembership(db, args);
  if (!writeCapable) {
    throw badRequest("Explicit decision owner must be an active, write-capable (non-viewer) user in this company");
  }
}

async function findRootHumanRequester(db: Db, args: {
  companyId: string;
  issueIds?: string[];
}) {
  return issueRequesterService(db).resolveRootHumanRequesterForIssues(args);
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
    await assertWriteCapableCompanyUser(db, {
      companyId: args.companyId,
      userId: explicitUserId,
    });
    return { userId: explicitUserId, source: "explicit_user" };
  }

  // Initiator resolution order (TWX-1107). The parent-chain originator always
  // wins so agent-created child issues route decisions back to the human who
  // initiated the tree, never the intermediate agent or default owner. The
  // issue's own creator only ranks below a triggering board commenter, so a
  // board member who explicitly asks for the decision is preferred over the
  // person who happened to file the issue.
  //
  // Every inferred human candidate (ancestor, comment author, issue creator)
  // must still hold an active, write-capable (non-viewer) membership: the
  // accept/approval path is locked to the resolved owner, so a removed or
  // read-only candidate cannot resolve the decision. Such candidates fall
  // through to the next resolver instead of locking the interaction to a user
  // who cannot act on it (TWX-1110 commenter, TWX-1112 issue creator/ancestor).
  const rootHumanRequester = await findRootHumanRequester(db, {
    companyId: args.companyId,
    issueIds: args.issueIds,
  });
  if (
    rootHumanRequester
    && rootHumanRequester.source === "ancestor"
    && (await hasWriteCapableMembership(db, {
      companyId: args.companyId,
      userId: rootHumanRequester.userId,
    }))
  ) {
    return {
      userId: rootHumanRequester.userId,
      source: "root_human_requester",
      issueId: rootHumanRequester.issueId,
    };
  }

  const sourceCommentAuthor = await findSourceCommentAuthor(db, {
    companyId: args.companyId,
    sourceCommentId: args.sourceCommentId,
  });
  if (sourceCommentAuthor) return sourceCommentAuthor;

  if (
    rootHumanRequester
    && rootHumanRequester.source === "current_issue"
    && (await hasWriteCapableMembership(db, {
      companyId: args.companyId,
      userId: rootHumanRequester.userId,
    }))
  ) {
    return {
      userId: rootHumanRequester.userId,
      source: "current_issue_creator",
      issueId: rootHumanRequester.issueId,
    };
  }

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
