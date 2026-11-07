import { readDockerDatabaseReceipt, type DockerRun } from "./docker-postgres.js";
import { mkdir, mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { paperclipConfigSchema } from "../../packages/shared/src/config-schema.js";
import { reserveRunnerE2EDatabasePort } from "./ports.js";

/** Runtime instructions and native filesystem grants must use the same path. */
export async function createRunnerE2ETemporaryRoot(parent = os.tmpdir()) {
  return await realpath(await mkdtemp(path.join(parent, "paperclip-runner-e2e-")));
}

/** Seed only the disposable fixture. Onboarding preserves this validated config
 * and still creates the normal secrets and database. Restarts keep the same DB.
 */
export async function prepareRunnerE2EServerConfig(input: {
  temporaryRoot: string;
  configPath: string;
  serverPort: number;
  dockerReceiptPath?: string;
  dockerRun?: DockerRun;
}) {
  const docker = input.dockerReceiptPath ? await readDockerDatabaseReceipt(input.dockerReceiptPath, input.temporaryRoot, input.dockerRun) : undefined;
  try {
    const existing = JSON.parse(await readFile(input.configPath, "utf8"));
    if (docker ? existing.database?.mode !== "postgres" || existing.database.connectionString !== docker.connectionString : existing.database?.mode !== "embedded-postgres" || existing.database.connectionString) throw new Error("Existing runner database config differs from its explicit owned lane");
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const databaseReservation = docker ? null : await reserveRunnerE2EDatabasePort(input.serverPort);
  try {
    const instanceRoot = path.dirname(input.configPath);
    const config = paperclipConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: new Date().toISOString(),
        source: "onboard",
      },
      database: {
        mode: docker ? "postgres" : "embedded-postgres",
        ...(docker ? { connectionString: docker.connectionString } : {}),
        embeddedPostgresDataDir: path.join(instanceRoot, "db"),
        embeddedPostgresPort: databaseReservation?.port ?? 54329,
        backup: {
          enabled: false,
          dir: path.join(input.temporaryRoot, "backups"),
        },
      },
      logging: { mode: "file", logDir: path.join(instanceRoot, "logs") },
      server: {
        deploymentMode: "local_trusted",
        exposure: "private",
        bind: "loopback",
        host: "127.0.0.1",
        port: input.serverPort,
        serveUi: true,
      },
      storage: {
        provider: "local_disk",
        localDisk: { baseDir: path.join(input.temporaryRoot, "storage") },
      },
      secrets: {
        provider: "local_encrypted",
        strictMode: true,
        localEncrypted: {
          keyFilePath: path.join(instanceRoot, "secrets", "master.key"),
        },
      },
    });
    await mkdir(instanceRoot, { recursive: true, mode: 0o700 });
    await writeFile(input.configPath, `${JSON.stringify(config, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return databaseReservation;
  } catch (error) {
    await databaseReservation?.close();
    throw error;
  }
}
