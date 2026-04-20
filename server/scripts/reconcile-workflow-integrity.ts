import { createDb } from "@paperclipai/db";
import { loadConfig } from "../src/config.js";
import { workflowIntegrityService } from "../src/services/workflow-integrity.js";

function resolveDatabaseUrl() {
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;

  const config = loadConfig();
  if (config.databaseUrl?.trim()) return config.databaseUrl.trim();
  if (config.databaseMode === "embedded-postgres") {
    return `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  }
  return null;
}

async function main() {
  const config = loadConfig();
  const dbUrl = resolveDatabaseUrl();
  if (!dbUrl) {
    console.error("Unable to resolve a database connection string for workflow integrity reconciliation.");
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const asJson = process.argv.includes("--json");
  let db: ReturnType<typeof createDb> | null = null;
  try {
    db = createDb(dbUrl);
    const svc = workflowIntegrityService(db);

    if (apply) {
      const result = await svc.reconcileAll();
      if (asJson) {
        console.log(JSON.stringify({ mode: "apply", ...result }, null, 2));
      } else {
        console.log(
          `mode=apply workflowRootsRepaired=${result.workflowRootsRepaired} dependencyRelationsRepaired=${result.dependencyRelationsRepaired} laneStatusesNormalized=${result.laneStatusesNormalized}`,
        );
      }
      return;
    }

    const inspection = await svc.inspect();
    if (asJson) {
      console.log(JSON.stringify({ mode: "dry-run", ...inspection }, null, 2));
    } else {
      console.log(
        `mode=dry-run brokenWorkflowRoots=${inspection.brokenWorkflowRoots.count}`,
      );
      console.log("Re-run with --apply to persist repairs.");
    }
  } catch (error) {
    const errorCode =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (errorCode === "ECONNREFUSED" && config.databaseMode === "embedded-postgres") {
      console.error(
        `Could not connect to embedded PostgreSQL on port ${config.embeddedPostgresPort}. Start the local server first or set DATABASE_URL to a reachable database.`,
      );
      process.exit(1);
    }
    throw error;
  } finally {
    await db?.$client.end().catch(() => {});
  }
}

void main();
