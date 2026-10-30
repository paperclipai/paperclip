import path from "node:path";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";

const CONTROLLER_DATABASE_OWNER_FILE = ".runner-e2e-controller-owner.json";

/** Written only after the supervisor has started this fixture's Postgres. */
export async function recordControllerDatabaseOwnership(input: {
  configPath: string; temporaryRoot: string; dataDirectory: string; connectionString: string;
}) {
  const temporaryRoot = await realpath(input.temporaryRoot);
  const dataDirectory = await realpath(input.dataDirectory);
  if (!dataDirectory.startsWith(`${temporaryRoot}${path.sep}`)) {
    throw new Error("Controller database path escaped its fixture-owned root");
  }
  await writeFile(path.join(dataDirectory, CONTROLLER_DATABASE_OWNER_FILE), JSON.stringify({
    version: 1, configPath: await realpath(input.configPath), temporaryRoot,
    dataDirectory, connectionString: input.connectionString,
  }), { mode: 0o600 });
}

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
      embeddedPostgresPort?: number;
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
  const supervised = config.database?.mode === "postgres";
  if (!config.database || (!supervised &&
    (config.database.mode !== "embedded-postgres" || config.database.connectionString))) {
    throw new Error("Runner E2E Paperclip instance did not use its fixture-owned database");
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
  if (supervised) {
    try {
      const root = await realpath(temporaryRoot);
      const directory = await realpath(databasePath);
      if (!directory.startsWith(`${root}${path.sep}`)) throw new Error("Database escaped fixture");
      const owner = JSON.parse(await readFile(path.join(directory, CONTROLLER_DATABASE_OWNER_FILE), "utf8"));
      const port = config.database.embeddedPostgresPort;
      const expectedConnection = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
      if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535
        || config.database.connectionString !== expectedConnection
        || owner.version !== 1 || owner.temporaryRoot !== root || owner.dataDirectory !== directory
        || owner.configPath !== await realpath(configPath) || owner.connectionString !== expectedConnection
        || !(await stat(path.join(directory, "PG_VERSION"))).isFile()) {
        throw new Error("Supervisor database ownership mismatch");
      }
    } catch (cause) {
      throw new Error("Runner E2E Paperclip instance did not use its fixture-owned database", { cause });
    }
  }
  const databaseStat = await stat(databasePath);
  if (!databaseStat.isDirectory())
    throw new Error("Embedded database path is not a directory");
  const keyStat = await stat(path.resolve(isolatedPaths.secretsKey!));
  if (!keyStat.isFile())
    throw new Error("Encrypted-secrets master key path is not a file");
}
