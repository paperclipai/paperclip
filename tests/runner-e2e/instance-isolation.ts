import path from "node:path";
import { readFile, stat } from "node:fs/promises";

export async function assertEmbeddedDatabaseIsolation(
  configPath: string,
  temporaryRoot: string,
) {
  const configText = await readFile(configPath, "utf8");
  const config = JSON.parse(configText) as {
    database?: {
      mode?: string;
      connectionString?: string;
      embeddedPostgresDataDir?: string;
      backup?: { dir?: string };
    };
    logging?: { logDir?: string };
    storage?: {
      provider?: string;
      localDisk?: { baseDir?: string };
    };
    secrets?: {
      provider?: string;
      strictMode?: boolean;
      localEncrypted?: { keyFilePath?: string };
    };
  };
  if (
    config.database?.mode !== "embedded-postgres" ||
    config.database.connectionString
  ) {
    throw new Error(
      "Runner E2E Paperclip instance did not use its embedded database",
    );
  }
  if (
    config.storage?.provider !== "local_disk" ||
    config.secrets?.provider !== "local_encrypted" ||
    config.secrets.strictMode !== true
  ) {
    throw new Error(
      "Runner E2E instance did not use isolated local storage and strict encrypted secrets",
    );
  }
  const isolatedPaths = {
    database: config.database.embeddedPostgresDataDir,
    backup: config.database.backup?.dir,
    logs: config.logging?.logDir,
    storage: config.storage.localDisk?.baseDir,
    secretsKey: config.secrets.localEncrypted?.keyFilePath,
  };
  for (const [label, configuredPath] of Object.entries(isolatedPaths)) {
    if (!configuredPath) {
      throw new Error(`Runner E2E config omitted its ${label} path`);
    }
    const resolved = path.resolve(configuredPath);
    if (!resolved.startsWith(`${temporaryRoot}${path.sep}`)) {
      throw new Error(
        `Runner E2E ${label} path escaped the isolated root: ${resolved}`,
      );
    }
  }
  const databasePath = path.resolve(isolatedPaths.database!);
  const databaseStat = await stat(databasePath);
  if (!databaseStat.isDirectory())
    throw new Error("Embedded database path is not a directory");
  const keyStat = await stat(path.resolve(isolatedPaths.secretsKey!));
  if (!keyStat.isFile())
    throw new Error("Encrypted-secrets master key path is not a file");
}
