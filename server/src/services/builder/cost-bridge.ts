import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { costService } from "../costs.js";

/**
 * Cost bridge — turns provider usage events from a Builder turn into rows in
 * `cost_events` so they roll up through the existing budget hard-stop logic
 * in `services/budgets.ts`.
 *
 * Cost events require an `agentId` that belongs to the company. We attribute
 * Builder spend to a synthetic, terminated agent named `__builder__`,
 * created on demand. It is hidden from default agent listings (status
 * `terminated`) so it doesn't pollute the org chart, but the budget engine
 * still includes its spend in the company-wide monthly window.
 */

const SYNTHETIC_AGENT_NAME = "__builder__";

async function ensureSyntheticBuilderAgent(db: Db, companyId: string): Promise<string> {
  const existing = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.name, SYNTHETIC_AGENT_NAME)))
    .then((rows) => rows[0] ?? null);
  if (existing) return existing.id;

  const [created] = await db
    .insert(agents)
    .values({
      companyId,
      name: SYNTHETIC_AGENT_NAME,
      role: "system",
      title: "Company AI Builder",
      adapterType: "process",
      adapterConfig: { synthetic: true, source: "builder" },
      // Hidden from the org by default; the agents service filters out
      // terminated agents unless explicitly requested.
      status: "terminated",
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
    })
    .returning({ id: agents.id });
  return created.id;
}

export interface BuilderCostEventInput {
  companyId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  occurredAt?: Date;
}

/**
 * Record a cost event for a Builder turn. Best-effort: failures are logged
 * but never thrown — Builder UX must not break because cost accounting hit
 * a glitch. The budget hard-stop integration still works because it runs
 * inside `costService.createEvent`.
 */
export async function recordBuilderCost(
  db: Db,
  input: BuilderCostEventInput,
): Promise<void> {
  if (input.inputTokens === 0 && input.outputTokens === 0 && input.costCents === 0) {
    return;
  }
  try {
    const agentId = await ensureSyntheticBuilderAgent(db, input.companyId);
    await costService(db).createEvent(input.companyId, {
      agentId,
      provider: input.provider,
      biller: input.provider,
      billingType: "llm",
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costCents: input.costCents,
      occurredAt: input.occurredAt ?? new Date(),
      billingCode: "builder",
    });
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId, model: input.model },
      "builder cost-bridge failed to record cost event",
    );
  }
}
