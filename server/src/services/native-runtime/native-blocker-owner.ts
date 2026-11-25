import { and, eq, inArray, or, sql } from "drizzle-orm";
import { authUsers, companyMemberships, issues, type Db } from "@paperclipai/db";

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

/** Resolve human routing from current company membership, never from a name alone. */
export async function nativeBlockerUserId(input: {
  db: Db;
  companyId: string;
  issueId: string;
  owner: Record<string, unknown>;
  lockSources?: boolean;
}): Promise<string | null> {
  if (!["user", "board"].includes(String(input.owner.kind)) && input.owner.owner !== "board") return null;
  if ("userId" in input.owner && !text(input.owner.userId)) return null;

  const [issue] = await input.db.select({ unblockDescriptor: issues.unblockDescriptor }).from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).limit(1);
  const savedOwner = issue?.unblockDescriptor?.owner;
  // An API-bound user is authoritative when a provider only reports a generic name.
  // An explicit provider userId must stand on its own; never fall back after a bad ID.
  const userId = text(input.owner.userId)
    ?? (savedOwner && typeof savedOwner === "object" && "userId" in savedOwner ? savedOwner.userId : null);
  const name = text(input.owner.name);
  if (!userId && (!name || input.owner.kind !== "user")) return null;

  const matchingUsers = input.db.select({ id: authUsers.id }).from(authUsers).where(or(
    sql`lower(${authUsers.name}) = lower(${name})`,
    sql`lower(${authUsers.email}) = lower(${name})`,
  ));
  const query = input.db.select({ userId: companyMemberships.principalId }).from(companyMemberships).where(and(
    eq(companyMemberships.companyId, input.companyId),
    eq(companyMemberships.principalType, "user"),
    eq(companyMemberships.status, "active"),
    userId ? eq(companyMemberships.principalId, userId) : or(
      eq(companyMemberships.principalId, name!),
      inArray(companyMemberships.principalId, matchingUsers),
    ),
  )).limit(2);
  // Evidence is reclassified under the status transaction. Retain membership
  // until that transaction commits, so revocation cannot race the projection.
  const candidates = await (input.lockSources ? query.for("share", { noWait: true }) : query);
  return candidates.length === 1 ? candidates[0]!.userId : null;
}
