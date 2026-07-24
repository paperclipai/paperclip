import { companies, createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { companySkillService } from "../server/src/services/company-skills.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);
  const svc = companySkillService(db);
  const companyId = parseFlag("--company");
  const companyRows = companyId
    ? [{ id: companyId }]
    : await db.select({ id: companies.id }).from(companies);

  if (companyRows.length === 0) {
    console.log("No companies found; nothing to classify.");
    return;
  }

  const tierCounts: Record<string, number> = { "0": 0, "1": 0, "2": 0 };
  let classified = 0;
  let skippedOverrides = 0;

  for (const company of companyRows) {
    const skillRows = await svc.list(company.id);

    console.log(`Company ${company.id}: classifying ${skillRows.length} skill(s)...`);
    for (const row of skillRows) {
      const { skill, skipped } = await svc.runRiskClassifierForSkill(company.id, row.id, null);
      if (skipped) {
        skippedOverrides += 1;
      } else {
        classified += 1;
      }
      tierCounts[String(skill.riskTier)] = (tierCounts[String(skill.riskTier)] ?? 0) + 1;
    }
  }

  const total = classified + skippedOverrides;
  console.log("\n--- Risk-tier distribution report ---");
  console.log(`Total skills scanned: ${total}`);
  console.log(`Classified by rule engine: ${classified}`);
  console.log(`Skipped (preserved human override): ${skippedOverrides}`);
  for (const tier of ["0", "1", "2"]) {
    const count = tierCounts[tier] ?? 0;
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
    console.log(`Tier ${tier}: ${count} (${pct}%)`);
  }
  console.log("--------------------------------------");
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Skill risk-tier backfill failed: ${message}`);
  process.exitCode = 1;
});
