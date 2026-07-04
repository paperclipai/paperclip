import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { budgetService } from "./budgets.js";

export async function applyReviewOwnerDelegation(
  db: Db,
  input: {
    companyId: string;
    resolvedOwnerAgentId: string | null;
    issueId?: string | null;
    projectId?: string | null;
  },
) {
  if (!input.resolvedOwnerAgentId) return input.resolvedOwnerAgentId;

  const [owner] = await db
    .select({ id: agents.id, role: agents.role })
    .from(agents)
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.resolvedOwnerAgentId)))
    .limit(1);
  if (owner?.role !== "ceo") return input.resolvedOwnerAgentId;

  const [company] = await db
    .select({ productivityReviewDelegateAgentId: companies.productivityReviewDelegateAgentId })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1);
  const delegateAgentId = company?.productivityReviewDelegateAgentId ?? null;
  if (!delegateAgentId || delegateAgentId === input.resolvedOwnerAgentId) {
    return input.resolvedOwnerAgentId;
  }

  const [delegate] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, delegateAgentId)))
    .limit(1);
  const delegateInvokability = await evaluateAgentInvokabilityFromDb(db, delegate ?? null);
  if (!delegateInvokability.invokable) return input.resolvedOwnerAgentId;

  const budgetBlock = await budgetService(db).getInvocationBlock(input.companyId, delegate.id, {
    issueId: input.issueId ?? null,
    projectId: input.projectId ?? null,
  });
  if (budgetBlock) return input.resolvedOwnerAgentId;

  return delegate.id;
}
