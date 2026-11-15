import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
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

function revisionColumns(columns: Record<string, AnyPgColumn>) {
  return Object.fromEntries(Object.entries(columns).map(([name, column]) => [
    name,
    column.dataType === "date" ? sql`extract(epoch from ${column})`.as(name) : column,
  ]));
}

/** Only authorization fields participate: receiving messages must not reset sessions. */
export async function slackAuthorizationRevision(
  db: Db,
  companyId: string,
  endpointId: string,
  connectionId: string,
  agentId: string,
  userId: string,
) {
  const queries = [
    db
      .select(revisionColumns({
        id: chatEndpointResources.id,
        available: chatEndpointResources.availability,
        enabled: chatEndpointResources.enabled,
      }))
      .from(chatEndpointResources)
      .where(
        and(
          eq(chatEndpointResources.companyId, companyId),
          eq(chatEndpointResources.endpointId, endpointId),
        ),
      )
      .orderBy(chatEndpointResources.id),
    db
      .select(revisionColumns({
        id: chatIdentityLinks.id,
        status: chatIdentityLinks.status,
        user: chatIdentityLinks.paperclipUserId,
        updatedAt: chatIdentityLinks.updatedAt,
      }))
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
      .select(revisionColumns({
        id: connectionGrants.id,
        status: connectionGrants.status,
        updatedAt: connectionGrants.updatedAt,
      }))
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
      .select(revisionColumns({
        id: toolCatalogEntries.id,
        hash: toolCatalogEntries.versionHash,
        status: toolCatalogEntries.status,
        quarantine: toolCatalogEntries.quarantinedAt,
      }))
      .from(toolCatalogEntries)
      .where(
        and(
          eq(toolCatalogEntries.companyId, companyId),
          eq(toolCatalogEntries.connectionId, connectionId),
        ),
      )
      .orderBy(toolCatalogEntries.id),
    db
      .select(revisionColumns(getTableColumns(toolPolicies)))
      .from(toolPolicies)
      .where(eq(toolPolicies.companyId, companyId))
      .orderBy(toolPolicies.id),
    db
      .select(revisionColumns(getTableColumns(toolProfiles)))
      .from(toolProfiles)
      .where(eq(toolProfiles.companyId, companyId))
      .orderBy(toolProfiles.id),
    db
      .select(revisionColumns(getTableColumns(toolProfileEntries)))
      .from(toolProfileEntries)
      .where(eq(toolProfileEntries.companyId, companyId))
      .orderBy(toolProfileEntries.id),
    db
      .select(revisionColumns(getTableColumns(toolProfileBindings)))
      .from(toolProfileBindings)
      .where(
        and(
          eq(toolProfileBindings.companyId, companyId),
          eq(toolProfileBindings.targetId, agentId),
        ),
      )
      .orderBy(toolProfileBindings.id),
  ];
  const digests = queries.map(query => sql`(
    select encode(sha256(convert_to(coalesce(string_agg(
      encode(sha256(convert_to(row_to_json(revision_row)::text, 'UTF8')), 'hex'),
      '' order by revision_row.id
    ), ''), 'UTF8')), 'hex')
    from (${query.getSQL()}) as revision_row
  )`);
  const [result] = await db.select({
    revision: sql<string>`encode(sha256(convert_to(
      concat(${sql.join(digests, sql`, `)}), 'UTF8'
    )), 'hex')`,
  }).from(sql`(values (1)) as revision_scope(value)`);
  return result!.revision;
}
