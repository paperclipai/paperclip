/** Launcher-owned disposable database. The admin credential never enters the
 * server/browser environment. Unknown remote cleanup keeps this database alive. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createDb } from "../../packages/db/src/index.js";
import { paperclipConfigSchema } from "../../packages/shared/src/config-schema.js";
import { recordControllerDatabaseOwnership } from "./instance-isolation.js";
import { prepareRunnerE2EServerConfig } from "./server-config.js";

export async function createExternalControllerDatabase(input: {
  adminUrl: string; temporaryRoot: string; configPath: string; serverPort: number;
}) {
  const url = new URL(input.adminUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("E2E Postgres administrator must use an explicit loopback test server");
  }
  await (await prepareRunnerE2EServerConfig(input))?.close();
  const config = paperclipConfigSchema.parse(JSON.parse(await readFile(input.configPath, "utf8")));
  if (config.database.mode !== "embedded-postgres") throw new Error("E2E database fixture already configured");
  const databaseName = `runner_e2e_${randomUUID().replaceAll("-", "")}`;
  const admin = createDb(input.adminUrl, { maxConnections: 1 });
  let created = false;
  const cleanup = async () => {
    if (!created) return;
    const connection = createDb(input.adminUrl, { maxConnections: 1 });
    try {
      // No FORCE: a remaining controller keeps its evidence and fails cleanup.
      await connection.$client.unsafe(`drop database "${databaseName}"`);
      created = false;
    } finally { await connection.$client.end({ timeout: 1 }); }
  };
  try {
    await admin.$client.unsafe(`create database "${databaseName}"`);
    created = true;
    url.pathname = `/${databaseName}`;
    config.database = { ...config.database, mode: "postgres", connectionString: url.toString() };
    await mkdir(config.database.embeddedPostgresDataDir, { recursive: true, mode: 0o700 });
    await recordControllerDatabaseOwnership({ ...input, dataDirectory: config.database.embeddedPostgresDataDir,
      connectionString: url.toString(), externalDatabaseName: databaseName });
    await writeFile(input.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return { cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  } finally { await admin.$client.end({ timeout: 1 }); }
}
