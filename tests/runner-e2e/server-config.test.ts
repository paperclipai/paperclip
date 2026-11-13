import { mkdir, mkdtemp, realpath, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { paperclipConfigSchema } from "../../packages/shared/src/config-schema.js";
import {
  reserveRunnerE2EDatabasePort,
  type LoopbackPortReservation,
} from "./ports.js";
import { createRunnerE2ETemporaryRoot, prepareRunnerE2EServerConfig, prepareSupervisorServerConfig } from "./server-config.js";
import { recordControllerDatabaseOwnership } from "./instance-isolation.js";

const roots: string[] = [];
const reservations: LoopbackPortReservation[] = [];
afterEach(async () => {
  await Promise.all(
    reservations.splice(0).map((reservation) => reservation.close()),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("isolated paid E2E database ports", () => {
  it("uses a physical temporary root when the host temp directory has an alias", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "e2e-temp-alias-")));
    roots.push(parent);
    const physical = path.join(parent, "physical");
    const alias = path.join(parent, "alias");
    await mkdir(physical);
    await symlink(physical, alias);
    const root = await createRunnerE2ETemporaryRoot(alias);
    expect(root).toBe(await realpath(root));
    expect(path.dirname(root)).toBe(physical);
  });

  it("keeps parallel database reservations distinct and held until server spawn", async () => {
    reservations.push(
      ...(await Promise.all(
        Array.from({ length: 8 }, () => reserveRunnerE2EDatabasePort(3100)),
      )),
    );
    expect(new Set(reservations.map(({ port }) => port)).size).toBe(8);
    const contender = createServer();
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      contender.once("error", resolve);
      contender.listen(reservations[0].port, "127.0.0.1");
    });
    expect(error.code).toBe("EADDRINUSE");
  });

  it("rejects the HTTP/HMR ports and retains only the selected reservation", async () => {
    const closed: number[] = [];
    const ports = [3100, 13100, 41000];
    const selected = await reserveRunnerE2EDatabasePort(3100, {
      openPort: async () => {
        const port = ports.shift()!;
        return {
          port,
          close: async () => {
            closed.push(port);
          },
        };
      },
    });
    expect(selected.port).toBe(41000);
    expect(closed).toEqual([3100, 13100]);
    await selected.close();
    expect(closed).toEqual([3100, 13100, 41000]);
  });

  it("writes a valid private config and preserves its database on restart", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "runner-e2e-config-test-"),
    );
    roots.push(temporaryRoot);
    const configPath = path.join(
      temporaryRoot,
      "paperclip-home",
      "instances",
      "fixture",
      "config.json",
    );
    const input = { temporaryRoot, configPath, serverPort: 3100 };
    const reservation = await prepareRunnerE2EServerConfig(input);
    expect(reservation).not.toBeNull();
    reservations.push(reservation!);
    const encoded = await readFile(configPath, "utf8");
    const config = paperclipConfigSchema.parse(JSON.parse(encoded));
    expect(config.database.embeddedPostgresPort).toBe(reservation!.port);
    expect(config.database.mode).toBe("embedded-postgres");
    for (const directory of [
      config.database.embeddedPostgresDataDir,
      config.database.backup.dir,
      config.logging.logDir,
      config.storage.localDisk.baseDir,
      config.secrets.localEncrypted.keyFilePath,
    ])
      expect(directory.startsWith(`${temporaryRoot}/`)).toBe(true);
    expect(config.secrets.strictMode).toBe(true);
    expect(await prepareRunnerE2EServerConfig(input)).toBeNull();
    expect(await readFile(configPath, "utf8")).toBe(encoded);
  });

  it("keeps a launcher-owned external database and rejects an unowned one", async () => {
    const temporaryRoot = await createRunnerE2ETemporaryRoot();
    roots.push(temporaryRoot);
    const configPath = path.join(temporaryRoot, "paperclip-home", "instances", "fixture", "config.json");
    const input = { temporaryRoot, configPath, serverPort: 3100 };
    reservations.push((await prepareRunnerE2EServerConfig(input))!);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const name = `runner_e2e_${"a".repeat(32)}`, connectionString = `postgres://fixture@127.0.0.1:5432/${name}`;
    config.database = { ...config.database, mode: "postgres", connectionString };
    await writeFile(configPath, JSON.stringify(config));
    await mkdir(config.database.embeddedPostgresDataDir, { recursive: true });
    await expect(prepareSupervisorServerConfig({ ...input, database: {} })).rejects.toThrow("explicit owned lane");
    await recordControllerDatabaseOwnership({ configPath, temporaryRoot, dataDirectory: config.database.embeddedPostgresDataDir,
      connectionString, externalDatabaseName: name });
    await expect(prepareSupervisorServerConfig({ ...input, database: {} })).resolves.toBeNull();
    config.database.connectionString = "postgres://fixture@127.0.0.1:5432/postgres";
    await writeFile(configPath, JSON.stringify(config));
    await expect(prepareSupervisorServerConfig({ ...input, database: {} })).rejects.toThrow("explicit owned lane");
  });
});
