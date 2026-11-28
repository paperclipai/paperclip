import { connectionActorUserId } from "../actor.js";
import type { ActorInfo } from "../types.js";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolConnections } from "@paperclipai/db";
import { forbidden } from "../../../errors.js";

import { actorBinding } from "../actor.js";

async function personalGrantsForConnection(
  db: Db,
  connection: typeof toolConnections.$inferSelect,
) {
  return db
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
}

/**
 * The connection creator is authoritative for new rows; retained grants cover
 * older or agent-created rows.
 */
function fixedPersonalOwnerUserId(
  connection: typeof toolConnections.$inferSelect,
  personalGrants: (typeof connectionGrants.$inferSelect)[],
): string | null {
  if (connection.createdByUserId) return connection.createdByUserId;
  const retainedGrant =
    personalGrants.find((grant) => grant.credentialSecretRefs.length > 0) ??
    personalGrants[0] ??
    null;
  return retainedGrant?.subjectUserId ?? null;
}

export function createOtherUsersArchivedPersonalConnectionCheck(db: Db) {
  /**
   * True when the connection is an archived personal connection that belongs
   * to a user other than the connecting user.
   */
  return async function isOtherUsersArchivedPersonalConnection(
    connection: typeof toolConnections.$inferSelect,
    actor?: ActorInfo,
  ): Promise<boolean> {
    if (connection.status !== "archived" || connection.credentialPolicy !== "per_user") {
      return false;
    }
    const connectingUserId = connectionActorUserId(actor);
    if (!connectingUserId) return false;
    const ownerUserId = fixedPersonalOwnerUserId(
      connection,
      await personalGrantsForConnection(db, connection),
    );
    return ownerUserId !== null && ownerUserId !== connectingUserId;
  };
}

export function createPersonalConnectionIdentity(db: Db) {
  /**
   * Resolve the one user identity a personal-only connection is allowed to
   * refresh. Reconnect may rotate that identity's credential, but it may never
   * create a different user's identity on the same connection.
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

    const personalGrants = await personalGrantsForConnection(db, connection);
    const fixedSubjectUserId = fixedPersonalOwnerUserId(connection, personalGrants);
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
