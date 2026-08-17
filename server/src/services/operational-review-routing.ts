import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { assertAssignableAgent } from "./agent-assignability.js";

export async function resolveConfiguredOperationalReviewOwnerAgentId(
  db: Db,
  companyId: string,
  opts?: { excludeAgentIds?: string[] },
) {
  const company = await db
    .select({ interactionResolverGovernance: companies.interactionResolverGovernance })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  const configuredAgentId = company?.interactionResolverGovernance?.operationalReviewOwnerAgentId;
  if (!configuredAgentId) return null;
  if (opts?.excludeAgentIds?.includes(configuredAgentId)) return null;

  const configuredOwner = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, configuredAgentId)))
    .then((rows) => rows[0] ?? null);
  if (!configuredOwner) return null;
  try {
    await assertAssignableAgent(db, companyId, configuredOwner.id, { kind: "work" });
  } catch {
    return null;
  }
  return configuredOwner?.id ?? null;
}
