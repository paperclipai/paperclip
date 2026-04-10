import { createDb } from "@paperclipai/db";
import { agentRoleMigrationService } from "../server/src/services/agent-role-migration.js";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const db = createDb(dbUrl);
  const svc = agentRoleMigrationService(db);
  const report = await svc.migrateOperationsToCoo({ apply });

  const summary = [
    `mode=${apply ? "apply" : "dry-run"}`,
    `agentRolesUpdated=${report.agentRolesUpdated}`,
    `agentRolesAlreadyCanonical=${report.agentRolesAlreadyCanonical}`,
    `approvalPayloadsUpdated=${report.approvalPayloadsUpdated}`,
    `approvalPayloadsAlreadyCanonical=${report.approvalPayloadsAlreadyCanonical}`,
    `managedBundlesReseeded=${report.managedBundlesReseeded}`,
    `managedBundlesPreserved=${report.managedBundlesPreserved}`,
  ].join(" ");

  console.log(summary);
  if (!apply) {
    console.log("Re-run with --apply to persist changes.");
  }
}

void main();
