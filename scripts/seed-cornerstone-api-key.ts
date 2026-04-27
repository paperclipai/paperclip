// One-shot seed: store the Cornerstone API key as a `company_secrets` row for
// the target workforce company. Idempotent — rotates the existing row if a
// secret with the same name already exists. Safe to re-run.
//
// Usage:
//   DATABASE_URL=postgres://... \
//   COMPANY_ID=<charlie-oscar-ai-ops-company-id> \
//   CORNERSTONE_API_KEY=csk_... \
//   pnpm tsx scripts/seed-cornerstone-api-key.ts
//
// Add `--apply` to persist. Without it the script dry-runs.

import { createDb } from "../packages/db/src/index.js";
import { secretService } from "../server/src/services/secrets.js";

const SECRET_NAME = "CORNERSTONE_API_KEY";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const companyId = process.env.COMPANY_ID;
  const apiKey = process.env.CORNERSTONE_API_KEY;

  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  if (!companyId) {
    console.error("COMPANY_ID is required (Charlie Oscar AI Ops workforce company)");
    process.exit(1);
  }
  if (!apiKey) {
    console.error("CORNERSTONE_API_KEY is required");
    process.exit(1);
  }
  if (!apiKey.startsWith("csk_")) {
    console.error(
      `CORNERSTONE_API_KEY does not look like a Cornerstone key (expected csk_ prefix)`,
    );
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const db = createDb(dbUrl);
  const secrets = secretService(db);

  const existing = await secrets.getByName(companyId, SECRET_NAME);

  if (!apply) {
    if (existing) {
      console.log(
        `Dry run: would rotate existing secret ${existing.id} (name=${SECRET_NAME}, company=${companyId}, currentVersion=${existing.latestVersion})`,
      );
    } else {
      console.log(
        `Dry run: would create new secret (name=${SECRET_NAME}, company=${companyId}, provider=local_encrypted)`,
      );
    }
    console.log("Re-run with --apply to persist.");
    process.exit(0);
  }

  if (existing) {
    const rotated = await secrets.rotate(
      existing.id,
      { value: apiKey },
      { userId: "seed-cornerstone", agentId: null },
    );
    console.log(
      `Rotated secret id=${rotated.id} name=${SECRET_NAME} company=${companyId} version=${rotated.latestVersion}`,
    );
  } else {
    const created = await secrets.create(
      companyId,
      {
        name: SECRET_NAME,
        provider: "local_encrypted",
        value: apiKey,
        description: "Cornerstone API key for AI Ops workforce agents",
      },
      { userId: "seed-cornerstone", agentId: null },
    );
    console.log(
      `Created secret id=${created.id} name=${SECRET_NAME} company=${companyId} version=${created.latestVersion}`,
    );
  }

  process.exit(0);
}

void main();
