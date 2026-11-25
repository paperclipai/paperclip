import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  connectionGrants,
  issueThreadInteractions,
  toolActionRequests,
  toolCallEvents,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolInvocations,
  type Db,
} from "@paperclipai/db";
import { GOOGLE_WORKSPACE_APP_SLUGS, GOOGLE_WORKSPACE_CONNECTOR_PROFILES } from "@paperclipai/shared";
import { toolSourceTemplateKeySql } from "../source-template-key.js";
import type { IdleDeadlineSnapshot } from "../../idle-deadline-types.js";

export const GOOGLE_TECHNICAL_INFORMATION_TTL_MS = 30 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const BATCH_SIZE = 500;
const CATALOG_CONNECTION_BATCH = 50;

type Reader = Pick<Db, "select">;

function textArray(values: readonly string[]): SQL {
  return sql`array[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

export function googleConnectionIdsSql(): SQL {
  return sql`(select ${toolConnections.id} from ${toolConnections}
    join ${toolApplications} on ${toolApplications.id} = ${toolConnections.applicationId} and ${toolApplications.companyId} = ${toolConnections.companyId}
    where ${toolSourceTemplateKeySql} = any(${textArray(GOOGLE_WORKSPACE_APP_SLUGS)})
      or ${toolConnections.config}->'oauth'->>'connectorProfile' = any(${textArray(Object.keys(GOOGLE_WORKSPACE_CONNECTOR_PROFILES))}))`;
}

const googleConnectionIds = googleConnectionIdsSql;

const catalogNotStrippedSql = sql`(${toolCatalogEntries.description} is not null or ${toolCatalogEntries.title} is not null
  or ${toolCatalogEntries.inputSchema} <> '{}'::jsonb or ${toolCatalogEntries.outputSchema} is not null
  or ${toolCatalogEntries.annotations} <> '{}'::jsonb or ${toolCatalogEntries.uiMeta} is not null or ${toolCatalogEntries.icons} is not null)`;

const healthTextSql = sql`(${toolConnections.healthMessage} is not null or ${toolConnections.lastError} is not null)`;

function cutoffAt(now: Date) {
  return new Date(now.getTime() - GOOGLE_TECHNICAL_INFORMATION_TTL_MS).toISOString();
}

function toTime(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const at = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(at) ? at : null;
}

export async function nextGoogleTechnicalInformationDeadline(db: Reader, now = Date.now()): Promise<number | null> {
  const ttl = GOOGLE_TECHNICAL_INFORMATION_TTL_MS;
  const google = googleConnectionIds();
  const unstripped = sql`(e.description is not null or e.title is not null or e.input_schema <> '{}'::jsonb or e.output_schema is not null
    or e.annotations <> '{}'::jsonb or e.ui_meta is not null or e.icons is not null)`;
  const [row] = await db.select({
    found: sql<number>`count(*)::int`,
    active: sql<number>`count(*) filter (where ${toolConnections.status} <> 'archived')::int`,
    healthArchived: sql<number>`count(*) filter (where ${toolConnections.status} = 'archived' and ${healthTextSql})::int`,
    healthAt: sql<string | null>`min(coalesce(${toolConnections.healthCheckedAt}, ${toolConnections.updatedAt})) filter (where ${healthTextSql})`,
    invocationAt: sql<string | null>`(select min(i.created_at) from tool_invocations i where i.connection_id in ${google} and i.error_message is not null)`,
    eventAt: sql<string | null>`(select min(ev.created_at) from tool_call_events ev where ev.connection_id in ${google} and ev.error_message is not null)`,
    catalogArchived: sql<number>`(select count(*) from tool_catalog_entries e join tool_connections c on c.id = e.connection_id
      where c.status = 'archived' and c.id in ${google} and ${unstripped})::int`,
    catalogAt: sql<string | null>`(select min(e.last_seen_at) from tool_catalog_entries e where e.connection_id in ${google} and ${unstripped})`,
    grants: sql<number>`(select count(*) from connection_grants g
      where g.status = 'revoked' and g.provider_tenant ? 'oauth' and g.connection_id in ${google})::int`,
  }).from(toolConnections).where(sql`${toolConnections.id} in ${google}`);
  if (!row?.found) return null;
  if (row.healthArchived || row.catalogArchived || row.grants) return now;
  const candidates = [row.invocationAt, row.eventAt, row.healthAt, row.catalogAt]
    .map(toTime)
    .flatMap((at) => at === null ? [] : [at + ttl]);
  if (row.active > 0) candidates.push(Math.floor(now / DAY_MS) * DAY_MS + ttl);
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

export async function readIdleGoogleTechnicalInformationSchedule(db: Reader, now: number): Promise<IdleDeadlineSnapshot> {
  const at = await nextGoogleTechnicalInformationDeadline(db, now);
  return { blocked: false, state: [at], deadlines: at === null ? [] : [at] };
}

export function createGoogleTechnicalInformationRetention(db: Db) {
  async function clearInvocationErrors(cutoff: string) {
    return db.transaction(async (rawTx) => clearInvocationErrorsIn(rawTx as unknown as Db, cutoff));
  }

  async function clearInvocationErrorsIn(db: Db, cutoff: string) {
    const cleared = await db.update(toolInvocations).set({ errorMessage: null })
      .where(sql`${toolInvocations.id} in (select i.id from tool_invocations i
        where i.connection_id in ${googleConnectionIds()} and i.error_message is not null and i.created_at <= ${cutoff}::timestamptz
        limit ${BATCH_SIZE})`)
      .returning({ id: toolInvocations.id });
    if (cleared.length > 0) {
      const ids = cleared.map((row) => row.id);
      await db.update(issueThreadInteractions)
        .set({ result: sql`jsonb_set(${issueThreadInteractions.result}, '{toolAction,errorMessage}', 'null'::jsonb)` as never })
        .where(and(
          sql`${issueThreadInteractions.id} in (select ${toolActionRequests.interactionId} from ${toolActionRequests}
            where ${inArray(toolActionRequests.invocationId, ids)})`,
          sql`${issueThreadInteractions.result}->'toolAction'->>'errorMessage' is not null`,
        ));
    }
    return cleared.length;
  }

  async function clearEventErrors(cutoff: string) {
    const cleared = await db.update(toolCallEvents).set({ errorMessage: null })
      .where(sql`${toolCallEvents.id} in (select e.id from tool_call_events e
        where e.connection_id in ${googleConnectionIds()} and e.error_message is not null and e.created_at <= ${cutoff}::timestamptz
        limit ${BATCH_SIZE})`)
      .returning({ id: toolCallEvents.id });
    return cleared.length;
  }

  async function clearHealthText(cutoff: string) {
    await db.update(toolConnections).set({ healthMessage: null, lastError: null })
      .where(and(
        sql`${toolConnections.id} in ${googleConnectionIds()}`,
        healthTextSql,
        sql`(${toolConnections.status} = 'archived'
          or coalesce(${toolConnections.healthCheckedAt}, ${toolConnections.updatedAt}) <= ${cutoff}::timestamptz)`,
      ));
  }

  async function stripCatalog(cutoff: string) {
    const due = await db.selectDistinct({ connectionId: toolCatalogEntries.connectionId }).from(toolCatalogEntries)
      .innerJoin(toolConnections, eq(toolConnections.id, toolCatalogEntries.connectionId))
      .where(and(
        sql`${toolConnections.id} in ${googleConnectionIds()}`,
        catalogNotStrippedSql,
        sql`(${toolConnections.status} = 'archived' or ${toolCatalogEntries.lastSeenAt} <= ${cutoff}::timestamptz)`,
      ))
      .limit(CATALOG_CONNECTION_BATCH);
    for (const { connectionId } of due) {
      await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const stripped = await tx.update(toolCatalogEntries)
          .set({ title: null, description: null, inputSchema: {}, outputSchema: null, annotations: {}, uiMeta: null, icons: null })
          .where(and(
            eq(toolCatalogEntries.connectionId, connectionId),
            catalogNotStrippedSql,
            sql`(${toolCatalogEntries.lastSeenAt} <= ${cutoff}::timestamptz
              or exists (select 1 from tool_connections c where c.id = ${connectionId} and c.status = 'archived'))`,
          ))
          .returning({ id: toolCatalogEntries.id });
        if (stripped.length === 0) return;
        await tx.update(toolConnections).set({ lastCatalogRefreshAt: null })
          .where(and(eq(toolConnections.id, connectionId), sql`${toolConnections.status} <> 'archived'`));
      });
    }
    return due.length;
  }

  async function stripRevokedGrantEvidence() {
    await db.update(connectionGrants)
      .set({ providerTenant: sql`${connectionGrants.providerTenant} - 'oauth'` as never })
      .where(sql`${connectionGrants.status} = 'revoked' and ${connectionGrants.providerTenant} ? 'oauth'
        and ${connectionGrants.connectionId} in ${googleConnectionIds()}`);
  }

  async function sweep(signal: AbortSignal, now = new Date()) {
    const cutoff = cutoffAt(now);
    for (const step of [clearInvocationErrors, clearEventErrors]) {
      let cleared = BATCH_SIZE;
      while (cleared === BATCH_SIZE && !signal.aborted) cleared = await step(cutoff);
    }
    let catalogs = CATALOG_CONNECTION_BATCH;
    while (catalogs === CATALOG_CONNECTION_BATCH && !signal.aborted) catalogs = await stripCatalog(cutoff);
    if (signal.aborted) return;
    await clearHealthText(cutoff);
    await stripRevokedGrantEvidence();
  }

  return { sweep, nextDeadline: (now?: number) => nextGoogleTechnicalInformationDeadline(db, now) };
}
