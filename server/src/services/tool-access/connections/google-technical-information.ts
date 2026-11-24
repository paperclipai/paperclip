import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  connectionGrants,
  issueThreadInteractions,
  toolActionRequests,
  toolCallEvents,
  toolCatalogEntries,
  toolConnections,
  toolInvocations,
  type Db,
} from "@paperclipai/db";
import { GOOGLE_WORKSPACE_APP_SLUGS, GOOGLE_WORKSPACE_CONNECTOR_PROFILES } from "@paperclipai/shared";
import type { IdleDeadlineSnapshot } from "../../idle-deadline-types.js";

export const GOOGLE_TECHNICAL_INFORMATION_TTL_MS = 30 * 24 * 60 * 60_000;
const BATCH_SIZE = 500;

type Reader = Pick<Db, "select">;

function textArray(values: readonly string[]): SQL {
  return sql`array[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

export function googleConnectionIdsSql(): SQL {
  return sql`(select gc.id from tool_connections gc
    join tool_applications ga on ga.id = gc.application_id and ga.company_id = gc.company_id
    where coalesce(gc.config->>'sourceTemplateKey', gc.transport_config->>'sourceTemplateKey',
        ga.metadata->>'sourceTemplateKey', ga.metadata->>'source') = any(${textArray(GOOGLE_WORKSPACE_APP_SLUGS)})
      or gc.config->'oauth'->>'connectorProfile' = any(${textArray(Object.keys(GOOGLE_WORKSPACE_CONNECTOR_PROFILES))}))`;
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
  const [google] = await db.select({ found: sql<number>`count(*)::int` }).from(toolConnections)
    .where(sql`${toolConnections.id} in ${googleConnectionIds()}`);
  if (!google?.found) return null;
  const [invocationError] = await db.select({ at: sql<string | null>`min(${toolInvocations.createdAt})` }).from(toolInvocations)
    .where(sql`${toolInvocations.connectionId} in ${googleConnectionIds()} and ${toolInvocations.errorMessage} is not null`);
  const [eventError] = await db.select({ at: sql<string | null>`min(${toolCallEvents.createdAt})` }).from(toolCallEvents)
    .where(sql`${toolCallEvents.connectionId} in ${googleConnectionIds()} and ${toolCallEvents.errorMessage} is not null`);
  const [health] = await db.select({
    archived: sql<number>`count(*) filter (where ${toolConnections.status} = 'archived')::int`,
    at: sql<string | null>`min(coalesce(${toolConnections.healthCheckedAt}, ${toolConnections.updatedAt}))`,
  }).from(toolConnections).where(and(sql`${toolConnections.id} in ${googleConnectionIds()}`, healthTextSql));
  const [catalog] = await db.select({
    archived: sql<number>`count(*) filter (where ${toolConnections.status} = 'archived')::int`,
    at: sql<string | null>`min(${toolCatalogEntries.lastSeenAt})`,
  }).from(toolCatalogEntries)
    .innerJoin(toolConnections, eq(toolConnections.id, toolCatalogEntries.connectionId))
    .where(and(sql`${toolConnections.id} in ${googleConnectionIds()}`, catalogNotStrippedSql));
  const [grants] = await db.select({ found: sql<number>`count(*)::int` }).from(connectionGrants)
    .where(sql`${connectionGrants.status} = 'revoked' and ${connectionGrants.providerTenant} ? 'oauth'
      and ${connectionGrants.connectionId} in ${googleConnectionIds()}`);
  if (health?.archived || catalog?.archived || grants?.found) return now;
  const candidates = [invocationError?.at, eventError?.at, health?.at, catalog?.at]
    .map(toTime)
    .flatMap((at) => at === null ? [] : [at + ttl]);
  return Math.min(now + ttl, ...candidates);
}

export async function readIdleGoogleTechnicalInformationSchedule(db: Reader, now: number): Promise<IdleDeadlineSnapshot> {
  const at = await nextGoogleTechnicalInformationDeadline(db, now);
  return { blocked: false, state: [at], deadlines: at === null ? [] : [at] };
}

export function createGoogleTechnicalInformationRetention(db: Db) {
  async function clearInvocationErrors(cutoff: string) {
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
    const stripped = await db.update(toolCatalogEntries)
      .set({ title: null, description: null, inputSchema: {}, outputSchema: null, annotations: {}, uiMeta: null, icons: null })
      .where(sql`${toolCatalogEntries.id} in (select e.id from tool_catalog_entries e
        join tool_connections c on c.id = e.connection_id
        where c.id in ${googleConnectionIds()}
          and (e.description is not null or e.title is not null or e.input_schema <> '{}'::jsonb or e.output_schema is not null
            or e.annotations <> '{}'::jsonb or e.ui_meta is not null or e.icons is not null)
          and (c.status = 'archived' or e.last_seen_at <= ${cutoff}::timestamptz)
        limit ${BATCH_SIZE})`)
      .returning({ connectionId: toolCatalogEntries.connectionId });
    const connectionIds = [...new Set(stripped.map((row) => row.connectionId))];
    if (connectionIds.length > 0) {
      await db.update(toolConnections).set({ lastCatalogRefreshAt: null })
        .where(and(inArray(toolConnections.id, connectionIds), sql`${toolConnections.status} <> 'archived'`));
    }
    return stripped.length;
  }

  async function stripRevokedGrantEvidence() {
    await db.update(connectionGrants)
      .set({ providerTenant: sql`${connectionGrants.providerTenant} - 'oauth'` as never })
      .where(sql`${connectionGrants.status} = 'revoked' and ${connectionGrants.providerTenant} ? 'oauth'
        and ${connectionGrants.connectionId} in ${googleConnectionIds()}`);
  }

  async function sweep(signal: AbortSignal, now = new Date()) {
    const cutoff = cutoffAt(now);
    for (const step of [clearInvocationErrors, clearEventErrors, stripCatalog]) {
      let cleared = BATCH_SIZE;
      while (cleared === BATCH_SIZE && !signal.aborted) cleared = await step(cutoff);
    }
    if (signal.aborted) return;
    await clearHealthText(cutoff);
    await stripRevokedGrantEvidence();
  }

  return { sweep, nextDeadline: (now?: number) => nextGoogleTechnicalInformationDeadline(db, now) };
}
