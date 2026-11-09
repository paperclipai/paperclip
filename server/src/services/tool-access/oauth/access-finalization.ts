import type { ActorInfo } from "../types.js";
import { connectionMethodForConnection } from "../connection-methods.js";
import { emitConnectionUpdated } from "../../connector-telemetry.js";
import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrantMembers, connectionGrantDelegations, connectionGrants, companySecrets, toolApplications, toolCatalogEntries, toolConnectionInstalls, toolConnections } from "@paperclipai/db";
import type { FinishToolAppResult, FinalizeOAuthAccess, ToolCredentialSecretRef } from "@paperclipai/shared";
import { getConnectableAppDefinition, recommendedDefaultsForApp } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, unprocessable } from "../../../errors.js";
import { secretService } from "../../secrets.js";

import type { OAuthCredentialStore } from "./credential-store.js";

import type { FinishConnectionSetup } from "../catalog/contracts.js";

type Dependencies = {
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
  secrets: ReturnType<typeof secretService>;
  store: Pick<OAuthCredentialStore, "createOrRotateOAuthSecret" | "syncCredentialBindings">;
  assertAgentsInCompany(companyId: string, agentIds: string[]): Promise<void>;
  finishGalleryAppConnection: FinishConnectionSetup;
};

export function createOAuthAccessFinalization(db: Db, dependencies: Dependencies) {
  const { getConnectionRow, secrets, store, assertAgentsInCompany, finishGalleryAppConnection } = dependencies;
  const { createOrRotateOAuthSecret, syncCredentialBindings } = store;
  /**
   * Finish the one decision that cannot safely be guessed for a browser OAuth
   * connection: whether the consenting identity stays personal or becomes the
   * company's shared identity. The provider callback always writes a fresh
   * token to the consenting user's grant first. Only this explicit endpoint may
   * promote it to company-scoped secrets.
   */
async function finalizeOAuthAccess(
    companyId: string,
    connectionId: string,
    input: FinalizeOAuthAccess,
    actor?: ActorInfo,
    requestingAgentId?: string,
  ): Promise<FinishToolAppResult> {
    if (requestingAgentId)
      await assertAgentsInCompany(companyId, [requestingAgentId]);
    let connection = await getConnectionRow(connectionId, companyId);
    const preFinalizeLifecycle = {
      status: connection.status,
      enabled: connection.enabled,
    };
    if (connection.authKind !== "oauth")
      throw badRequest("This connection does not use browser sign-in");
    if (connection.status === "archived")
      throw conflict("Archived app connections cannot be finished");
    const actorUserId = actor?.actorType === "user" ? actor.actorId : null;
    if (!actorUserId)
      throw badRequest("Finishing browser sign-in requires a signed-in user");

    const [personalGrant] = await db
      .select()
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.companyId, companyId),
          eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.kind, "user"),
          eq(connectionGrants.subjectUserId, actorUserId),
        ),
      )
      .limit(1);

    if (connection.credentialSource === "vercel_connect") {
      const [organizationGrant] = await db
        .select()
        .from(connectionGrants)
        .where(
          and(
            eq(connectionGrants.companyId, companyId),
            eq(connectionGrants.connectionId, connection.id),
            eq(connectionGrants.kind, "organization"),
            eq(connectionGrants.isDefault, true),
          ),
        )
        .limit(1);
      const selectedGrant =
        input.grantKind === "user" ? personalGrant : organizationGrant;
      if (
        !selectedGrant ||
        selectedGrant.status !== "active" ||
        !selectedGrant.externalCredential
      ) {
        throw conflict(
          "The selected Vercel Connect identity is missing. Authorize this connection again.",
        );
      }
      const expectedPolicy = input.grantKind === "user" ? "per_user" : "shared";
      if (connection.credentialPolicy !== expectedPolicy) {
        throw conflict(
          "Vercel Connect identity scope is fixed when the connector is attached. Create a new connection to change it.",
        );
      }
    } else if (input.grantKind === "user") {
      if (
        !personalGrant ||
        personalGrant.status !== "active" ||
        personalGrant.credentialSecretRefs.length === 0
      ) {
        throw conflict(
          "Your connected identity is missing. Connect this app again before choosing Just me.",
        );
      }
      if (
        connection.credentialPolicy === "shared" &&
        connection.credentialSecretRefs.length > 0
      ) {
        throw conflict("This connection already uses a company identity");
      }
      [connection] = await db
        .update(toolConnections)
        .set({
          credentialPolicy: "per_user",
          credentialRefs: connection.credentialRefs.filter(
            (ref) => ref.name !== "oauth.access_token",
          ),
          credentialSecretRefs: connection.credentialSecretRefs.filter(
            (ref) =>
              ref.configPath !== "oauth.access_token" &&
              ref.configPath !== "oauth.refresh_token",
          ),
          status: "active",
          enabled: true,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(toolConnections.id, connection.id),
            eq(toolConnections.companyId, companyId),
          ),
        )
        .returning();
      await syncCredentialBindings(
        connection,
        personalGrant.credentialSecretRefs,
      );
    } else if (
      connection.credentialPolicy !== "shared" ||
      connection.credentialSecretRefs.length === 0
    ) {
      if (
        !personalGrant ||
        personalGrant.status !== "active" ||
        personalGrant.credentialSecretRefs.length === 0
      ) {
        throw conflict(
          "Your connected identity is missing. Connect this app again before sharing it.",
        );
      }

      const personalSecretIds = personalGrant.credentialSecretRefs.map(
        (ref) => ref.secretId,
      );
      const personalSecretRows = await db
        .select({
          id: companySecrets.id,
          scope: companySecrets.scope,
          ownerUserId: companySecrets.ownerUserId,
          userSecretDefinitionId: companySecrets.userSecretDefinitionId,
        })
        .from(companySecrets)
        .where(
          and(
            eq(companySecrets.companyId, companyId),
            inArray(companySecrets.id, personalSecretIds),
          ),
        );
      const personalSecretById = new Map(
        personalSecretRows.map((row) => [row.id, row]),
      );
      const promotedRefs: ToolCredentialSecretRef[] = [];
      try {
        for (const ref of personalGrant.credentialSecretRefs) {
          const secretRow = personalSecretById.get(ref.secretId);
          if (
            !secretRow ||
            secretRow.scope !== "user" ||
            secretRow.ownerUserId !== actorUserId ||
            !secretRow.userSecretDefinitionId
          ) {
            throw forbidden(
              "Only your own connected identity can be shared with the company",
            );
          }
          if (
            ref.configPath !== "oauth.access_token" &&
            ref.configPath !== "oauth.refresh_token" &&
            ref.configPath !== "oauth.client_secret"
          ) {
            throw badRequest(
              "The connected identity contains an unsupported OAuth credential",
            );
          }
          const resolved = await secrets.resolveUserSecretValue(
            companyId,
            {
              definitionId: secretRow.userSecretDefinitionId,
              responsibleUserId: actorUserId,
              version: ref.versionSelector ?? "latest",
            },
            {
              consumerType: "tool_connection",
              consumerId: connection.id,
              responsibleUserId: actorUserId,
              actorType: "user",
              actorId: actorUserId,
            },
          );
          if (!resolved)
            throw unprocessable("The connected identity could not be read");
          const promoted = await createOrRotateOAuthSecret({
            companyId,
            connection,
            configPath: ref.configPath,
            label: ref.label ?? "OAuth credential",
            value: resolved.value,
            actor,
            existingRefs: promotedRefs,
          });
          promotedRefs.push({ ...ref, ...promoted });
        }

        const accessRef = promotedRefs.find(
          (ref) => ref.configPath === "oauth.access_token",
        );
        if (!accessRef)
          throw unprocessable(
            "The connected identity is missing its OAuth access token",
          );
        const connectionCredentialSecretRefs = [
          ...connection.credentialSecretRefs.filter(
            (ref) =>
              ref.configPath !== "oauth.access_token" &&
              ref.configPath !== "oauth.refresh_token",
          ),
          ...promotedRefs,
        ];
        const nowAt = new Date();
        await db.transaction(async (tx) => {
          await tx.select({ id: connectionGrants.id }).from(connectionGrants)
            .where(and(eq(connectionGrants.companyId, companyId), eq(connectionGrants.connectionId, connection.id),
              or(eq(connectionGrants.id, personalGrant.id), and(eq(connectionGrants.kind, "organization"), eq(connectionGrants.isDefault, true)))))
            .orderBy(connectionGrants.id).for("update");
          await tx.select({ id: toolApplications.id }).from(toolApplications)
            .where(and(eq(toolApplications.id, connection.applicationId), eq(toolApplications.companyId, companyId)))
            .for("update");
          await tx.select({ id: toolConnections.id }).from(toolConnections)
            .where(and(eq(toolConnections.id, connection.id), eq(toolConnections.companyId, companyId)))
            .for("update");
          const [existingOrganizationGrant] = await tx
            .select()
            .from(connectionGrants)
            .where(
              and(
                eq(connectionGrants.companyId, companyId),
                eq(connectionGrants.connectionId, connection.id),
                eq(connectionGrants.kind, "organization"),
                eq(connectionGrants.isDefault, true),
              ),
            )
            .limit(1);
          let organizationGrantId: string;
          if (existingOrganizationGrant) {
            organizationGrantId = existingOrganizationGrant.id;
            await tx
              .update(connectionGrants)
              .set({
                providerTenant: personalGrant.providerTenant,
                credentialSecretRefs: connectionCredentialSecretRefs,
                status: "active",
                revokedAt: null,
                revokedByAgentId: null,
                revokedByUserId: null,
                updatedAt: nowAt,
              })
              .where(eq(connectionGrants.id, existingOrganizationGrant.id));
          } else {
            const [createdOrganizationGrant] = await tx
              .insert(connectionGrants)
              .values({
                companyId,
                connectionId: connection.id,
                kind: "organization",
                subjectUserId: null,
                providerTenant: personalGrant.providerTenant,
                credentialSecretRefs: connectionCredentialSecretRefs,
                status: "active",
                isDefault: true,
                createdByUserId: actorUserId,
              })
              .returning({ id: connectionGrants.id });
            organizationGrantId = createdOrganizationGrant.id;
          }
          // Empty audience rows are the canonical "everyone in the company".
          await tx
            .delete(connectionGrantMembers)
            .where(
              and(
                eq(connectionGrantMembers.companyId, companyId),
                eq(connectionGrantMembers.grantId, organizationGrantId),
              ),
            );
          await tx
            .delete(connectionGrantDelegations)
            .where(
              and(
                eq(connectionGrantDelegations.companyId, companyId),
                eq(connectionGrantDelegations.grantId, personalGrant.id),
              ),
            );
          await tx
            .update(connectionGrants)
            .set({
              credentialSecretRefs: [],
              status: "revoked",
              revokedAt: nowAt,
              revokedByUserId: actorUserId,
              updatedAt: nowAt,
            })
            .where(eq(connectionGrants.id, personalGrant.id));
          [connection] = await tx
            .update(toolConnections)
            .set({
              credentialPolicy: "shared",
              credentialSecretRefs: connectionCredentialSecretRefs,
              credentialRefs: [
                {
                  name: "oauth.access_token",
                  secretId: accessRef.secretId,
                  version: "latest",
                  placement: "header",
                  key: "Authorization",
                  prefix: "Bearer ",
                },
              ],
              status: "active",
              enabled: true,
              updatedAt: nowAt,
            })
            .where(
              and(
                eq(toolConnections.id, connection.id),
                eq(toolConnections.companyId, companyId),
              ),
            )
            .returning();
        });
      } catch (error) {
        await Promise.all(
          promotedRefs.map((ref) =>
            secrets.remove(ref.secretId).catch(() => undefined),
          ),
        );
        throw error;
      }
      await syncCredentialBindings(connection);
      // The source values are no longer referenced by either grant or
      // connection. Removing them makes the promotion a move, not a copy.
      for (const secretId of personalSecretIds) await secrets.remove(secretId);
    }

    // Both identity branches above commit their own lifecycle write (draft ->
    // active) before `finishGalleryAppConnection` re-reads the row, so that
    // step alone would never observe this transition. This is the OAuth
    // access-finalization step of the same gallery setup flow (Apps and inline
    // task cards both reach it), hence `gallery`.
    emitConnectionUpdated(connection, preFinalizeLifecycle, "gallery");
    const catalog = await db
      .select()
      .from(toolCatalogEntries)
      .where(
        and(
          eq(toolCatalogEntries.companyId, companyId),
          eq(toolCatalogEntries.connectionId, connection.id),
          eq(toolCatalogEntries.status, "active"),
        ),
      );
    const sourceTemplateKey =
      typeof connection.config.sourceTemplateKey === "string"
        ? connection.config.sourceTemplateKey
        : null;
    const galleryEntry = sourceTemplateKey
      ? getConnectableAppDefinition(sourceTemplateKey)
      : null;
    const defaults = galleryEntry
      ? recommendedDefaultsForApp(
          galleryEntry,
          connectionMethodForConnection(galleryEntry, connection).key,
        )
      : { askFirstRiskLevels: [] };
    const askFirstRiskLevels = new Set(
      Array.isArray(defaults.askFirstRiskLevels)
        ? defaults.askFirstRiskLevels.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    );
    const finished = await finishGalleryAppConnection(
      companyId,
      connection.id,
      {
        enabledCatalogEntryIds: catalog.map((entry) => entry.id),
        askFirstCatalogEntryIds: catalog
          .filter((entry) => askFirstRiskLevels.has(entry.riskLevel))
          .map((entry) => entry.id),
        access: requestingAgentId
          ? { agentIds: [requestingAgentId] }
          : "all_agents",
        preserveExistingAccess: Boolean(requestingAgentId),
      },
      actor,
    );
    await db
      .insert(toolConnectionInstalls)
      .values({
        companyId,
        connectionId: connection.id,
        targetType: requestingAgentId ? "agent" : "company",
        targetId: requestingAgentId ?? companyId,
        createdByUserId: actorUserId,
      })
      .onConflictDoNothing();
    return finished;
  }
  return finalizeOAuthAccess;
}
