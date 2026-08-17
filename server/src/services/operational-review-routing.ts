import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";

export async function resolveConfiguredOperationalReviewOwnerAgentId(db: Db, companyId: string) {
  const company = await db
    .select({ interactionResolverGovernance: companies.interactionResolverGovernance })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  const configuredAgentId = company?.interactionResolverGovernance?.operationalReviewOwnerAgentId;
  if (!configuredAgentId) return null;

  const configuredOwner = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, configuredAgentId)))
    .then((rows) => rows[0] ?? null);
  return configuredOwner?.id ?? null;
}
