import { agents } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import type { CompanyDeletionParticipant } from "../../../lib/company-deletion.js";
import { AgentLifecycleConflict, assertAgentPurgeAllowed } from "../domain/policy.js";

export const agentLifecycleCompanyDeletion: CompanyDeletionParticipant = {
  async deleteCompanyData(tx, companyId) {
    if (!("nestedIndex" in tx)) {
      throw new AgentLifecycleConflict("Company deletion requires a database transaction");
    }
    const rows = await tx.select({ lifecycleState: agents.lifecycleState }).from(agents)
      .where(eq(agents.companyId, companyId)).for("update");
    for (const agent of rows) assertAgentPurgeAllowed(agent);
    await tx.delete(agents).where(and(
      eq(agents.companyId, companyId),
      inArray(agents.lifecycleState, ["terminated", "rejected"]),
    ));
  },
};
