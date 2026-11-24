import { and, eq, sql } from "drizzle-orm";
import { toolApplications, toolConnections, type Db } from "@paperclipai/db";
import {
  isGoogleWorkspaceConnectorProfileId,
  isGoogleWorkspaceSourceTemplateKey,
  type ToolConnectionContentDeletionReason,
} from "@paperclipai/shared";
import { logActivity } from "../../activity-log.js";
import type { ActorInfo } from "../types.js";
import { toolSourceTemplateKeySql } from "../source-template-key.js";
import { requestConnectionContentDeletion, type ContentDeletionActor } from "./content-deletion.js";

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
