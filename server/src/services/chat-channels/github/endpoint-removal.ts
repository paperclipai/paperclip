import { and, eq } from "drizzle-orm";
import { chatIdentityLinks, type Db } from "@paperclipai/db";
import { logActivity } from "../../activity-log.js";
import type { ConnectionManagementContext } from "../../connection-management.js";
import { notifyChatCompanyAuthorityChange } from "../../chat-run-milestone-notifications.js";

export async function revokeGitHubEndpointIdentityLinks(
  tx: Db,
  endpoint: { id: string; companyId: string; connectionId: string },
  audit: ConnectionManagementContext["audit"],
) {
  const revokedAt = new Date();
  const revoked = await tx
    .update(chatIdentityLinks)
    .set({
      paperclipUserId: null,
      status: "revoked",
      confirmationTokenHash: null,
      revokedAt,
      updatedAt: revokedAt,
    })
    .where(and(
      eq(chatIdentityLinks.companyId, endpoint.companyId),
      eq(chatIdentityLinks.endpointId, endpoint.id),
      eq(chatIdentityLinks.status, "linked"),
    ))
    .returning({ id: chatIdentityLinks.id });
  if (revoked.length > 0) {
    await notifyChatCompanyAuthorityChange(tx, { companyId: endpoint.companyId });
  }
  await logActivity(tx, {
    companyId: endpoint.companyId,
    ...audit,
    action: "chat_github.removed",
    entityType: "tool_connection",
    entityId: endpoint.connectionId,
    details: { endpointId: endpoint.id, revokedLinkCount: revoked.length },
  });
}
