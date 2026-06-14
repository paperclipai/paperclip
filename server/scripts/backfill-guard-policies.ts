/**
 * Idempotent one-shot: ensure every company and agent in the instance has a
 * platform-guard total_tokens budget policy. Run after deploying the guard
 * feature so existing entities (e.g. CMO, CEO exec agents) gain the ceiling.
 *
 * Usage:
 *   DATABASE_URL=<url> tsx server/scripts/backfill-guard-policies.ts
 *   DATABASE_URL=<url> tsx server/scripts/backfill-guard-policies.ts --dry-run
 */

import { createDb, agents as agentsTable, companies as companiesTable, budgetPolicies } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { instanceSettingsService } from "../src/services/instance-settings.js";
import { budgetService } from "../src/services/budgets.js";

const dryRun = process.argv.includes("--dry-run");
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const db = createDb(databaseUrl);
const instSvc = instanceSettingsService(db);
const budgets = budgetService(db);

async function hasPolicyFor(companyId: string, scopeType: string, scopeId: string): Promise<boolean> {
  const existing = await db
    .select({ id: budgetPolicies.id })
    .from(budgetPolicies)
    .where(
      and(
        eq(budgetPolicies.companyId, companyId),
        eq(budgetPolicies.scopeType, scopeType),
        eq(budgetPolicies.scopeId, scopeId),
        eq(budgetPolicies.metric, "total_tokens"),
        eq(budgetPolicies.windowKind, "calendar_month_utc"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return existing !== null;
}

async function main() {
  const guards = await instSvc.getGuards();
  if (!guards.enabled) {
    console.log("Guards disabled (guards.enabled=false). Nothing to backfill.");
    process.exit(0);
  }

  console.log(`Guards config: companyMonthlyTokens=${guards.budget.companyMonthlyTokens} agentMonthlyTokens=${guards.budget.agentMonthlyTokens} hardStop=${guards.budget.hardStop} dryRun=${dryRun}`);

  const allCompanies = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable);
  let companiesPatched = 0;
  for (const company of allCompanies) {
    const has = await hasPolicyFor(company.id, "company", company.id);
    if (!has) {
      if (!dryRun) {
        await budgets.upsertPolicy(
          company.id,
          {
            scopeType: "company",
            scopeId: company.id,
            metric: guards.budget.metric,
            amount: guards.budget.companyMonthlyTokens,
            windowKind: guards.budget.windowKind,
            warnPercent: guards.budget.warnPercent,
            hardStopEnabled: guards.budget.hardStop,
          },
          null,
        );
      }
      console.log(`  [company] ${company.name} (${company.id}) — ${dryRun ? "would upsert" : "upserted"}`);
      companiesPatched++;
    }
  }

  const allAgents = await db.select({ id: agentsTable.id, name: agentsTable.name, companyId: agentsTable.companyId }).from(agentsTable);
  let agentsPatched = 0;
  for (const agent of allAgents) {
    const has = await hasPolicyFor(agent.companyId, "agent", agent.id);
    if (!has) {
      if (!dryRun) {
        await budgets.upsertPolicy(
          agent.companyId,
          {
            scopeType: "agent",
            scopeId: agent.id,
            metric: guards.budget.metric,
            amount: guards.budget.agentMonthlyTokens,
            windowKind: guards.budget.windowKind,
            warnPercent: guards.budget.warnPercent,
            hardStopEnabled: guards.budget.hardStop,
          },
          null,
        );
      }
      console.log(`  [agent] ${agent.name} (${agent.id}) — ${dryRun ? "would upsert" : "upserted"}`);
      agentsPatched++;
    }
  }

  console.log(`\nDone. companies=${companiesPatched}/${allCompanies.length} agents=${agentsPatched}/${allAgents.length} ${dryRun ? "(DRY RUN)" : ""}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
