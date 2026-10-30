import { readDockerDatabaseReceipt, type DockerRun } from "./docker-postgres.js";
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

export async function assertRunnerDatabaseIsolation(
  configPath: string,
  temporaryRoot: string,
  dockerReceiptPath?: string,
  dockerRun?: DockerRun,
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
  const docker = dockerReceiptPath ? await readDockerDatabaseReceipt(dockerReceiptPath, temporaryRoot, dockerRun) : undefined;
  if (docker ? config.database?.mode !== "postgres" || config.database.connectionString !== docker.connectionString : config.database?.mode !== "embedded-postgres" || !!config.database.connectionString) {
    throw new Error("Runner E2E Paperclip instance did not use its explicitly owned database lane");
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
    ...(docker ? {} : { database: config.database!.embeddedPostgresDataDir }),
    backup: config.database!.backup?.dir,
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
  if (!docker) {
    const databasePath = path.resolve(isolatedPaths.database!);
    const databaseStat = await stat(databasePath);
    if (!databaseStat.isDirectory()) throw new Error("Embedded database path is not a directory");
  }
  const keyStat = await stat(path.resolve(isolatedPaths.secretsKey!));
  if (!keyStat.isFile())
    throw new Error("Encrypted-secrets master key path is not a file");
}

/** Compatibility entry point remains embedded-only, never ambient external DB. */
export async function assertEmbeddedDatabaseIsolation(configPath: string, temporaryRoot: string) { return assertRunnerDatabaseIsolation(configPath, temporaryRoot); }
