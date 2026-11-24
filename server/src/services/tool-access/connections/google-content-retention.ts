import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { heartbeatRuns, toolActionRequests, toolApplications, toolCallEvents, toolConnections, toolInvocations, type Db } from "@paperclipai/db";
import {
  isGoogleWorkspaceConnectorProfileId,
  isGoogleWorkspaceSourceTemplateKey,
  type ToolConnectionContentDeletionReason,
} from "@paperclipai/shared";
import { logActivity } from "../../activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";
import type { ActorInfo } from "../types.js";
import { toolSourceTemplateKeySql } from "../source-template-key.js";
import { requestConnectionContentDeletion, type ContentDeletionActor } from "./content-deletion.js";
import { googleConnectionIdsSql } from "./google-technical-information.js";

export type GoogleAccessEndReason = Exclude<ToolConnectionContentDeletionReason, "requested">;

const SYSTEM_ACTOR: ContentDeletionActor = { actorType: "system", actorId: null };

export function contentDeletionActor(actor: ActorInfo | undefined): ContentDeletionActor {
  if ((actor?.actorType === "user" || actor?.actorType === "agent") && actor.actorId) return { actorType: actor.actorType, actorId: actor.actorId };
  return SYSTEM_ACTOR;
}

export async function isGoogleWorkspaceConnection(db: Pick<Db, "select">, connection: { id: string; companyId: string }): Promise<boolean> {
  const [row] = await db
    .select({ key: toolSourceTemplateKeySql, profile: sql<string | null>`${toolConnections.config}->'oauth'->>'connectorProfile'` })
    .from(toolConnections)
    .innerJoin(toolApplications, and(eq(toolApplications.id, toolConnections.applicationId), eq(toolApplications.companyId, toolConnections.companyId)))
    .where(and(eq(toolConnections.id, connection.id), eq(toolConnections.companyId, connection.companyId)));
  if (!row) return false;
  return isGoogleWorkspaceSourceTemplateKey(row.key) || (typeof row.profile === "string" && isGoogleWorkspaceConnectorProfileId(row.profile));
}

export async function deleteGoogleContentWhenAccessEnds(
  db: Db,
  connection: { id: string; companyId: string },
  reason: GoogleAccessEndReason,
  actor: ContentDeletionActor = SYSTEM_ACTOR,
) {
  if (!(await isGoogleWorkspaceConnection(db, connection))) return null;
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
  const calls = await db.select({ runId: toolInvocations.runId }).from(toolInvocations)
    .where(and(eq(toolInvocations.companyId, companyId), sql`${toolInvocations.runId} in ${runs}`,
      sql`${toolInvocations.connectionId} in ${googleConnectionIdsSql()}`));
  const events = await db.select({ runId: toolCallEvents.runId }).from(toolCallEvents)
    .where(and(eq(toolCallEvents.companyId, companyId), sql`${toolCallEvents.runId} in ${runs}`,
      sql`${toolCallEvents.connectionId} in ${googleConnectionIdsSql()}`));
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
    .where(and(
      eq(toolActionRequests.companyId, companyId),
      eq(toolActionRequests.interactionId, interactionId),
      sql`${toolInvocations.connectionId} in ${googleConnectionIdsSql()}`,
    ))
    .limit(1);
  return Boolean(row);
}
