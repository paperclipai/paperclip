import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { heartbeatRuns, toolActionRequests, toolCallEvents, toolConnections, toolInvocations, type Db } from "@paperclipai/db";
import { isGoogleWorkspaceConnectionConfig, type ToolConnectionContentDeletionReason } from "@paperclipai/shared";
import { logActivity } from "../../activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";
import type { ActorInfo } from "../types.js";
import { requestConnectionContentDeletion, type ContentDeletionActor } from "./content-deletion.js";
import { googleConnectionConfigSql } from "./google-technical-information.js";

export type GoogleAccessEndReason = Exclude<ToolConnectionContentDeletionReason, "requested">;

const SYSTEM_ACTOR: ContentDeletionActor = { actorType: "system", actorId: null };

export function contentDeletionActor(actor: ActorInfo | undefined): ContentDeletionActor {
  if ((actor?.actorType === "user" || actor?.actorType === "agent") && actor.actorId) return { actorType: actor.actorType, actorId: actor.actorId };
  return SYSTEM_ACTOR;
}

export function isGoogleWorkspaceConnection(connection: { config: unknown }): boolean {
  return isGoogleWorkspaceConnectionConfig(connection.config);
}

export async function deleteGoogleContentWhenAccessEnds(
  db: Db,
  connection: { id: string; companyId: string; config: unknown },
  reason: GoogleAccessEndReason,
  actor: ContentDeletionActor = SYSTEM_ACTOR,
) {
  if (!isGoogleWorkspaceConnection(connection)) return null;
  await notifyDeliveryWork(db, DELIVERY_QUEUES.googleTechnicalInformation);
  const { deletion } = await requestConnectionContentDeletion(db, connection, actor, reason);
  await logActivity(db, {
    companyId: connection.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId ?? "google-content-retention",
    action: "tool_connection.content_deletion_started",
    entityType: "tool_connection",
    entityId: connection.id,
    details: { reason },
  });
  return deletion;
}

async function googleRunIds(db: Pick<Db, "select">, companyId: string, runs: SQL): Promise<Set<string>> {
  const google = googleConnectionConfigSql(sql`${toolConnections.config}`);
  const calls = await db.select({ runId: toolInvocations.runId }).from(toolInvocations)
    .innerJoin(toolConnections, eq(toolConnections.id, toolInvocations.connectionId))
    .where(and(eq(toolInvocations.companyId, companyId), sql`${toolInvocations.runId} in ${runs}`, google));
  const events = await db.select({ runId: toolCallEvents.runId }).from(toolCallEvents)
    .innerJoin(toolConnections, eq(toolConnections.id, toolCallEvents.connectionId))
    .where(and(eq(toolCallEvents.companyId, companyId), sql`${toolCallEvents.runId} in ${runs}`, google));
  return new Set([...calls, ...events].flatMap((row) => row.runId ? [row.runId] : []));
}

export async function runsThatUsedGoogleWorkspace(db: Pick<Db, "select">, companyId: string, runIds: string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  return googleRunIds(db, companyId, sql`(${sql.join(runIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
}

export async function sessionUsedGoogleWorkspace(db: Pick<Db, "select">, input: {
  companyId: string;
  agentId: string;
  runId: string;
  sessionIds: Array<string | null>;
}): Promise<boolean> {
  const sessionIds = input.sessionIds.flatMap((id) => id ? [id] : []);
  const sameSession = sessionIds.length > 0
    ? or(inArray(heartbeatRuns.sessionIdBefore, sessionIds), inArray(heartbeatRuns.sessionIdAfter, sessionIds))
    : undefined;
  const runs = sql`(select ${heartbeatRuns.id} from ${heartbeatRuns} where ${and(
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId),
    sameSession ? or(eq(heartbeatRuns.id, input.runId), sameSession) : eq(heartbeatRuns.id, input.runId),
  )})`;
  return (await googleRunIds(db, input.companyId, runs)).size > 0;
}

export async function interactionCarriesGoogleWorkspaceAction(db: Pick<Db, "select">, companyId: string, interactionId: string): Promise<boolean> {
  const [row] = await db.select({ id: toolActionRequests.id }).from(toolActionRequests)
    .innerJoin(toolInvocations, eq(toolInvocations.id, toolActionRequests.invocationId))
    .innerJoin(toolConnections, eq(toolConnections.id, toolInvocations.connectionId))
    .where(and(
      eq(toolActionRequests.companyId, companyId),
      eq(toolActionRequests.interactionId, interactionId),
      googleConnectionConfigSql(sql`${toolConnections.config}`),
    ))
    .limit(1);
  return Boolean(row);
}
