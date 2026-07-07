import { and, eq, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";

const NON_LIVE_AGENT_BUDGET_STATUSES = ["pending_approval", "terminated"];

export async function getCompanyBudgetAggregateCents(
  db: Db,
  company: Pick<typeof companies.$inferSelect, "id" | "budgetMonthlyCents">,
) {
  const [row] = await db
    .select({
      seatBudgetCents: sql<number>`coalesce(sum(${agents.budgetMonthlyCents}), 0)::double precision`,
    })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, company.id),
        notInArray(agents.status, NON_LIVE_AGENT_BUDGET_STATUSES),
      ),
    );

  const seatBudgetCents = Number(row?.seatBudgetCents ?? 0);
  return seatBudgetCents > 0 ? seatBudgetCents : company.budgetMonthlyCents;
}
