import { and, eq, ne } from "drizzle-orm";
import { type Db, agents, connectionGrants, toolConnections } from "@paperclipai/db";
import {
  aiConnectionBindingSchema,
  type CompanyAiConnectionHealth,
  type CompanyAiHealth,
} from "@paperclipai/shared";
import { aiConnectionStatus } from "./ai-connections.js";

function agentBinding(runtimeConfig: unknown) {
  if (typeof runtimeConfig !== "object" || runtimeConfig === null) return null;
  const parsed = aiConnectionBindingSchema.safeParse((runtimeConfig as Record<string, unknown>).aiConnection);
  return parsed.success && parsed.data.mode !== "responsible_user" ? parsed.data : null;
}

/** Shared and delegated AI connections that agents use and that need sign-in. Holds no credential material. */
export function aiHealthService(db: Db) {
  async function summarize(companyId: string): Promise<CompanyAiHealth> {
    const [agentRows, accountRows] = await Promise.all([
      db.select({ id: agents.id, runtimeConfig: agents.runtimeConfig })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")))
        .orderBy(agents.name, agents.id),
      db.select({ connection: toolConnections, grant: connectionGrants })
        .from(toolConnections)
        .innerJoin(connectionGrants, and(
          eq(connectionGrants.companyId, toolConnections.companyId),
          eq(connectionGrants.connectionId, toolConnections.id),
        ))
        .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.connectionPurpose, "ai"))),
    ]);
    const brokenById = new Map<string, CompanyAiConnectionHealth>();
    for (const agent of agentRows) {
      const binding = agentBinding(agent.runtimeConfig);
      if (!binding) continue;
      const account = accountRows.find((row) => row.connection.id === binding.connectionId && row.grant.id === binding.grantId);
      if (!account) continue;
      const status = aiConnectionStatus(account.connection, account.grant);
      if (status === "connected") continue;
      const entry = brokenById.get(account.connection.id) ?? {
        id: account.connection.id,
        name: account.connection.name,
        provider: binding.provider,
        status,
        affectedAgentIds: [],
      };
      if (!entry.affectedAgentIds.includes(agent.id)) entry.affectedAgentIds.push(agent.id);
      brokenById.set(entry.id, entry);
    }
    return { connections: [...brokenById.values()] };
  }

  return { summarize };
}
