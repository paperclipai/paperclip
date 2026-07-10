import { createDb } from "@paperclipai/db";
import { seoDocGovernanceService } from "../src/services/seo-doc-governance.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!companyId) throw new Error("PAPERCLIP_COMPANY_ID is required");

  const db = createDb(databaseUrl);
  const governance = seoDocGovernanceService(db);
  const result = await governance.seedFromIssueIdentifiers(companyId, ["INS-312", "INS-85"]);
  process.stdout.write(`Seeded seo doc registry entries: ${result.synced}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
