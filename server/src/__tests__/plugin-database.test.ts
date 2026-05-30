import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { buildPluginWorkerEnv, pluginLoader } from "../services/plugin-loader.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const multiMigrationPluginKey = "paperclip.dbfixture";

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

describe("buildPluginWorkerEnv", () => {
  const instanceInfo = {
    deploymentMode: "authenticated",
    deploymentExposure: "public",
  };

  it("passes only model provider keys through to environment driver plugins", () => {
    const env = buildPluginWorkerEnv({
      manifest: { capabilities: ["environment.drivers.register"] },
      instanceInfo,
      processEnv: {
        ANTHROPIC_API_KEY: "anthropic-token",
        OPENAI_API_KEY: "openai-token",
        GEMINI_API_KEY: " ",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
      ANTHROPIC_API_KEY: "anthropic-token",
      OPENAI_API_KEY: "openai-token",
    });
  });

  it("does not pass provider keys to non-environment plugins", () => {
    const env = buildPluginWorkerEnv({
      manifest: { capabilities: ["ui.slots.register"] },
      instanceInfo,
      processEnv: {
        OPENAI_API_KEY: "openai-token",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
    });
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
    for (const pluginKey of ["paperclip.dbtest", "paperclip.escape", "paperclip.refresh", multiMigrationPluginKey]) {
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

  async function createInstallablePluginPackage(
    pluginManifest: PaperclipPluginManifestV1,
    migrationSql: string,
  ) {
    const packageRoot = await createPluginPackage(pluginManifest, migrationSql);
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: pluginManifest.id,
        version: pluginManifest.version,
        type: "module",
        paperclipPlugin: { manifest: "./manifest.js" },
      }),
      "utf8",
    );
    await writeFile(
      path.join(packageRoot, "manifest.js"),
      `export default ${JSON.stringify(pluginManifest, null, 2)};\n`,
      "utf8",
    );
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await writeFile(path.join(packageRoot, "dist", "worker.js"), "export {};\n", "utf8");
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

  it("applies multi-file plugin migrations through the production validator", async () => {
    const pluginManifest = manifest(multiMigrationPluginKey);
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.source_rows (id uuid PRIMARY KEY, label text NOT NULL);`,
    );
    await writeFile(
      path.join(packageRoot, pluginManifest.database!.migrationsDir, "002_derived.sql"),
      `CREATE TABLE ${namespace}.derived_rows (
        id uuid PRIMARY KEY,
        source_id uuid NOT NULL REFERENCES ${namespace}.source_rows(id)
      );`,
      "utf8",
    );
    const pluginId = await installPluginRecord(pluginManifest);
    await pluginDatabaseService(db).applyMigrations(pluginId, pluginManifest, packageRoot);

    const migrations = await db
      .select()
      .from(pluginMigrations)
      .where(and(eq(pluginMigrations.pluginId, pluginId), eq(pluginMigrations.status, "applied")));
    expect(migrations).toHaveLength(2);
  });

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

  it("rolls back plugin install when migration validation fails", async () => {
    const pluginManifest = manifest("paperclip.escape");
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createInstallablePluginPackage(
      pluginManifest,
      "CREATE TABLE public.plugin_escape (id uuid PRIMARY KEY);",
    );
    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    await expect(loader.installPlugin({ localPath: packageRoot }))
      .rejects.toThrow(/public\.plugin_escape|public/i);

    const installedPlugins = await db
      .select()
      .from(plugins)
      .where(eq(plugins.pluginKey, pluginManifest.id));
    const namespaces = await db
      .select()
      .from(pluginDatabaseNamespaces)
      .where(eq(pluginDatabaseNamespaces.pluginKey, pluginManifest.id));
    const migrations = await db
      .select()
      .from(pluginMigrations)
      .where(eq(pluginMigrations.pluginKey, pluginManifest.id));
    const schemaRows = Array.from(
      await db.execute(
        sql<{ schema_name: string }>`SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${namespace}`,
      ) as Iterable<{ schema_name: string }>,
    );

    expect(installedPlugins).toHaveLength(0);
    expect(namespaces).toHaveLength(0);
    expect(migrations).toHaveLength(0);
    expect(schemaRows).toHaveLength(0);
  });

  it("refreshes persisted manifests from disk before activation", async () => {
    const staleManifest = manifest("paperclip.refresh");
    const refreshedManifest: PaperclipPluginManifestV1 = {
      ...staleManifest,
      database: {
        ...staleManifest.database!,
        coreReadTables: ["companies"],
      },
    };
    const namespace = derivePluginDatabaseNamespace(refreshedManifest.id);
    const packageRoot = await createInstallablePluginPackage(
      refreshedManifest,
      `
      CREATE TABLE ${namespace}.company_refs (
        id uuid PRIMARY KEY,
        company_id uuid NOT NULL REFERENCES public.companies(id)
      );
      `,
    );
    const pluginId = await installPluginRecord(staleManifest);
    await db
      .update(plugins)
      .set({
        packagePath: packageRoot,
        status: "ready",
      })
      .where(eq(plugins.id, pluginId));

    const workerManager = {
      startWorker: vi.fn().mockResolvedValue(undefined),
      stopAll: vi.fn().mockResolvedValue(undefined),
    };
    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    }, {
      workerManager,
      eventBus: {
        forPlugin: vi.fn(() => ({})),
        subscriptionCount: vi.fn(() => 0),
      },
      jobScheduler: {
        registerPlugin: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
      },
      jobStore: {
        syncJobDeclarations: vi.fn().mockResolvedValue(undefined),
      },
      toolDispatcher: {
        registerPluginTools: vi.fn(),
      },
      lifecycleManager: {
        markError: vi.fn().mockResolvedValue(undefined),
      },
      buildHostHandlers: vi.fn(() => ({})),
      instanceInfo: {
        instanceId: "test-instance",
        hostVersion: "1.0.0",
        deploymentMode: "authenticated",
        deploymentExposure: "public",
      },
    } as never);

    const result = await loader.loadSingle(pluginId);

    expect(result.success).toBe(true);
    expect(workerManager.startWorker).toHaveBeenCalledWith(
      pluginId,
      expect.objectContaining({
        databaseNamespace: namespace,
        env: {
          PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
          PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
        },
        manifest: expect.objectContaining({
          database: expect.objectContaining({ coreReadTables: ["companies"] }),
        }),
      }),
    );
    const [plugin] = await db
      .select()
      .from(plugins)
      .where(eq(plugins.id, pluginId));
    expect(plugin?.manifestJson.database?.coreReadTables).toEqual(["companies"]);
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
