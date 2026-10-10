import { and, eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, type Db } from "@paperclipai/db";

const TOAST_ACTIONS = new Set(["issue.created", "issue.updated", "issue.comment_added"]);

/** Called only after the viewer can read the activity's task. Never copy details. */
export async function activityToastIdentity(
  db: Db,
  companyId: string,
  payload: Record<string, unknown>,
) {
  const actorType = typeof payload.actorType === "string" ? payload.actorType : null;
  const actorId = typeof payload.actorId === "string" ? payload.actorId : null;
  const identity = { actorType, actorId };
  if (!actorId || !TOAST_ACTIONS.has(String(payload.action))) return identity;

  if (actorType === "agent") {
    const [agent] = await db
      .select({ name: agents.name, appearance: agents.appearance })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, actorId)))
      .limit(1);
    return { ...identity, actorName: agent?.name, actorAppearance: agent?.appearance };
  }
  if (actorType === "user") {
    const [user] = await db
      .select({ name: authUsers.name, image: authUsers.image })
      .from(companyMemberships)
      .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, actorId),
        eq(companyMemberships.status, "active"),
      ))
      .limit(1);
    return { ...identity, actorName: user?.name, actorImage: user?.image };
  }
  return identity;
}
