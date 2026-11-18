import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships, issueThreadInteractions } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { lockDashboard, responsibilityDashboardVersionService } from "./responsibility-dashboard-versions.js";

/** The confirmation card key that authorizes deleting one responsibility or area. */
export function responsibilityDeletionKey(kind: "responsibility" | "area", id: string) {
  return kind === "responsibility" ? `responsibility-delete:${id}` : `responsibility-area-delete:${id}`;
}

/**
 * Changes an agent makes for a person with its responsibility tools
 * (experimental `enableResponsibilities`). Each one is saved as a version of
 * that person's Dashboard, so it shows in the Dashboard's history under the
 * agent's name and the person can undo it there: the dashboard as it was is
 * saved first (when it changed by hand since), then the change runs, then
 * the result is saved as a `change_set` version by that agent. A permanent
 * delete is not undoable, so it runs only after the person accepts a
 * confirmation card the agent posted.
 */
export function responsibilityAgentChangeService(db: Db) {
  const versions = responsibilityDashboardVersionService(db);

  return {
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
      },
      mutate: () => Promise<T>,
    ): Promise<T> {
      const owners = [...new Set(input.ownerUserIds)];
      const touched = [...(input.touchedAreaIds ?? [])];
      for (const owner of owners) {
        await db.transaction(async (tx) => {
          await lockDashboard(tx, input.companyId, owner);
          await versions.checkpoint(tx, input.companyId, owner, null, touched);
        });
      }
      const result = await mutate();
      const created = [...(input.createdAreaIds?.(result) ?? [])];
      for (const owner of owners) {
        await db.transaction(async (tx) => {
          await lockDashboard(tx, input.companyId, owner);
          const snapshot = await versions.captureSnapshot(tx, input.companyId, owner, created, touched);
          await versions.save(tx, { companyId: input.companyId, ownerUserId: owner, cause: "change_set", snapshot, actorAgentId: input.agentId });
        });
      }
      return result;
    },

    /**
     * The person accepted this agent's confirmation card for exactly this
     * deletion: a `request_confirmation` in the company that the agent posted,
     * whose target is the deletion's key, accepted by someone who may manage
     * `ownerUserId` (themselves, or a company owner or admin). Areas pass no
     * owner: any active member of the company may accept.
     */
    async assertConfirmedDeletion(input: {
      companyId: string;
      agentId: string;
      interactionId: string | undefined;
      key: string;
      ownerUserId?: string;
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
        || card.createdByAgentId !== input.agentId || target?.type !== "custom" || target.key !== input.key
        || !card.resolvedByUserId) {
        throw refuse();
      }
      const [membership] = await db.select({ role: companyMemberships.membershipRole }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, card.resolvedByUserId),
        eq(companyMemberships.status, "active"),
      ));
      const allowed = membership && (!input.ownerUserId || card.resolvedByUserId === input.ownerUserId
        || membership.role === "owner" || membership.role === "admin");
      if (!allowed) throw refuse();
      return card;
    },
  };
}
