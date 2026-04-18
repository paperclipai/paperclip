import { createDb } from "@paperclipai/db";
import { loadConfig } from "../src/config.js";
import { routineService } from "../src/services/routines.js";

function resolveDatabaseUrl() {
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;

  const config = loadConfig();
  return config.databaseUrl?.trim() || null;
}

function readOption(name: string) {
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return null;
  const inline = process.argv[index];
  if (inline?.startsWith(`${name}=`)) {
    return inline.slice(name.length + 1).trim() || null;
  }
  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) return null;
  return next.trim() || null;
}

async function main() {
  const dbUrl = resolveDatabaseUrl();
  if (!dbUrl) {
    console.error("DATABASE_URL is required for this script when the server is using embedded PostgreSQL.");
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const asJson = process.argv.includes("--json");
  const companyId = readOption("--company");
  const routineId = readOption("--routine");

  const db = createDb(dbUrl);
  const svc = routineService(db);

  if (apply) {
    const result = await svc.reconcileExecutionState({ companyId, routineId });
    if (asJson) {
      console.log(JSON.stringify({ mode: "apply", scope: { companyId, routineId }, ...result }, null, 2));
    } else {
      console.log(
        `mode=apply routinesInspected=${result.routinesInspected} routinesReconciled=${result.routinesReconciled} staleExecutionLocksCleared=${result.staleExecutionLocksCleared} canonicalRolesUpdated=${result.canonicalRolesUpdated} parallelRolesUpdated=${result.parallelRolesUpdated} duplicateIssuesSuperseded=${result.duplicateIssuesSuperseded} wakeupsCancelled=${result.wakeupsCancelled} queuedRunsCancelled=${result.queuedRunsCancelled}`,
      );
    }
    return;
  }

  const inspection = await svc.inspectExecutionState({ companyId, routineId });
  if (asJson) {
    console.log(JSON.stringify({ mode: "dry-run", scope: { companyId, routineId }, ...inspection }, null, 2));
  } else {
    console.log(
      `mode=dry-run routinesInspected=${inspection.routinesInspected} routinesWithChanges=${inspection.routinesWithChanges} staleExecutionLocks=${inspection.staleExecutionLocks.count} canonicalRoleUpdates=${inspection.canonicalRoleUpdates.count} parallelRoleUpdates=${inspection.parallelRoleUpdates.count} duplicateIssues=${inspection.duplicateIssues.count} wakeupsToCancel=${inspection.wakeupsToCancel.count} queuedRunsToCancel=${inspection.queuedRunsToCancel.count}`,
    );
    console.log("Re-run with --apply to persist repairs.");
  }
}

void main();
