import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DrizzleQueryError, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  pluginDatabaseNamespaces,
  pluginMigrations,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  derivePluginDatabaseNamespace,
  describePluginSqlError,
  pluginDatabaseService,
} from "../services/plugin-database.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const pluginKey = "paperclip.dberrors";
const secretParam = "secret-param-value-7f3a";

function postgresError(code: string, message: string) {
  return Object.assign(new Error(message), {
    name: "PostgresError",
    severity: "ERROR",
    code,
    detail: `Key (slug)=(${secretParam}) already exists.`,
  });
}

describe("describePluginSqlError", () => {
  const statement = "INSERT INTO plugin_x.rows (slug) VALUES ($1)";

  it("adds the Postgres SQLSTATE and message and drops the bound parameters", () => {
    const error = new DrizzleQueryError(
      statement,
      [secretParam],
      postgresError("23505", 'duplicate key value violates unique constraint "rows_slug_key"'),
    );

    const described = describePluginSqlError(error, statement) as Error;

    expect(described.message).toBe(
      `Failed query: ${statement}\nSQLSTATE 23505: duplicate key value violates unique constraint "rows_slug_key"`,
    );
    expect(described.message).not.toContain(secretParam);
    expect(described.message).not.toContain("params:");
    expect((described as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("finds the Postgres error further down the cause chain", () => {
    const wrapped = new Error("outer", {
      cause: new DrizzleQueryError(statement, [secretParam], postgresError("42P10", "there is no unique or exclusion constraint matching the ON CONFLICT specification")),
    });

    expect((describePluginSqlError(wrapped, statement) as Error).message).toBe(
      `Failed query: ${statement}\nSQLSTATE 42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification`,
    );
  });

  it("strips the parameters from a failed query that has no Postgres cause", () => {
    const error = new DrizzleQueryError(statement, [secretParam], new Error("write EPIPE"));

    const described = describePluginSqlError(error, statement) as Error;

    expect(described.message).toBe(`Failed query: ${statement}`);
    expect(described.message).not.toContain(secretParam);
  });

  it("leaves other errors untouched", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(describePluginSqlError(error, statement)).toBe(error);
  });

  it("stops on a cyclic cause chain", () => {
    const error = new Error("loop") as Error & { cause?: unknown };
    error.cause = error;
    expect(describePluginSqlError(error, statement)).toBe(error);
  });
});

describeEmbeddedPostgres("plugin ctx.db errors", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let packageRoot: string | null = null;
  const namespace = derivePluginDatabaseNamespace(pluginKey);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-db-errors-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`));
    await db.delete(pluginMigrations);
    await db.delete(pluginDatabaseNamespaces);
    await db.delete(plugins);
    if (packageRoot) await rm(packageRoot, { recursive: true, force: true });
    packageRoot = null;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function installPlugin() {
    const manifest: PaperclipPluginManifestV1 = {
      id: pluginKey,
      apiVersion: 1,
      version: "1.0.0",
      displayName: "DB Errors",
      description: "Exercises plugin database error reporting.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: [
        "database.namespace.migrate",
        "database.namespace.read",
        "database.namespace.write",
      ],
      entrypoints: { worker: "./dist/worker.js" },
      database: { migrationsDir: "migrations", coreReadTables: [] },
    };
    packageRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-db-errors-"));
    await mkdir(path.join(packageRoot, "migrations"), { recursive: true });
    await writeFile(
      path.join(packageRoot, "migrations", "001_init.sql"),
      `CREATE TABLE ${namespace}.rows (id uuid PRIMARY KEY, slug text NOT NULL UNIQUE);`,
      "utf8",
    );
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: pluginKey,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      categories: manifest.categories,
      manifestJson: manifest,
      status: "installed",
      installOrder: 1,
    });
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, manifest, packageRoot);
    return { pluginId, pluginDb };
  }

  it("reports the SQLSTATE and Postgres message from ctx.db.execute without the parameters", async () => {
    const { pluginId, pluginDb } = await installPlugin();
    const insert = `INSERT INTO ${namespace}.rows (id, slug) VALUES ($1, $2)`;
    await pluginDb.execute(pluginId, insert, [randomUUID(), secretParam]);

    const failure = await pluginDb.execute(pluginId, insert, [randomUUID(), secretParam])
      .then(() => null, (error: unknown) => error as Error);

    expect(failure?.message).toBe(
      `Failed query: ${insert}\nSQLSTATE 23505: duplicate key value violates unique constraint "rows_slug_key"`,
    );
    expect(failure?.message).not.toContain(secretParam);
  });

  it("reports the SQLSTATE and Postgres message from ctx.db.query", async () => {
    const { pluginId, pluginDb } = await installPlugin();
    const select = `SELECT missing_column FROM ${namespace}.rows WHERE slug = $1`;

    const failure = await pluginDb.query(pluginId, select, [secretParam])
      .then(() => null, (error: unknown) => error as Error);

    expect(failure?.message).toBe(
      `Failed query: ${select}\nSQLSTATE 42703: column "missing_column" does not exist`,
    );
    expect(failure?.message).not.toContain(secretParam);
  });
});
