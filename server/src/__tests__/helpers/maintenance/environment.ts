import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getEmbeddedPostgresTestSupport, type EmbeddedPostgresTestSupport } from "../embedded-postgres.js";

export async function maintenanceDatabaseSupport(databaseUrl?: string): Promise<EmbeddedPostgresTestSupport> {
  return databaseUrl ? { supported: true } : getEmbeddedPostgresTestSupport();
}

export async function createMaintenanceArtifacts(root = tmpdir()) {
  const directory = await mkdtemp(path.join(root, "paperclip-maintenance-"));
  const retainedDirectory = process.env.PAPERCLIP_MAINTENANCE_KEEP_ARTIFACTS === "1" ? directory : undefined;
  let disposal: Promise<void> | undefined;
  return {
    directory,
    retainedDirectory,
    dispose() {
      return disposal ??= (async () => {
        if (retainedDirectory) process.stdout.write(`[maintenance-test] retained artifacts: ${retainedDirectory}\n`);
        else await rm(directory, { recursive: true, force: true });
      })();
    },
  };
}
