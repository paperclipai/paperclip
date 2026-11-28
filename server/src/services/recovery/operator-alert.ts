import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, authUsers, companies, companyMemberships } from "@paperclipai/db";

const OPERATOR_MEMBERSHIP_ROLES = new Set(["owner", "admin"]);

export function formatOperatorAlertMentions(input: {
  ceo?: { id: string; name: string } | null;
  users: Array<{ id: string; name: string | null }>;
}): string {
  const parts: string[] = [];
  if (input.ceo?.id) {
    const name = input.ceo.name.trim() || "CEO";
    parts.push(`[${name}](agent://${input.ceo.id})`);
  }
  const seen = new Set<string>();
  for (const user of input.users) {
    const id = user.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = (user.name ?? "").trim() || "operator";
    parts.push(`[${name}](user://${id})`);
  }
  return parts.join(" ");
}

export async function loadCompanyOperatorMentions(
  db: Db,
  companyId: string,
): Promise<string> {
  const [ceoRows, companyRows, membershipRows] = await Promise.all([
    db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), ne(agents.status, "terminated")))
      .limit(1),
    db
      .select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1),
    db
      .select({
        principalId: companyMemberships.principalId,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      ),
  ]);

  const userIds = new Set<string>();
  const defaultResponsibleUserId = companyRows[0]?.defaultResponsibleUserId?.trim();
  if (defaultResponsibleUserId) userIds.add(defaultResponsibleUserId);
  for (const row of membershipRows) {
    const role = (row.membershipRole ?? "").trim().toLowerCase();
    if (!OPERATOR_MEMBERSHIP_ROLES.has(role)) continue;
    const id = row.principalId.trim();
    if (id) userIds.add(id);
  }

  const users =
    userIds.size === 0
      ? []
      : await db
          .select({ id: authUsers.id, name: authUsers.name })
          .from(authUsers)
          .where(inArray(authUsers.id, [...userIds]));

  return formatOperatorAlertMentions({
    ceo: ceoRows[0] ?? null,
    users,
  });
}
