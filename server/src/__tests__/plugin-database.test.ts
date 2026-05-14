import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issueRelations,
  issues,
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
  pluginDatabaseService,
  validatePluginMigrationStatement,
  validatePluginRuntimeExecute,
  validatePluginRuntimeQuery,
} from "../services/plugin-database.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin database tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("plugin database SQL validation", () => {
  it("allows namespace migrations with whitelisted public foreign keys", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE TABLE plugin_test.rows (id uuid PRIMARY KEY, issue_id uuid REFERENCES public.issues(id))",
        "plugin_test",
        ["issues"],
      )
    ).not.toThrow();
  });

  it("rejects migrations that create public objects", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE TABLE public.rows (id uuid PRIMARY KEY)",
        "plugin_test",
        ["issues"],
      )
    ).toThrow(/public/i);
  });

  it("allows whitelisted runtime reads but rejects public writes", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT r.id FROM plugin_test.rows r JOIN public.issues i ON i.id = r.issue_id",
        "plugin_test",
        ["issues"],
      )
    ).not.toThrow();
    expect(() =>
      validatePluginRuntimeExecute("UPDATE public.issues SET title = $1", "plugin_test")
    ).toThrow(/namespace/i);
  });

  it("targets anonymous DO blocks without rejecting do-prefixed aliases", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT EXTRACT(DOW FROM created_at) AS do_flag FROM plugin_test.rows",
        "plugin_test",
      )
    ).not.toThrow();
    expect(() =>
      validatePluginMigrationStatement("DO $$ BEGIN END $$;", "plugin_test")
    ).toThrow(/disallowed/i);
  });
});

describeEmbeddedPostgres("plugin database namespaces", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let packageRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-db-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (const pluginKey of ["paperclip.dbtest", "paperclip.escape"]) {
      const namespace = derivePluginDatabaseNamespace(pluginKey);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`));
    }
    await db.delete(pluginMigrations);
    await db.delete(pluginDatabaseNamespaces);
    await db.delete(plugins);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(companies);
    await Promise.all(packageRoots.map((root) => rm(root, { recursive: true, force: true })));
    packageRoots = [];
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createPluginPackage(manifest: PaperclipPluginManifestV1, migrationSql: string) {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-package-"));
    packageRoots.push(packageRoot);
    const migrationsDir = path.join(packageRoot, manifest.database!.migrationsDir);
    await mkdir(migrationsDir, { recursive: true });
    await writeFile(path.join(migrationsDir, "001_init.sql"), migrationSql, "utf8");
    return packageRoot;
  }

  async function installPluginRecord(manifest: PaperclipPluginManifestV1) {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: manifest.id,
      packageName: manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      categories: manifest.categories,
      manifestJson: manifest,
      status: "installed",
      installOrder: 1,
    });
    return pluginId;
  }

  function manifest(pluginKey = "paperclip.dbtest"): PaperclipPluginManifestV1 {
    return {
      id: pluginKey,
      apiVersion: 1,
      version: "1.0.0",
      displayName: "DB Test",
      description: "Exercises restricted plugin database access.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: [
        "database.namespace.migrate",
        "database.namespace.read",
        "database.namespace.write",
      ],
      entrypoints: { worker: "./dist/worker.js" },
      database: {
        migrationsDir: "migrations",
        coreReadTables: ["issues"],
      },
    };
  }

  it("applies migrations once and allows whitelisted core joins at runtime", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `
      CREATE TABLE ${namespace}.mission_rows (
        id uuid PRIMARY KEY,
        issue_id uuid NOT NULL REFERENCES public.issues(id),
        label text NOT NULL
      );
      `,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Joined issue",
      status: "todo",
      priority: "medium",
      identifier: "TST-1",
    });

    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);

    await pluginDb.execute(
      pluginId,
      `INSERT INTO ${namespace}.mission_rows (id, issue_id, label) VALUES ($1, $2, $3)`,
      [randomUUID(), issueId, "alpha"],
    );
    const rows = await pluginDb.query<{ label: string; title: string }>(
      pluginId,
      `SELECT m.label, i.title FROM ${namespace}.mission_rows m JOIN public.issues i ON i.id = m.issue_id`,
    );
    expect(rows).toEqual([{ label: "alpha", title: "Joined issue" }]);

    const migrations = await db
      .select()
      .from(pluginMigrations)
      .where(and(eq(pluginMigrations.pluginId, pluginId), eq(pluginMigrations.status, "applied")));
    expect(migrations).toHaveLength(1);
  });

  it("rejects runtime writes to public core tables", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.notes (id uuid PRIMARY KEY, body text NOT NULL);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);

    await expect(
      pluginDb.execute(pluginId, "UPDATE public.issues SET title = $1", ["bad"]),
    ).rejects.toThrow(/plugin namespace/i);
  });

  it("records a failed migration when SQL escapes the plugin namespace", async () => {
    const pluginManifest = manifest("paperclip.escape");
    const packageRoot = await createPluginPackage(
      pluginManifest,
      "CREATE TABLE public.plugin_escape (id uuid PRIMARY KEY);",
    );
    const pluginId = await installPluginRecord(pluginManifest);

    await expect(
      pluginDatabaseService(db).applyMigrations(pluginId, pluginManifest, packageRoot),
    ).rejects.toThrow(/public\.plugin_escape|public/i);

    const [migration] = await db
      .select()
      .from(pluginMigrations)
      .where(eq(pluginMigrations.pluginId, pluginId));
    expect(migration?.status).toBe("failed");
  });

  it("rejects checksum changes for already applied migrations", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.checksum_rows (id uuid PRIMARY KEY);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);

    await writeFile(
      path.join(packageRoot, "migrations", "001_init.sql"),
      `CREATE TABLE ${namespace}.checksum_rows (id uuid PRIMARY KEY, note text);`,
      "utf8",
    );

    await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
      .rejects.toThrow(/checksum mismatch/i);
  });
});
