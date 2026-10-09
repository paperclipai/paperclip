import { agents, companies, type Db } from "@paperclipai/db";
import { and, eq, notInArray } from "drizzle-orm";
import { AgentLifecycleConflict } from "../domain/policy.js";

/** Final purge in the company deletion transaction, after its dependent rows. */
export async function deleteTerminatedCompanyAgents(tx: Db, companyId: string) {
  if (!("nestedIndex" in tx)) throw new Error("Company agent purge requires the company deletion transaction");
  await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("no key update");
  const unfinished = await tx.select({ id: agents.id }).from(agents).where(and(
    eq(agents.companyId, companyId), notInArray(agents.lifecycleState, ["terminated", "rejected"])));
  if (unfinished.length) throw new AgentLifecycleConflict("Complete agent termination before deleting the company");
  await tx.delete(agents).where(eq(agents.companyId, companyId));
}
