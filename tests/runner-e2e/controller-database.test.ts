import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";
import { createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "../../packages/db/src/index.js";
import { assertEmbeddedDatabaseIsolation } from "./instance-isolation.js";
import { prepareControllerDatabase } from "./controller-database.js";
import { createRunnerE2ETemporaryRoot, prepareRunnerE2EServerConfig } from "./server-config.js";

it("keeps an unmigrated fixture database alive when its serving client dies", async () => {
  const root = await createRunnerE2ETemporaryRoot();
  const configPath = path.join(root, "instance", "config.json");
  let database: Awaited<ReturnType<typeof prepareControllerDatabase>> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await (await prepareRunnerE2EServerConfig({ temporaryRoot: root, configPath, serverPort: 3100 }))!.close();
    database = await prepareControllerDatabase(configPath, root);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.database.mode).toBe("postgres");
    await mkdir(path.dirname(config.secrets.localEncrypted.keyFilePath), { recursive: true });
    await writeFile(config.secrets.localEncrypted.keyFilePath, "fixture-key");
    await expect(assertEmbeddedDatabaseIsolation(configPath, root)).resolves.toBeUndefined();
    db = createDb(config.database.connectionString);
    const before = await db.$client`select pg_postmaster_start_time()::text as started`;
    expect(await db.$client`select tablename from pg_tables where schemaname = 'public'`).toEqual([]);
    const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
    child = spawn(process.execPath, ["--input-type=module", "-e", `
      const { default: postgres } = await import(process.argv[1]);
      const sql = postgres(process.argv[2]);
      await sql.unsafe('select 1');
      process.stdout.write('connected');
      setInterval(() => {}, 1000);
    `, require.resolve("postgres"), config.database.connectionString], { stdio: ["ignore", "pipe", "pipe"] });
    let errors = "";
    child.stderr!.on("data", chunk => { errors += chunk; });
    const connected = await Promise.race([
      once(child.stdout!, "data").then(([chunk]) => String(chunk)),
      once(child, "exit").then(() => { throw new Error(`Database client exited before connection: ${errors}`); }),
    ]);
    expect(connected).toBe("connected");
    const stopped = once(child, "exit");
    child.kill("SIGKILL");
    await stopped;
    expect(await db.$client`select pg_postmaster_start_time()::text as started`).toEqual(before);
    await db.$client`create table replacement_probe (id integer primary key)`;
    await db.$client`insert into replacement_probe values (1)`;
    expect(await db.$client`select count(*)::integer as count from replacement_probe`).toEqual([{ count: 1 }]);
    await db.$client.end({ timeout: 1 }); db = undefined;
    await database.cleanup(); database = undefined;
    // The launcher grades isolation after the supervisor has shut down.
    await expect(assertEmbeddedDatabaseIsolation(configPath, root)).resolves.toBeUndefined();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

it("rejects database directories outside the fixture and leaves external databases alone", async () => {
  const root = await createRunnerE2ETemporaryRoot();
  const configPath = path.join(root, "config.json");
  try {
    await (await prepareRunnerE2EServerConfig({ temporaryRoot: root, configPath, serverPort: 3100 }))!.close();
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.database.embeddedPostgresDataDir = path.join(root, "..", "unrelated");
    await writeFile(configPath, JSON.stringify(config));
    await expect(prepareControllerDatabase(configPath, root)).rejects.toThrow("must belong to its qualification fixture");
    config.database.mode = "postgres";
    config.database.connectionString = "postgres://unused@127.0.0.1:1/never-connect";
    const encoded = JSON.stringify(config);
    await writeFile(configPath, encoded);
    await (await prepareControllerDatabase(configPath, root)).cleanup();
    expect(await readFile(configPath, "utf8")).toBe(encoded);
  } finally { await rm(root, { recursive: true, force: true }); }
});
