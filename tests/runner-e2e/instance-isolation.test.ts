import path from "node:path";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { assertEmbeddedDatabaseIsolation } from "./instance-isolation.js";
import { createRunnerE2ETemporaryRoot, prepareRunnerE2EServerConfig } from "./server-config.js";

it.each(["owned", "missing-receipt", "foreign-connection", "wrong-port", "foreign-owner", "escaped-database"])(
  "checks the supervisor-owned database after the serving process exits: %s", async variant => {
    const root = await createRunnerE2ETemporaryRoot();
    const configPath = path.join(root, "instance", "config.json");
    const outside = await createRunnerE2ETemporaryRoot();
    try {
      await (await prepareRunnerE2EServerConfig({ temporaryRoot: root, configPath, serverPort: 3100 }))!.close();
      const config = JSON.parse(await readFile(configPath, "utf8"));
      const directory = config.database.embeddedPostgresDataDir;
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "PG_VERSION"), "18\n");
      await mkdir(path.dirname(config.secrets.localEncrypted.keyFilePath), { recursive: true });
      await writeFile(config.secrets.localEncrypted.keyFilePath, "fixture-key");
      config.database.mode = "postgres";
      config.database.connectionString = `postgres://paperclip:paperclip@127.0.0.1:${config.database.embeddedPostgresPort}/paperclip`;
      const receipt = { version: 1, configPath, temporaryRoot: root, dataDirectory: directory,
        connectionString: config.database.connectionString };
      if (variant === "foreign-owner") receipt.temporaryRoot = outside;
      if (variant !== "missing-receipt") await writeFile(path.join(directory, ".runner-e2e-controller-owner.json"), JSON.stringify(receipt));
      if (variant === "foreign-connection") config.database.connectionString = "postgres://paperclip:paperclip@db.example.invalid:5432/paperclip";
      if (variant === "wrong-port") config.database.embeddedPostgresPort += 1;
      if (variant === "escaped-database") {
        await rm(directory, { recursive: true });
        await symlink(outside, directory, "dir");
      }
      await writeFile(configPath, JSON.stringify(config));
      if (variant === "owned") await expect(assertEmbeddedDatabaseIsolation(configPath, root)).resolves.toBeUndefined();
      else await expect(assertEmbeddedDatabaseIsolation(configPath, root)).rejects.toThrow(/fixture-owned|escaped|embedded database/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  },
);
