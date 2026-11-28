import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships, issueComments, issueThreadInteractions } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { lockDashboard, responsibilityDashboardVersionService } from "./responsibility-dashboard-versions.js";

/** Names the Dashboard version an agent's change saved, so the agent can say it can be undone. */
export const DASHBOARD_VERSION_HEADER = "X-Paperclip-Dashboard-Version";
/** Whose Dashboard history holds the version in `DASHBOARD_VERSION_HEADER`. */
export const DASHBOARD_OWNER_HEADER = "X-Paperclip-Dashboard-Owner";

/**
 * An `onVersion` that names only `ownerUserId`'s version in the response. A
 * change can also save versions of other people's Dashboards (a move between
 * owners, an area they use); those stay in their own histories.
 */
export function reportVersionOf(res: { setHeader(name: string, value: string): unknown }, ownerUserId: string) {
  return (versionId: string, owner: string) => {
    if (owner !== ownerUserId) return;
    res.setHeader(DASHBOARD_VERSION_HEADER, versionId);
    res.setHeader(DASHBOARD_OWNER_HEADER, owner);
  };
}

/** The confirmation card key that authorizes deleting one responsibility or area. */
export function responsibilityDeletionKey(kind: "responsibility" | "area", id: string) {
  return kind === "responsibility" ? `responsibility-delete:${id}` : `responsibility-area-delete:${id}`;
}

/**
 * Changes an agent makes for a person with its responsibility tools
 * (experimental `enableResponsibilities`). Each one is saved as a version of
 * the Dashboards it changes, so it shows in their history under the agent's
 * name and the person can undo it there. A permanent delete is not undoable,
 * so it runs only after the person accepts a confirmation card the agent
 * posted.
 */
export function responsibilityAgentChangeService(db: Db) {
  const versions = responsibilityDashboardVersionService(db);

  return {
    /**
     * One transaction, holding each owner's Dashboard lock throughout: the
     * dashboard as it is is saved first (when it changed by hand since), then
     * `mutate` runs on the same transaction, then the result is saved as a
     * `change_set` version by the agent. Nothing commits unless all of it
     * does, so a change is never left without its version.
     */
    async record<T>(
      input: {
        companyId: string;
        /** Whose dashboards the change touches. */
        ownerUserIds: readonly string[];
        agentId: string;
        /** Areas the change renames, archives or removes, so their versions hold them. */
        touchedAreaIds?: readonly string[];
        /** Areas the change created, so an empty one shows (and can be undone). */
        createdAreaIds?: (result: T) => readonly string[];
        /** Told each version the change saved and whose Dashboard it is, after it commits. */
        onVersion?: (versionId: string, ownerUserId: string) => void;
      },
      mutate: (tx: Db) => Promise<T>,
    ): Promise<T> {
      // A fixed lock order, so two changes that touch the same people cannot deadlock.
      const owners = [...new Set(input.ownerUserIds)].sort();
      const touched = [...(input.touchedAreaIds ?? [])];
      const saved: Array<{ id: string; owner: string }> = [];
      const result = await db.transaction(async (tx) => {
        for (const owner of owners) {
          await lockDashboard(tx, input.companyId, owner);
          await versions.checkpoint(tx, input.companyId, owner, null, touched);
        }
        const value = await mutate(tx as unknown as Db);
        // Touched areas are kept with the created ones, so later versions still hold them and Undo can reach them.
        const kept = [...new Set([...(input.createdAreaIds?.(value) ?? []), ...touched])];
        for (const owner of owners) {
          const snapshot = await versions.captureSnapshot(tx, input.companyId, owner, kept, touched);
          const version = await versions.save(tx, { companyId: input.companyId, ownerUserId: owner, cause: "change_set", snapshot, actorAgentId: input.agentId });
          if (version.created) saved.push({ id: version.row.id, owner });
        }
        return value;
      });
      for (const version of saved) input.onVersion?.(version.id, version.owner);
      return result;
    },

    /**
     * The person accepted this agent's confirmation card for exactly this
     * deletion: a `request_confirmation` in the company that the agent posted,
     * whose target is the deletion's key, accepted by someone who may manage
     * `ownerUserId` (themselves, or a company owner or admin), on the card or
     * by a verified chat reply. Areas pass no owner: any active member of the
     * company may accept.
     */
    async assertConfirmedDeletion(input: {
      companyId: string;
      agentId: string;
      interactionId: string | undefined;
      key: string;
      ownerUserId: string;
    }) {
      const refuse = () => forbidden(
        "A permanent delete needs the person's confirmation: post a confirmation card, then delete with its id after they accept it",
        { code: "responsibility_delete_confirmation_required", confirmationKey: input.key },
      );
      if (!input.interactionId || !/^[0-9a-f-]{36}$/i.test(input.interactionId)) throw refuse();
      const [card] = await db.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.id, input.interactionId),
        eq(issueThreadInteractions.companyId, input.companyId),
      ));
      const target = (card?.payload as { target?: { type?: string; key?: string } } | undefined)?.target;
      if (!card || card.kind !== "request_confirmation" || card.status !== "accepted"
        || card.createdByAgentId !== input.agentId || target?.type !== "custom" || target.key !== input.key) {
        throw refuse();
      }
      // A card answered by a verified chat reply names the reply; its author is the person who decided.
      let resolverUserId = card.resolvedByUserId;
      const replyCommentId = (card.result as { commentId?: unknown } | null)?.commentId;
      if (!resolverUserId && typeof replyCommentId === "string") {
        const [reply] = await db.select({ authorUserId: issueComments.authorUserId, authorType: issueComments.authorType })
          .from(issueComments)
          .where(and(eq(issueComments.id, replyCommentId), eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, card.issueId)));
        if (reply?.authorType === "user") resolverUserId = reply.authorUserId;
      }
      if (!resolverUserId) throw refuse();
      const [membership] = await db.select({ role: companyMemberships.membershipRole }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, resolverUserId),
        eq(companyMemberships.status, "active"),
      ));
      const allowed = membership && resolverUserId === input.ownerUserId;
      if (!allowed) throw refuse();
      return card;
    },
  };
}
