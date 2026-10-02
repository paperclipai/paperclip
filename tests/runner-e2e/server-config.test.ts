import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { paperclipConfigSchema } from "../../packages/shared/src/config-schema.js";
import {
  reserveRunnerE2EDatabasePort,
  type LoopbackPortReservation,
} from "./ports.js";
import { prepareRunnerE2EServerConfig } from "./server-config.js";

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
});
