import { and, eq } from "drizzle-orm";
import {
  chatEndpoints,
  chatExternalPrincipals,
  chatGitHubConfigurations,
  chatIdentityLinks,
  companyMemberships,
  type Db,
} from "@paperclipai/db";

type Database = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Current authority shared by task admission and every later publication. */
export async function githubChatPrincipalAccess(
  db: Database,
  endpoint: typeof chatEndpoints.$inferSelect,
  principalId: string,
) {
  if (endpoint.provider !== "github") return null;
  const [saved] = await db
    .select()
    .from(chatGitHubConfigurations)
    .where(
      and(
        eq(chatGitHubConfigurations.companyId, endpoint.companyId),
        eq(chatGitHubConfigurations.endpointId, endpoint.id),
      ),
    )
    .for("share");
  if (!saved) return null; // Preserve the existing connector until explicitly upgraded.
  const [principal] = await db
    .select()
    .from(chatExternalPrincipals)
    .where(
      and(
        eq(chatExternalPrincipals.companyId, endpoint.companyId),
        eq(chatExternalPrincipals.id, principalId),
      ),
    )
    .for("share");
  const denied = {
    allowed: false,
    linkedDenied: true,
    userId: null as string | null,
    sponsorUserId: null as string | null,
  };
  if (!principal) return denied;
  const config = saved.configuration;
  const person = config.people.find(
    (p) => p.githubUserId === principal.externalId,
  );
  const [link] = await db
    .select()
    .from(chatIdentityLinks)
    .where(
      and(
        eq(chatIdentityLinks.companyId, endpoint.companyId),
        eq(chatIdentityLinks.endpointId, endpoint.id),
        eq(chatIdentityLinks.principalId, principalId),
      ),
    )
    .for("share");
  const activeMember = async (userId: string) => {
    const [membership] = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, endpoint.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .for("share");
    return !!membership && membership.membershipRole !== "viewer";
  };
  if (link?.status === "linked" && link.paperclipUserId) {
    const allowed =
      (await activeMember(link.paperclipUserId)) &&
      (config.memberAccess === "all_linked" ||
        (person?.kind === "member" && person.userId === link.paperclipUserId));
    return {
      ...denied,
      allowed,
      linkedDenied: !allowed,
      userId: allowed ? link.paperclipUserId : null,
    };
  }
  // Revocation is not an invitation to fall back to a guest identity.
  if (
    link?.status === "revoked" ||
    person?.kind !== "guest" ||
    !endpoint.allowUnlinkedPeople ||
    !(await activeMember(person.sponsorUserId))
  )
    return denied;
  return {
    allowed: true,
    linkedDenied: false,
    userId: null,
    sponsorUserId: person.sponsorUserId,
  };
}
