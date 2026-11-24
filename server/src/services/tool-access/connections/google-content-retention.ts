import type { Db } from "@paperclipai/db";
import { isGoogleWorkspaceConnectionConfig, type ToolConnectionContentDeletionReason } from "@paperclipai/shared";
import { logActivity } from "../../activity-log.js";
import type { ActorInfo } from "../types.js";
import { requestConnectionContentDeletion, type ContentDeletionActor } from "./content-deletion.js";

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
