import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  chatEndpointResources,
  chatIdentityLinks,
  connectionGrants,
  toolCatalogEntries,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  type Db,
} from "@paperclipai/db";

/** Only authorization fields participate: receiving messages must not reset sessions. */
export async function slackAuthorizationRevision(
  db: Db,
  companyId: string,
  endpointId: string,
  connectionId: string,
  agentId: string,
  userId: string,
) {
  const values = await Promise.all([
    db
      .select({
        id: chatEndpointResources.id,
        available: chatEndpointResources.availability,
        enabled: chatEndpointResources.enabled,
      })
      .from(chatEndpointResources)
      .where(
        and(
          eq(chatEndpointResources.companyId, companyId),
          eq(chatEndpointResources.endpointId, endpointId),
        ),
      )
      .orderBy(chatEndpointResources.id),
    db
      .select({
        id: chatIdentityLinks.id,
        status: chatIdentityLinks.status,
        user: chatIdentityLinks.paperclipUserId,
        updatedAt: chatIdentityLinks.updatedAt,
      })
      .from(chatIdentityLinks)
      .where(
        and(
          eq(chatIdentityLinks.companyId, companyId),
          eq(chatIdentityLinks.endpointId, endpointId),
          eq(chatIdentityLinks.paperclipUserId, userId),
        ),
      )
      .orderBy(chatIdentityLinks.id),
    db
      .select({
        id: connectionGrants.id,
        status: connectionGrants.status,
        updatedAt: connectionGrants.updatedAt,
      })
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.companyId, companyId),
          eq(connectionGrants.connectionId, connectionId),
          eq(connectionGrants.subjectUserId, userId),
        ),
      )
      .orderBy(connectionGrants.id),
    db
      .select({
        id: toolCatalogEntries.id,
        hash: toolCatalogEntries.versionHash,
        status: toolCatalogEntries.status,
        quarantine: toolCatalogEntries.quarantinedAt,
      })
      .from(toolCatalogEntries)
      .where(
        and(
          eq(toolCatalogEntries.companyId, companyId),
          eq(toolCatalogEntries.connectionId, connectionId),
        ),
      )
      .orderBy(toolCatalogEntries.id),
    db
      .select()
      .from(toolPolicies)
      .where(eq(toolPolicies.companyId, companyId))
      .orderBy(toolPolicies.id),
    db
      .select()
      .from(toolProfiles)
      .where(eq(toolProfiles.companyId, companyId))
      .orderBy(toolProfiles.id),
    db
      .select()
      .from(toolProfileEntries)
      .where(eq(toolProfileEntries.companyId, companyId))
      .orderBy(toolProfileEntries.id),
    db
      .select()
      .from(toolProfileBindings)
      .where(
        and(
          eq(toolProfileBindings.companyId, companyId),
          eq(toolProfileBindings.targetId, agentId),
        ),
      )
      .orderBy(toolProfileBindings.id),
  ]);
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
