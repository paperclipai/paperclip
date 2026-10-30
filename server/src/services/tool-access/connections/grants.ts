import type { ConnectionManagementContext } from "../../connection-management.js";
import { connectionActorUserId } from "../actor.js";
import { toConnectionGrant } from "./projection.js";
import { actorBinding } from "../actor.js";
import { vercelConnectResourcesFor } from "../vercel-credentials.js";
import type { ActorInfo } from "../types.js";
import { oauthConfig } from "../oauth/metadata.js";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, connectionGrantMembers, connectionGrantDelegations, connectionGrants, authUsers, companyMemberships, toolAccessAuditEvents, toolConnections } from "@paperclipai/db";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../../../errors.js";
import { isPaperclipCloudConnectorStrategy } from "../../paperclip-cloud-connector.js";
import { vercelTokenRequest, type VercelConnectClient } from "../../vercel-connect.js";

import type { createConnectionCredentialValidation } from "./credential-validation.js";
type GrantDependencies = {
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
  assertSecretRefs: ReturnType<typeof createConnectionCredentialValidation>;
  vercelConnect: VercelConnectClient | null;
};

export function createConnectionGrants(db: Db, { getConnectionRow, assertSecretRefs, vercelConnect }: GrantDependencies) {
  return {
    listConnectionGrants: async (idOrUid: string, companyId?: string) => {
      const connection = await getConnectionRow(idOrUid, companyId);
      const grants = await db
        .select()
        .from(connectionGrants)
        .where(
          and(
            eq(connectionGrants.companyId, connection.companyId),
            eq(connectionGrants.connectionId, connection.id),
          ),
        )
        .orderBy(
          desc(connectionGrants.isDefault),
          desc(connectionGrants.updatedAt),
        );
      const grantIds = grants.map((grant) => grant.id);
      const [members, delegations] =
        grantIds.length === 0
          ? [[], []]
          : await Promise.all([
              db
                .select()
                .from(connectionGrantMembers)
                .where(
                  and(
                    eq(connectionGrantMembers.companyId, connection.companyId),
                    inArray(connectionGrantMembers.grantId, grantIds),
                  ),
                ),
              db
                .select()
                .from(connectionGrantDelegations)
                .where(
                  and(
                    eq(
                      connectionGrantDelegations.companyId,
                      connection.companyId,
                    ),
                    inArray(connectionGrantDelegations.grantId, grantIds),
                  ),
                ),
            ]);
      return {
        connection: { id: connection.id, uid: connection.uid },
        grants: grants.map((grant) => ({
          ...toConnectionGrant(grant),
          members: members.filter((member) => member.grantId === grant.id),
          delegations: delegations.filter(
            (delegation) => delegation.grantId === grant.id,
          ),
        })),
      };
    },
    /**
     * Company members eligible to appear in an organization grant's audience.
     * The audience editor needs display names, and the client must not have to
     * cross-reference a second endpoint to render "12 selected members".
     */
listConnectionAudienceMembers: async (companyId: string) => {
      const rows = await db
        .select({
          userId: companyMemberships.principalId,
          name: authUsers.name,
          email: authUsers.email,
        })
        .from(companyMemberships)
        .leftJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.status, "active"),
          ),
        );
      return rows
        .map((row) => ({
          userId: row.userId,
          name: row.name ?? null,
          email: row.email ?? null,
        }))
        .sort((a, b) =>
          (a.name ?? a.email ?? a.userId).localeCompare(
            b.name ?? b.email ?? b.userId,
          ),
        );
    },
    /**
     * Replace an organization grant's audience atomically (PAP-17835).
     *
     * An empty `memberUserIds` persists as zero rows, which the resolver already
     * treats as "every organization member". Replacement is delete-then-insert
     * inside one transaction so a partially-applied audience can never widen or
     * narrow access, and every member id is checked against active company
     * membership first so an audience cannot name an outsider. Existing audience
     * members are locked too: membership cleanup deliberately retains a sole
     * inactive audience row, and a concurrent empty replacement must not erase
     * that fail-closed marker after cleanup wins. Once cleanup has retained that
     * marker, callers must restore the member or replace it with an active named
     * audience before widening access to the whole company.
     */
replaceConnectionGrantMembers: async (
      idOrUid: string,
      grantId: string,
      memberUserIds: string[],
      actor?: ActorInfo,
    ) => {
      await actor?.managementContext?.reauthorize();
      const connection = await getConnectionRow(idOrUid);
      const [grant] = await db
        .select()
        .from(connectionGrants)
        .where(
          and(
            eq(connectionGrants.id, grantId),
            eq(connectionGrants.companyId, connection.companyId),
            eq(connectionGrants.connectionId, connection.id),
          ),
        )
        .limit(1);
      if (!grant) throw notFound("Connection grant not found");
      if (grant.kind !== "organization") {
        throw badRequest(
          "Only an organization identity has an audience; a personal identity belongs to its owner",
        );
      }
      const requested = [
        ...new Set(memberUserIds.map((id) => id.trim()).filter(Boolean)),
      ];
      const binding = actorBinding(actor);
      const members = await db.transaction(async (tx) => {
        // Serialize replacements before taking the current audience snapshot.
        // Otherwise a second replacement could read the old rows, wait behind
        // an in-flight replacement, and then miss locking a newly-added member.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"paperclip.connection_grant_audience:" + grant.id}, 0))`);
        const existingAudience = await tx
          .select()
          .from(connectionGrantMembers)
          .where(
            and(
              eq(connectionGrantMembers.companyId, connection.companyId),
              eq(connectionGrantMembers.grantId, grant.id),
              eq(connectionGrantMembers.subjectType, "user"),
            ),
          );
        const existingUserIds = [
          ...new Set(existingAudience.map((row) => row.subjectId)),
        ];
        const membershipUserIds = [
          ...new Set([...existingUserIds, ...requested]),
        ];
        if (membershipUserIds.length > 0) {
          // Membership suspension/archive/removal takes the same row lock before
          // sweeping grant audiences. Lock both the old and new audience so an
          // empty replacement also serializes with cleanup of its existing sole
          // member. Whichever transaction wins is then authoritative.
          const memberships = await tx
            .select({
              principalId: companyMemberships.principalId,
              status: companyMemberships.status,
            })
            .from(companyMemberships)
            .where(
              and(
                eq(companyMemberships.companyId, connection.companyId),
                eq(companyMemberships.principalType, "user"),
                inArray(companyMemberships.principalId, membershipUserIds),
              ),
            )
            .orderBy(asc(companyMemberships.id))
            .for("update");
          const active = new Set(
            memberships
              .filter((row) => row.status === "active")
              .map((row) => row.principalId),
          );
          const unknown = requested.filter((id) => !active.has(id));
          if (unknown.length > 0) {
            throw unprocessable(
              "Every audience member must be an active member of this company",
              {
                code: "audience_member_not_in_company",
                unknownUserIds: unknown,
              },
            );
          }
          const inactiveExisting = existingUserIds.filter(
            (id) => !active.has(id),
          );
          if (requested.length === 0 && inactiveExisting.length > 0) {
            throw conflict(
              "Replace inactive audience members before widening access to the whole company",
              {
                code: "audience_widening_blocked",
                inactiveUserIds: inactiveExisting,
              },
            );
          }
        }
        await tx
          .select({ id: connectionGrants.id })
          .from(connectionGrants)
          .where(
            and(
              eq(connectionGrants.id, grant.id),
              eq(connectionGrants.companyId, connection.companyId),
              eq(connectionGrants.connectionId, connection.id),
            ),
          )
          .for("update");
        const existingUserSet = new Set(existingUserIds);
        if (requested.length === existingUserSet.size && requested.every(id => existingUserSet.has(id))) return existingAudience;
        await tx
          .delete(connectionGrantMembers)
          .where(
            and(
              eq(connectionGrantMembers.companyId, connection.companyId),
              eq(connectionGrantMembers.grantId, grant.id),
            ),
          );
        const inserted =
          requested.length === 0
            ? []
            : await tx
                .insert(connectionGrantMembers)
                .values(
                  requested.map((subjectId) => ({
                    companyId: connection.companyId,
                    grantId: grant.id,
                    subjectType: "user" as const,
                    subjectId,
                  })),
                )
                .returning();
        await tx
          .update(connectionGrants)
          .set({ updatedAt: new Date() })
          .where(eq(connectionGrants.id, grant.id));
        return inserted;
      });
      await db.insert(toolAccessAuditEvents).values({
        companyId: connection.companyId,
        connectionId: connection.id,
        actorType: binding.actorType ?? "system",
        actorId: binding.actorId,
        action: "connection_grant.audience_replaced",
        outcome: "success",
        reasonCode: "audience_replaced",
        details: {
          grantId: grant.id,
          memberCount: members.length,
          memberUserIds: requested,
        },
      });
      return { ...toConnectionGrant(grant), members };
    },
    createConnectionGrantDelegation: async (
      idOrUid: string,
      grantId: string,
      agentId: string,
      ownerUserId: string,
      managementContext?: ConnectionManagementContext,
    ) => {
      await managementContext?.reauthorize();
      const connection = await getConnectionRow(idOrUid);
      if (connection.connectionPurpose === "ai") {
        throw badRequest("AI credentials use the connection's human access settings, not agent delegation");
      }
      return db.transaction(async (tx) => {
        // Membership removal/suspension takes this same row lock before sweeping
        // personal grants. Whichever operation wins is therefore authoritative:
        // removal deletes a delegation committed first, while creation that runs
        // second observes the inactive membership and fails closed.
        const [membership] = await tx
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, connection.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, ownerUserId),
              eq(companyMemberships.status, "active"),
            ),
          )
          .for("update")
          .limit(1);
        if (!membership) {
          throw forbidden(
            "Only an active company member can delegate their personal grant",
          );
        }

        const [grant] = await tx
          .select()
          .from(connectionGrants)
          .where(
            and(
              eq(connectionGrants.id, grantId),
              eq(connectionGrants.companyId, connection.companyId),
              eq(connectionGrants.connectionId, connection.id),
              eq(connectionGrants.kind, "user"),
              eq(connectionGrants.subjectUserId, ownerUserId),
              eq(connectionGrants.status, "active"),
            ),
          )
          .for("update")
          .limit(1);
        if (!grant)
          throw forbidden(
            "Only the active personal grant owner can create a delegation",
          );
        await tx.select({ id: toolConnections.id }).from(toolConnections)
          .where(eq(toolConnections.id, connection.id)).for("key share");
        const [targetAgent] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.id, agentId),
              eq(agents.companyId, connection.companyId),
            ),
          )
          .for("no key update")
          .limit(1);
        if (!targetAgent) throw notFound("Agent not found");
        const [existing] = await tx
          .select()
          .from(connectionGrantDelegations)
          .where(
            and(
              eq(connectionGrantDelegations.grantId, grant.id),
              eq(connectionGrantDelegations.agentId, agentId),
            ),
          )
          .limit(1);
        if (existing) return existing;
        const [delegation] = await tx
          .insert(connectionGrantDelegations)
          .values({
            companyId: connection.companyId,
            grantId: grant.id,
            agentId,
            createdByUserId: ownerUserId,
          })
          .returning();
        await tx.insert(toolAccessAuditEvents).values({
          companyId: connection.companyId,
          connectionId: connection.id,
          actorType: managementContext?.audit.actorType ?? "user",
          actorId: managementContext?.audit.actorId ?? ownerUserId,
          action: "connection_grant.delegated",
          outcome: "success",
          reasonCode: "delegation_created",
          details: { grantId: grant.id, delegationId: delegation!.id, agentId,
            ...(managementContext ? { responsibleUserId: managementContext.responsibleUserId, runId: managementContext.actor.runId, agentApiKeyId: managementContext.actor.keyId } : {}) },
        });
        return delegation!;
      });
    },
    revokeConnectionGrantDelegation: async (
      idOrUid: string,
      grantId: string,
      delegationId: string,
      actor?: ActorInfo,
    ) => {
      await actor?.managementContext?.reauthorize();
      const connection = await getConnectionRow(idOrUid);
      const delegation = await db.transaction(async tx => {
        const [grant] = await tx.select({ id: connectionGrants.id }).from(connectionGrants)
          .where(and(eq(connectionGrants.id, grantId), eq(connectionGrants.companyId, connection.companyId), eq(connectionGrants.connectionId, connection.id)))
          .for("update");
        if (!grant) return undefined;
        const [target] = await tx.select({ agentId: connectionGrantDelegations.agentId }).from(connectionGrantDelegations)
          .where(and(eq(connectionGrantDelegations.id, delegationId), eq(connectionGrantDelegations.companyId, connection.companyId), eq(connectionGrantDelegations.grantId, grantId)));
        if (!target) return undefined;
        await tx.select({ id: agents.id }).from(agents)
          .where(and(eq(agents.companyId, connection.companyId), eq(agents.id, target.agentId))).for("no key update");
        const [removed] = await tx
          .delete(connectionGrantDelegations)
          .where(
            and(
              eq(connectionGrantDelegations.id, delegationId),
              eq(connectionGrantDelegations.companyId, connection.companyId),
              eq(connectionGrantDelegations.grantId, grantId),
            ),
          )
          .returning();
        return removed;
      });
      if (!delegation) throw notFound("Connection grant delegation not found");
      const binding = actorBinding(actor);
      await db.insert(toolAccessAuditEvents).values({
        companyId: connection.companyId,
        connectionId: connection.id,
        actorType: binding.actorType ?? "system",
        actorId: binding.actorId,
        action: "connection_grant.delegation_revoked",
        outcome: "success",
        reasonCode: "delegation_revoked",
        details: { grantId, delegationId, agentId: delegation.agentId },
      });
      return delegation;
    },
    addConnectionInstallation: async (
      idOrUid: string,
      input: {
        providerTenant?: { name?: string; externalId?: string };
        credentialSecretRefs?: typeof connectionGrants.$inferInsert.credentialSecretRefs;
        isDefault?: boolean;
      },
      actor?: ActorInfo,
    ) => {
      await actor?.managementContext?.reauthorize();
      const connection = await getConnectionRow(idOrUid);
      await assertSecretRefs(
        connection.companyId,
        input.credentialSecretRefs ?? [],
      );
      if (input.isDefault) {
        await db
          .update(connectionGrants)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(
            and(
              eq(connectionGrants.connectionId, connection.id),
              eq(connectionGrants.kind, "organization"),
            ),
          );
      }
      const binding = actorBinding(actor);
      const [grant] = await db
        .insert(connectionGrants)
        .values({
          companyId: connection.companyId,
          connectionId: connection.id,
          kind: "organization",
          providerTenant: input.providerTenant,
          credentialSecretRefs: input.credentialSecretRefs ?? [],
          status: "active",
          isDefault: input.isDefault ?? false,
          createdByAgentId:
            binding.actorType === "agent" ? binding.actorId : null,
          createdByUserId: connectionActorUserId(actor),
        })
        .returning();
      if (!grant) throw new Error("Failed to create connection installation");
      await db.insert(toolAccessAuditEvents).values({
        companyId: connection.companyId,
        connectionId: connection.id,
        actorType: binding.actorType ?? "system",
        actorId: binding.actorId,
        action: "connection_grant.created",
        outcome: "success",
        reasonCode: "grant_created",
        details: {
          grantId: grant.id,
          kind: grant.kind,
          isDefault: grant.isDefault,
        },
      });
      return toConnectionGrant(grant);
    },
    revokeConnectionGrant: async (
      idOrUid: string,
      grantId: string,
      actor?: ActorInfo,
    ) => {
      await actor?.managementContext?.reauthorize();
      const connection = await getConnectionRow(idOrUid);
      const binding = actorBinding(actor);
      const [currentGrant] = await db
        .select()
        .from(connectionGrants)
        .where(
          and(
            eq(connectionGrants.id, grantId),
            eq(connectionGrants.companyId, connection.companyId),
            eq(connectionGrants.connectionId, connection.id),
          ),
        )
        .limit(1);
      if (!currentGrant) throw notFound("Connection grant not found");
      let providerRevocation = "not_applicable";
      if (
        connection.credentialSource === "vercel_connect" &&
        connection.externalCredential
      ) {
        const request = vercelTokenRequest({
          credential: connection.externalCredential,
          grant: currentGrant,
          connectionId: connection.id,
          companyId: connection.companyId,
          resources: vercelConnectResourcesFor(connection),
        });
        vercelConnect?.evict(request);
        if (currentGrant.externalCredential?.subjectType === "app") {
          providerRevocation = "manage_in_vercel";
        } else if (currentGrant.externalCredential?.subjectType === "user") {
          try {
            if (!vercelConnect) throw new Error("Vercel Connect unavailable");
            await vercelConnect.revoke(request);
            providerRevocation = "success";
          } catch {
            providerRevocation = "failed";
          }
        }
      } else if (
        isPaperclipCloudConnectorStrategy(oauthConfig(connection).strategy)
      ) {
        // Google revocation is client-wide for a user. The managed Workspace
        // profiles intentionally share one Paperclip-owned client, so revoking
        // one token here could invalidate unrelated Gmail, Drive, and Calendar
        // grants. A per-profile removal is therefore local-only. A future
        // provider-level disconnect must warn that it removes every profile.
        providerRevocation = "local_only_shared_client";
      }
      const grant = await db.transaction(async (tx) => {
        const [lockedGrant] = await tx.select({ id: connectionGrants.id }).from(connectionGrants)
          .where(and(eq(connectionGrants.id, grantId), eq(connectionGrants.companyId, connection.companyId), eq(connectionGrants.connectionId, connection.id)))
          .for("update");
        if (!lockedGrant) throw notFound("Connection grant not found");
        await tx.select({ id: agents.id }).from(agents)
          .where(and(eq(agents.companyId, connection.companyId), notInArray(agents.status, ["pending_approval", "terminated"])))
          .orderBy(agents.id).for("no key update");
        const removedDelegations = await tx
          .delete(connectionGrantDelegations)
          .where(
            and(
              eq(connectionGrantDelegations.companyId, connection.companyId),
              eq(connectionGrantDelegations.grantId, grantId),
            ),
          )
          .returning();
        const [updated] = await tx
          .update(connectionGrants)
          .set({
            status: "revoked",
            isDefault: false,
            revokedAt: new Date(),
            revokedByAgentId:
              binding.actorType === "agent" ? binding.actorId : null,
            revokedByUserId:
              binding.actorType === "user" ? binding.actorId : null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(connectionGrants.id, grantId),
              eq(connectionGrants.companyId, connection.companyId),
              eq(connectionGrants.connectionId, connection.id),
            ),
          )
          .returning();
        if (!updated) throw notFound("Connection grant not found");
        if (removedDelegations.length > 0) {
          await tx.insert(toolAccessAuditEvents).values(
            removedDelegations.map((delegation) => ({
              companyId: connection.companyId,
              connectionId: connection.id,
              actorType: binding.actorType ?? "system",
              actorId: binding.actorId,
              action: "connection_grant.delegation_revoked",
              outcome: "success",
              reasonCode: "grant_revoked",
              details: {
                grantId,
                delegationId: delegation.id,
                agentId: delegation.agentId,
              },
            })),
          );
        }
        return updated;
      });
      if (!grant) throw notFound("Connection grant not found");
      await db.insert(toolAccessAuditEvents).values({
        companyId: connection.companyId,
        connectionId: connection.id,
        actorType: binding.actorType ?? "system",
        actorId: binding.actorId,
        action: "connection_grant.revoked",
        outcome: "success",
        reasonCode: "grant_revoked",
        details: { grantId: grant.id, kind: grant.kind, providerRevocation },
      });
      return toConnectionGrant(grant);
    }
  };
}
