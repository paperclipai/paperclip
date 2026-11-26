import { and, eq, isNull } from "drizzle-orm";
import { agents, authUsers, companyMemberships, issueComments, issues, type Db } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import { redactActivityDetails } from "../services/activity-log.js";
import { activityToastDetails } from "./activity-toast-details.js";

const TOAST_ACTIONS = new Set(["issue.created", "issue.updated", "issue.comment_added"]);

export async function activityToastIdentity(
  db: Db,
  companyId: string,
  payload: Record<string, unknown>,
) {
  const actorType = typeof payload.actorType === "string" ? payload.actorType : null;
  const actorId = typeof payload.actorId === "string" ? payload.actorId : null;
  const actorIdentity = { actorType, actorId };
  if (!TOAST_ACTIONS.has(String(payload.action))) return actorIdentity;

  const issueId = payload.entityType === "issue" && typeof payload.entityId === "string"
    ? payload.entityId : null;
  let issueIdentifier: string | null = null;
  let issueTitle: string | null = null;
  if (issueId) {
    try {
      const [issue] = await db
        .select({ identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
        .limit(1);
      issueIdentifier = issue?.identifier ?? null;
      issueTitle = issue?.title ?? null;
    } catch (err) {
      logger.warn({ err, companyId, issueId }, "task toast identifier lookup failed");
    }
  }
  const details = payload.details && typeof payload.details === "object" && !Array.isArray(payload.details)
    ? payload.details as Record<string, unknown> : {};
  let notificationDetails = activityToastDetails(payload.action, { ...details, bodySnippet: undefined });
  if (issueId) {
    try {
      let bodySnippet: string | undefined;
      if (payload.action === "issue.comment_added" && typeof details.commentId === "string") {
        const [comment] = await db.select({ body: issueComments.body }).from(issueComments)
          .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
            eq(issueComments.id, details.commentId), isNull(issueComments.deletedAt))).limit(1);
        bodySnippet = comment?.body;
      }
      if (issueTitle || bodySnippet) {
        const registeredSafe = await createRunSecretRedactionRegistry(db).redactForIssueNotification(companyId, issueId, { issueTitle, bodySnippet });
        const safe = await redactActivityDetails(db, registeredSafe);
        issueTitle = typeof safe?.issueTitle === "string" ? safe.issueTitle : null;
        notificationDetails = activityToastDetails(payload.action, { ...details, bodySnippet: safe?.bodySnippet });
      }
    } catch (err) {
      issueTitle = null;
      logger.warn({ err, companyId, issueId }, "task notification content redaction failed");
    }
  }
  const identity = { ...actorIdentity, ...(issueId ? {
    issueIdentifier, issueTitle, notificationDetails,
  } : {}) };
  if (!actorId) return identity;

  if (actorType === "agent") {
    const [agent] = await db
      .select({ name: agents.name, appearance: agents.appearance })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, actorId)))
      .limit(1);
    return { ...identity, actorName: agent?.name, actorAppearance: agent?.appearance };
  }
  if (actorType === "user") {
    const [user] = await db
      .select({ name: authUsers.name, image: authUsers.image })
      .from(companyMemberships)
      .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, actorId),
        eq(companyMemberships.status, "active"),
      ))
      .limit(1);
    return { ...identity, actorName: user?.name, actorImage: user?.image };
  }
  return identity;
}

export function createActivityToastIdentity(db: Db) {
  const identities = new WeakMap<LiveEvent, Promise<Awaited<ReturnType<typeof activityToastIdentity>>>>();
  return (event: LiveEvent) => {
    let identity = identities.get(event);
    if (!identity) {
      identity = activityToastIdentity(db, event.companyId, event.payload);
      identities.set(event, identity);
    }
    return identity;
  };
}
