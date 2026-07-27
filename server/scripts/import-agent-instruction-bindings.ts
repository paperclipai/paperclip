import { and, eq } from "drizzle-orm";
import { agents, builtInManagedResources, createDb } from "@paperclipai/db";
import { resolveDatabaseTarget } from "../../packages/db/src/runtime-config.js";
import { agentInstructionsService } from "../src/services/agent-instructions.js";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function main() {
  const target = resolveDatabaseTarget();
  const dbUrl = target.mode === "postgres"
    ? target.connectionString
    : `postgres://paperclip:paperclip@127.0.0.1:${target.port}/paperclip`;
  const apply = process.argv.includes("--apply");
  const db = createDb(dbUrl);
  const instructions = agentInstructionsService(db);
  let imported = 0;
  let skippedExternal = 0;
  let skippedEmpty = 0;
  let alreadyBound = 0;

  for (const agent of await db.select().from(agents)) {
    const config = asRecord(agent.adapterConfig);
    if (config.instructionsBundleMode === "external") {
      skippedExternal += 1;
      continue;
    }
    const existing = await db.select({ id: builtInManagedResources.id }).from(builtInManagedResources).where(and(
      eq(builtInManagedResources.companyId, agent.companyId),
      eq(builtInManagedResources.resourceKind, "instructions"),
      eq(builtInManagedResources.resourceId, agent.id),
    )).then((rows) => rows[0] ?? null);
    if (existing) {
      alreadyBound += 1;
      continue;
    }
    const bundle = await instructions.exportFiles(agent);
    if (Object.keys(bundle.files).length === 0) {
      skippedEmpty += 1;
      continue;
    }
    if (apply) await instructions.persistManagedBundle(agent, bundle.entryFile, bundle.files);
    imported += 1;
  }

  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", imported, alreadyBound, skippedExternal, skippedEmpty }, null, 2));
  process.exit(0);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
