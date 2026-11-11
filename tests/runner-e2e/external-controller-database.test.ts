import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createDb } from "../../packages/db/src/index.js";
import { createExternalControllerDatabase } from "./external-controller-database.js";
import { assertEmbeddedDatabaseIsolation } from "./instance-isolation.js";
import { createRunnerE2ETemporaryRoot } from "./server-config.js";
import { buildPaperclipServerEnvironment, buildRunnerE2EProcessEnvironment } from "./harness-env.js";

it("keeps the database administrator out of both child environments", () => {
  const source = { PAPERCLIP_RUNNER_E2E_POSTGRES_ADMIN_URL: "postgres://test-secret@localhost/postgres" };
  expect(buildRunnerE2EProcessEnvironment(source, []).PAPERCLIP_RUNNER_E2E_POSTGRES_ADMIN_URL).toBeUndefined();
  expect(buildPaperclipServerEnvironment(source).PAPERCLIP_RUNNER_E2E_POSTGRES_ADMIN_URL).toBeUndefined();
});

it("rejects a nonlocal administrator before creating a fixture", async () => {
  await expect(createExternalControllerDatabase({ adminUrl: "postgres://example.invalid/postgres",
    temporaryRoot: "/unused", configPath: "/unused/config.json", serverPort: 3100 }))
    .rejects.toThrow("explicit loopback test server");
});

it.skipIf(!process.env.PAPERCLIP_TEST_DATABASE_URL)("owns one empty database, rejects a changed binding, and deletes only that database", async () => {
  const root = await createRunnerE2ETemporaryRoot(), configPath = path.join(root, "instance", "config.json");
  const admin = createDb(process.env.PAPERCLIP_TEST_DATABASE_URL!, { maxConnections: 1 });
  let fixture: Awaited<ReturnType<typeof createExternalControllerDatabase>> | undefined;
  let client: ReturnType<typeof createDb> | undefined;
  try {
    fixture = await createExternalControllerDatabase({ adminUrl: process.env.PAPERCLIP_TEST_DATABASE_URL!,
      temporaryRoot: root, configPath, serverPort: 3100 });
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const name = new URL(config.database.connectionString).pathname.slice(1);
    expect(name).toMatch(/^runner_e2e_[a-f0-9]{32}$/);
    client = createDb(config.database.connectionString);
    expect(await client.$client`select tablename from pg_tables where schemaname = 'public'`).toEqual([]);
    await mkdir(path.dirname(config.secrets.localEncrypted.keyFilePath), { recursive: true });
    await writeFile(config.secrets.localEncrypted.keyFilePath, "fixture-key");
    await expect(assertEmbeddedDatabaseIsolation(configPath, root)).resolves.toBeUndefined();
    config.database.connectionString = process.env.PAPERCLIP_TEST_DATABASE_URL;
    await writeFile(configPath, JSON.stringify(config));
    await expect(assertEmbeddedDatabaseIsolation(configPath, root)).rejects.toThrow("fixture-owned database");
    await client.$client.end(); client = undefined;
    await fixture.cleanup();
    await fixture.cleanup();
    expect(await admin.$client`select datname from pg_database where datname=${name}`).toEqual([]);
    expect(await admin.$client`select current_database() as name`).toHaveLength(1);
  } finally {
    await client?.$client.end({ timeout: 1 });
    await fixture?.cleanup();
    await admin.$client.end({ timeout: 1 });
    await rm(root, { recursive: true, force: true });
  }
});
