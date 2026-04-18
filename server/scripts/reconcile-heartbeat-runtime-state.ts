import { createDb } from "@paperclipai/db";
import { loadConfig } from "../src/config.js";
import { runtimeIntegrityService } from "../src/services/runtime-integrity.js";

function resolveDatabaseUrl() {
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;

  const config = loadConfig();
  return config.databaseUrl?.trim() || null;
}

async function main() {
  const dbUrl = resolveDatabaseUrl();
  if (!dbUrl) {
    console.error("DATABASE_URL is required for this script when the server is using embedded PostgreSQL.");
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const asJson = process.argv.includes("--json");
  const db = createDb(dbUrl);
  const svc = runtimeIntegrityService(db);

  if (apply) {
    const result = await svc.reconcileAll();
    if (asJson) {
      console.log(JSON.stringify({ mode: "apply", ...result }, null, 2));
    } else {
      console.log(`mode=apply wakeupsReconciled=${result.wakeupsReconciled} runsCancelled=${result.runsCancelled} issuesNormalized=${result.issuesNormalized} issuesRebound=${result.issuesRebound}`);
    }
    return;
  }

  const inspection = await svc.inspect();
  if (asJson) {
    console.log(JSON.stringify({ mode: "dry-run", ...inspection }, null, 2));
  } else {
    console.log(
      `mode=dry-run staleWakeups=${inspection.staleWakeups.count} blockedQueuedRuns=${inspection.blockedQueuedRuns.count} brokenIssues=${inspection.brokenInProgressIssues.count} rebindable=${inspection.brokenInProgressIssues.rebindableIssueIds.length} normalizable=${inspection.brokenInProgressIssues.normalizableIssueIds.length} ambiguous=${inspection.brokenInProgressIssues.ambiguousIssueIds.length}`,
    );
    console.log("Re-run with --apply to persist repairs.");
  }
}

void main();
