/** Qualification owns Postgres outside the server process tree. No migrations
 * run here: each serving artifact must apply its own schema on startup. */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createEmbeddedPostgresLogBuffer, ensurePostgresDatabase, loadWithoutEmbeddedPostgresExitHooks,
  prepareEmbeddedPostgresNativeRuntime } from "../../packages/db/src/index.js";
import { recordControllerDatabaseOwnership } from "./instance-isolation.js";
import { paperclipConfigSchema } from "../../packages/shared/src/config-schema.js";

export async function prepareControllerDatabase(configPath: string, temporaryRoot: string) {
  const config = paperclipConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  if (config.database.mode === "postgres") return { cleanup: async () => {} };
  const directory = path.resolve(config.database.embeddedPostgresDataDir);
  const relative = path.relative(path.resolve(temporaryRoot), directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Controller database must belong to its qualification fixture");
  const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const module = await loadWithoutEmbeddedPostgresExitHooks(() => import(pathToFileURL(require.resolve("embedded-postgres")).href));
  await prepareEmbeddedPostgresNativeRuntime();
  const logs = createEmbeddedPostgresLogBuffer();
  const database = new module.default({ databaseDir: directory, user: "paperclip", password: "paperclip",
    port: config.database.embeddedPostgresPort, persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: (message: unknown) => logs.append(message), onError: (message: unknown) => logs.append(message) });
  let started = false;
  try {
    if (!existsSync(path.join(directory, "PG_VERSION"))) await database.initialise();
    await database.start();
    started = true;
    const base = `postgres://paperclip:paperclip@127.0.0.1:${config.database.embeddedPostgresPort}`;
    await ensurePostgresDatabase(`${base}/postgres`, "paperclip");
    await recordControllerDatabaseOwnership({ configPath, temporaryRoot, dataDirectory: directory,
      connectionString: `${base}/paperclip` });
    config.database = { ...config.database, mode: "postgres", connectionString: `${base}/paperclip` };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return { cleanup: async () => { await database.stop(); } };
  } catch (error) {
    if (started) await database.stop().catch(() => undefined);
    throw new Error(`Qualification database startup failed: ${logs.getRecentLogs().join(" | ")}`, { cause: error });
  }
}
