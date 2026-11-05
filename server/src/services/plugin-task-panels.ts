import { and, eq, ne, sql } from "drizzle-orm";
import { heartbeatRunEvents, plugins, type Db } from "@paperclipai/db";

export const RUNTIME_ACTIVITY_EVENT = "runtime.activity.recorded";
export interface TaskPanelActivation { pluginKey: string; slotId: string }

export function runtimeActivity(payload: Record<string, unknown> | null): { namespace: string; activityKey: string } | null {
  const valid = (value: unknown): value is string => typeof value === "string" && value.length > 0
    && Array.from(value).length <= 160 && !/[\u0000-\u001f\u007f]/.test(value);
  return payload && Object.keys(payload).length === 2 && valid(payload.namespace) && valid(payload.activityKey)
    ? { namespace: payload.namespace, activityKey: payload.activityKey } : null;
}

/** Core maps authenticated runtime facts to installed UI declarations. */
export async function readTaskPanelActivations(db: Db, companyId: string, runId: string): Promise<TaskPanelActivation[]> {
  const rows = await db.selectDistinct({
    payload: sql<Record<string, unknown>>`${heartbeatRunEvents.payload}->'prpEvent'->'payload'`, manifest: plugins.manifestJson, pluginKey: plugins.pluginKey,
  }).from(heartbeatRunEvents)
    .innerJoin(plugins, sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements(${plugins.manifestJson}->'ui'->'slots') AS declared_slot
      WHERE declared_slot->'taskSidePanel'->'activation' = ${heartbeatRunEvents.payload}->'prpEvent'->'payload'
    )`)
    .where(and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId),
      eq(heartbeatRunEvents.eventType, RUNTIME_ACTIVITY_EVENT), ne(plugins.status, "uninstalled"),
      sql`${heartbeatRunEvents.payload}->'prpEvent'->>'sourceKind' = 'runner'`,
      sql`${heartbeatRunEvents.payload}->'prpEvent'->>'eventType' = ${RUNTIME_ACTIVITY_EVENT}`)).limit(128);
  return rows.flatMap(({ payload, manifest, pluginKey }) => {
    const activity = runtimeActivity(payload);
    return activity ? (manifest.ui?.slots ?? []).filter(slot => slot.type === "detailTab"
      && slot.entityTypes?.includes("agent") && slot.taskSidePanel?.activation?.namespace === activity.namespace
      && slot.taskSidePanel?.activation?.activityKey === activity.activityKey)
      .map(slot => ({ pluginKey, slotId: slot.id })) : [];
  }).slice(0, 128);
}
