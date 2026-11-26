import { connectionActorUserId } from "../actor.js";
import type { ActorInfo } from "../types.js";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolConnections } from "@paperclipai/db";
import { forbidden } from "../../../errors.js";

import { actorBinding } from "../actor.js";
export function createPersonalConnectionIdentity(db: Db) {
  /**
   * Resolve the one user identity a personal-only connection is allowed to
   * refresh. The connection creator is authoritative for new rows; retained
   * grants cover older or agent-created rows. Reconnect may rotate that
   * identity's credential, but it may never create a different user's identity
   * on the same connection.
   */
async function fixedPersonalIdentityForReconnect(
    connection: typeof toolConnections.$inferSelect,
    requestedSubjectUserId: string | undefined,
    actor?: ActorInfo,
  ): Promise<{
    subjectUserId: string;
    grant: typeof connectionGrants.$inferSelect | null;
  } | null> {
    if (connection.credentialPolicy !== "per_user") return null;

    const personalGrants = await db
      .select()
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.companyId, connection.companyId),
          eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.kind, "user"),
        ),
      )
      .orderBy(desc(connectionGrants.updatedAt));
    const creatorGrant = connection.createdByUserId
      ? (personalGrants.find(
          (grant) => grant.subjectUserId === connection.createdByUserId,
        ) ?? null)
      : null;
    const retainedGrant =
      creatorGrant ??
      personalGrants.find((grant) => grant.credentialSecretRefs.length > 0) ??
      personalGrants[0] ??
      null;
    const fixedSubjectUserId =
      connection.createdByUserId ?? retainedGrant?.subjectUserId ?? null;
    const binding = actorBinding(actor);
    const actorUserId = connectionActorUserId(actor);
    const subjectUserId = requestedSubjectUserId ?? actorUserId;

    if (!subjectUserId) {
      throw forbidden(
        "Reconnect this personal connection as the user it belongs to",
      );
    }
    if (actorUserId && subjectUserId !== actorUserId) {
      throw forbidden(
        "Board users may only reconnect their own personal connection",
      );
    }
    if (fixedSubjectUserId && subjectUserId !== fixedSubjectUserId) {
      throw forbidden(
        "Only the existing personal identity can reconnect this connection",
      );
    }

    return {
      subjectUserId,
      grant:
        personalGrants.find((grant) => grant.subjectUserId === subjectUserId) ??
        null,
    };
  }
  return fixedPersonalIdentityForReconnect;
}
