import { sql } from "drizzle-orm";
import type { agents, Db } from "@paperclipai/db";

export type AgentReportingChainRow = Pick<typeof agents.$inferSelect, "id" | "companyId" | "name" | "reportsTo" | "status">;

export async function readAgentReportingChain(
  db: Pick<Db, "execute">,
  agent: { companyId: string; reportsTo: string | null },
): Promise<AgentReportingChainRow[]> {
  if (!agent.reportsTo) return [];
  const rows = await db.execute<{ id: string; company_id: string; name: string; reports_to: string | null; status: string }>(sql`
    with recursive chain(id, company_id, name, reports_to, status) as (
      select id, company_id, name, reports_to, status from agents
      where company_id = ${agent.companyId}::uuid and id = ${agent.reportsTo}::uuid
      union
      select manager.id, manager.company_id, manager.name, manager.reports_to, manager.status
      from agents manager inner join chain on manager.id = chain.reports_to
      where manager.company_id = ${agent.companyId}::uuid
    ) select id::text, company_id::text, name, reports_to::text, status from chain`);
  return rows.map(row => ({ id: row.id, companyId: row.company_id, name: row.name, reportsTo: row.reports_to,
    status: row.status as AgentReportingChainRow["status"] }));
}
