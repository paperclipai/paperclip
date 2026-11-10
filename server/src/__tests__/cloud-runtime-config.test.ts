import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations, closeRegisteredClients, createDb, instanceSettings, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { paperclipConfigSchema } from "@paperclipai/shared";
import { loadCloudBootstrapConfig, loadConfig } from "../config.js";
import { readConfigFile } from "../config-file.js";
import {
  CLOUD_RUNTIME_CONFIG_KEY,
  cloudRuntimeConfigService,
  initializeCloudRuntimeConfig,
  readLegacyCloudRuntimeConfig,
} from "../services/cloud-runtime-config.js";
import {
  getCloudRuntimeConfigSnapshot,
  projectCloudRuntimeConfig,
  setCloudRuntimeConfigSnapshot,
} from "../services/cloud-runtime-config-snapshot.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const externalDatabaseUrl = process.env.PAPERCLIP_RUNTIME_CONFIG_TEST_DATABASE_URL;
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
let home: string;
let configPath: string;

function legacyConfig() {
  return {
    $meta: { version: 1, updatedAt: "2026-10-30T00:00:00.000Z", source: "configure" },
    llm: { provider: "openai", apiKey: "legacy-openai-secret" },
    database: {
      mode: "postgres",
      connectionString: "postgres://legacy:database-secret@example.test/paperclip",
      backup: { enabled: false, intervalMinutes: 73, retentionDays: 11, dir: "/tmp/legacy-backups" },
    },
    logging: { mode: "cloud", logDir: "/tmp/legacy-logs" },
    server: { deploymentMode: "authenticated", exposure: "private", port: 3210, serveUi: false, allowedHostnames: ["saved.example.test"] },
    auth: { baseUrlMode: "explicit", publicBaseUrl: "https://saved.example.test", disableSignUp: true },
    storage: { provider: "s3", s3: { bucket: "saved-bucket", region: "eu-west-1", prefix: "saved/", forcePathStyle: true } },
    secrets: { provider: "local_encrypted", strictMode: true, localEncrypted: { keyFilePath: "/tmp/legacy-master.key" } },
    telemetry: { enabled: false },
    updates: { checkEnabled: false },
    unsupportedSecret: "unknown-secret-value",
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-runtime-config-"));
  configPath = path.join(home, "config.json");
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_CONFIG", configPath);
  vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "test-token");
  vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
  vi.stubEnv("DATABASE_MIGRATION_URL", undefined);
  vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", undefined);
  vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", undefined);
  vi.stubEnv("PAPERCLIP_AUTH_BASE_URL_MODE", undefined);
  vi.stubEnv("PAPERCLIP_PUBLIC_URL", undefined);
  vi.stubEnv("BETTER_AUTH_URL", undefined);
  vi.stubEnv("BETTER_AUTH_BASE_URL", undefined);
  vi.stubEnv("PAPERCLIP_ALLOWED_HOSTNAMES", undefined);
  vi.stubEnv("PAPERCLIP_TAILNET_BIND_HOST", "100.100.0.1");
  vi.stubEnv("OPENAI_API_KEY", "environment-api-secret");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "12345678901234567890123456789012");
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", undefined);
  vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", undefined);
  setCloudRuntimeConfigSnapshot(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setCloudRuntimeConfigSnapshot(null);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("Cloud configuration file boundary", () => {
  it.each(["null", "{", JSON.stringify({ unexpected: true })])("rejects malformed present legacy data %s", async (contents) => {
    fs.writeFileSync(configPath, contents);
    await expect(readLegacyCloudRuntimeConfig()).rejects.toThrow(/Legacy Cloud runtime configuration/);
  });

  it("rejects oversized and linked legacy sources", async () => {
    fs.writeFileSync(configPath, " ".repeat(65_537));
    await expect(readLegacyCloudRuntimeConfig()).rejects.toThrow(/safely/);
    fs.rmSync(configPath);
    const target = path.join(home, "target.json");
    fs.writeFileSync(target, JSON.stringify(legacyConfig()));
    fs.symlinkSync(target, configPath);
    await expect(readLegacyCloudRuntimeConfig()).rejects.toThrow(/safely/);
  });

  it("requires an environment credential for the legacy OpenAI consumer", async () => {
    fs.writeFileSync(configPath, JSON.stringify(legacyConfig()));
    vi.stubEnv("OPENAI_API_KEY", undefined);
    await expect(readLegacyCloudRuntimeConfig()).rejects.toThrow(/OPENAI_API_KEY/);
    expect(() => readConfigFile()).toThrow(/not been initialized/);
  });

  it.each(["https://user:secret@saved.example.test", "https://saved.example.test?key=secret", "https://saved.example.test#secret"])("rejects secret-bearing URL %s", async (url) => {
    const config = legacyConfig();
    config.auth.publicBaseUrl = url;
    fs.writeFileSync(configPath, JSON.stringify(config));
    await expect(readLegacyCloudRuntimeConfig()).rejects.toThrow(/configuration is invalid/);
  });

  it("loads the minimal Cloud bootstrap from environment only", () => {
    fs.writeFileSync(configPath, "malformed");
    vi.stubEnv("DATABASE_URL", "postgres://bootstrap:bootstrap-secret@127.0.0.1:5432/runtime");
    expect(loadCloudBootstrapConfig()).toMatchObject({ databaseMode: "postgres", databaseUrl: process.env.DATABASE_URL });
    vi.stubEnv("DATABASE_URL", undefined);
    expect(() => loadCloudBootstrapConfig()).toThrow(/requires DATABASE_URL/);
    vi.stubEnv("DATABASE_URL", "sqlite:///tmp/db");
    expect(() => loadCloudBootstrapConfig()).toThrow(/must use PostgreSQL/);
  });

  it.each(["", "   "])("treats an empty migration URL as absent (%j)", (migrationUrl) => {
    vi.stubEnv("DATABASE_URL", "postgres://bootstrap:password@127.0.0.1/runtime");
    vi.stubEnv("DATABASE_MIGRATION_URL", migrationUrl);
    expect(loadCloudBootstrapConfig().databaseMigrationUrl).toBeUndefined();
  });

  it("normalizes and validates an explicit migration URL", () => {
    vi.stubEnv("DATABASE_URL", "postgres://bootstrap:password@127.0.0.1/runtime");
    vi.stubEnv("DATABASE_MIGRATION_URL", "  postgres://migration:password@127.0.0.1/runtime  ");
    expect(loadCloudBootstrapConfig().databaseMigrationUrl).toBe("postgres://migration:password@127.0.0.1/runtime");
    vi.stubEnv("DATABASE_MIGRATION_URL", "https://wrong.example.test");
    expect(() => loadCloudBootstrapConfig()).toThrow("DATABASE_MIGRATION_URL must use PostgreSQL");
  });

  it("preserves local config file behavior without managed signals", () => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", undefined);
    fs.writeFileSync(configPath, JSON.stringify(legacyConfig()));
    expect(readConfigFile()?.llm?.apiKey).toBe("legacy-openai-secret");
    expect(loadConfig()).toMatchObject({ port: 3210, telemetryEnabled: false, storageS3Bucket: "saved-bucket" });
  });
});

describePostgres("Cloud runtime configuration in PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let first: Db;
  let second: Db;

  beforeAll(async () => {
    if (externalDatabaseUrl) {
      await applyPendingMigrations(externalDatabaseUrl);
      database = { connectionString: externalDatabaseUrl, cleanup: () => closeRegisteredClients(externalDatabaseUrl, { scope: "database" }) };
    } else {
      database = await startEmbeddedPostgresTestDatabase("paperclip-runtime-config-db-");
    }
    first = createDb(database.connectionString);
    second = createDb(database.connectionString);
  }, 90_000);

  beforeEach(async () => {
    await first.delete(instanceSettings).where(eq(instanceSettings.singletonKey, CLOUD_RUNTIME_CONFIG_KEY));
    vi.stubEnv("DATABASE_URL", database.connectionString);
  });

  afterAll(async () => { await database?.cleanup(); });

  it.each(["PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "PAPERCLIP_MANAGED_CONFIG"])("seeds a fresh database with %s", async (signal) => {
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", undefined);
    vi.stubEnv(signal, signal === "PAPERCLIP_MANAGED_CONFIG" ? "" : "test-token");
    const result = await initializeCloudRuntimeConfig(first);
    expect(result).toMatchObject({ seeded: true, current: { version: 1, revision: 0, config: null } });
    expect(await cloudRuntimeConfigService(second).inspectStored()).toEqual(result?.current);
    expect(fs.existsSync(configPath)).toBe(false);
    vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", "authenticated");
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://environment.example.test");
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "test-token");
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
    vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", "environment-bucket");
    expect(loadConfig()).toMatchObject({ databaseMode: "postgres", authBaseUrlMode: "explicit", secretsStrictMode: true, telemetryEnabled: true });
  });

  it("loads the saved authenticated mode before validating an environment host bind", async () => {
    fs.writeFileSync(configPath, JSON.stringify(legacyConfig()));
    vi.stubEnv("HOST", "0.0.0.0");
    vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", undefined);
    expect(loadCloudBootstrapConfig()).toEqual({
      databaseMode: "postgres",
      databaseUrl: database.connectionString,
      databaseMigrationUrl: process.env.DATABASE_MIGRATION_URL,
    });
    await initializeCloudRuntimeConfig(first);
    expect(loadConfig()).toMatchObject({ deploymentMode: "authenticated", host: "0.0.0.0", port: 3210 });
  });

  it("imports existing choices without credentials and restores them from a second client and new home", async () => {
    fs.writeFileSync(configPath, JSON.stringify(legacyConfig()));
    const initial = await initializeCloudRuntimeConfig(first);
    expect(loadConfig()).toMatchObject({ port: 3210, telemetryEnabled: false, databaseBackupEnabled: false, storageS3Bucket: "saved-bucket", authDisableSignUp: true });
    const [row] = await second.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, CLOUD_RUNTIME_CONFIG_KEY));
    const persisted = JSON.stringify(row.general);
    for (const secret of ["legacy-openai-secret", "database-secret", "unknown-secret-value", "environment-api-secret", database.connectionString]) {
      expect(persisted).not.toContain(secret);
    }
    const replacementHome = fs.mkdtempSync(path.join(home, "replacement-"));
    const replacementConfigDir = path.join(replacementHome, ".paperclip");
    fs.mkdirSync(replacementConfigDir);
    const envPath = path.join(replacementConfigDir, ".env");
    const envContents = "PORT=9999\nPAPERCLIP_RUNTIME_CONFIG_ENV_SENTINEL=should-not-load\n";
    fs.writeFileSync(envPath, envContents);
    vi.stubEnv("PAPERCLIP_HOME", replacementHome);
    vi.stubEnv("PAPERCLIP_CONFIG", path.join(replacementConfigDir, "config.json"));
    setCloudRuntimeConfigSnapshot(null);
    const files = vi.spyOn(fs, "readFileSync");
    expect(await initializeCloudRuntimeConfig(second)).toEqual({ seeded: false, current: initial?.current });
    expect(loadConfig()).toMatchObject({ port: 3210, telemetryEnabled: false, storageS3Bucket: "saved-bucket" });
    expect(files.mock.calls.map(([file]) => String(file)).filter(file => file.startsWith(replacementHome))).toEqual([]);
    files.mockRestore();
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const childScript = path.join(home, "restore.mts");
    fs.writeFileSync(childScript, `
      import { createDb } from ${JSON.stringify(pathToFileURL(path.join(root, "packages/db/src/index.ts")).href)};
      import { initializeCloudRuntimeConfig } from ${JSON.stringify(pathToFileURL(path.join(root, "server/src/services/cloud-runtime-config.ts")).href)};
      import { loadConfig } from ${JSON.stringify(pathToFileURL(path.join(root, "server/src/config.ts")).href)};
      const db = createDb(process.env.DATABASE_URL);
      await initializeCloudRuntimeConfig(db);
      const config = loadConfig();
      console.log(JSON.stringify({ port: config.port, telemetryEnabled: config.telemetryEnabled, storageS3Bucket: config.storageS3Bucket,
        envSentinel: process.env.PAPERCLIP_RUNTIME_CONFIG_ENV_SENTINEL ?? null }));
      await db.$client.end({ timeout: 1 });
    `);
    const child = await promisify(execFile)(process.execPath, [path.join(root, "server/node_modules/tsx/dist/cli.mjs"), childScript], {
      cwd: replacementHome,
      env: { ...process.env },
      timeout: 30_000,
    });
    expect(JSON.parse(child.stdout.trim())).toEqual({ port: 3210, telemetryEnabled: false, storageS3Bucket: "saved-bucket", envSentinel: null });
    expect(fs.readFileSync(envPath, "utf8")).toBe(envContents);
  }, 45_000);

  it("keeps environment overlays out of saved settings and ignores corrupt old files after seed", async () => {
    fs.writeFileSync(configPath, JSON.stringify(legacyConfig()));
    await initializeCloudRuntimeConfig(first);
    vi.stubEnv("PORT", "4567");
    vi.stubEnv("PAPERCLIP_STORAGE_S3_BUCKET", "operator-bucket");
    vi.stubEnv("PAPERCLIP_AUTH_DISABLE_SIGN_UP", "false");
    fs.writeFileSync(configPath, "malformed legacy contents");
    await initializeCloudRuntimeConfig(second);
    expect(loadConfig()).toMatchObject({ port: 4567, storageS3Bucket: "operator-bucket", authDisableSignUp: false, telemetryEnabled: false });
    expect((await cloudRuntimeConfigService(first).inspectStored())?.config).toMatchObject({ server: { port: 3210 }, storage: { s3: { bucket: "saved-bucket" } }, auth: { disableSignUp: true } });
  });

  it("keeps one committed seed when two clients propose different initial values", async () => {
    const config = projectCloudRuntimeConfig(paperclipConfigSchema.parse(legacyConfig()));
    const results = await Promise.all([
      cloudRuntimeConfigService(first).seedIfAbsent({ ...config, telemetry: { enabled: true } }),
      cloudRuntimeConfigService(second).seedIfAbsent({ ...config, telemetry: { enabled: false } }),
    ]);
    expect(results.filter(result => result.seeded)).toHaveLength(1);
    expect(results[0].current).toEqual(results[1].current);
    expect(await cloudRuntimeConfigService(first).inspectStored()).toEqual(results[0].current);
  });

  it("rejects unknown or credential fields on the direct mutation path", async () => {
    const config = projectCloudRuntimeConfig(paperclipConfigSchema.parse(legacyConfig()));
    await cloudRuntimeConfigService(first).seedIfAbsent(config);
    await expect(cloudRuntimeConfigService(first).replace({ ...config, llm: { provider: "openai", apiKey: "must-not-store" } } as never, 0)).rejects.toThrow(/configuration is invalid/);
    expect((await cloudRuntimeConfigService(second).inspectStored())?.revision).toBe(0);
  });

  it("serializes revisions and rejects competing stale writes from two database clients", async () => {
    const config = projectCloudRuntimeConfig(paperclipConfigSchema.parse(legacyConfig()));
    await cloudRuntimeConfigService(first).seedIfAbsent(config);
    const results = await Promise.allSettled([
      cloudRuntimeConfigService(first).replace({ ...config, telemetry: { enabled: true } }, 0),
      cloudRuntimeConfigService(second).replace({ ...config, telemetry: { enabled: false } }, 0),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await cloudRuntimeConfigService(second).inspectStored())?.revision).toBe(1);
  });

  it("composes a seed with the caller transaction and rolls back both on failure", async () => {
    const config = projectCloudRuntimeConfig(paperclipConfigSchema.parse(legacyConfig()));
    await expect(first.transaction(async tx => {
      await cloudRuntimeConfigService(first).seedIfAbsent(config, tx);
      await tx.insert(instanceSettings).values({ singletonKey: "runtime-config-test-receipt", general: {} });
      throw new Error("injected migration failure");
    })).rejects.toThrow(/injected migration failure/);
    expect(await cloudRuntimeConfigService(second).inspectStored()).toBeNull();
    expect(await second.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "runtime-config-test-receipt"))).toEqual([]);
  });

  it.each([undefined, "", "   "])("rejects raw canonical S3 rows with missing or blank bucket %j", async bucket => {
    const config = structuredClone(projectCloudRuntimeConfig(paperclipConfigSchema.parse(legacyConfig())));
    const raw = config;
    if (bucket === undefined) Reflect.deleteProperty(raw.storage.s3, "bucket");
    else raw.storage.s3.bucket = bucket;
    await first.insert(instanceSettings).values({ singletonKey: CLOUD_RUNTIME_CONFIG_KEY, general: { version: 1, revision: 0, config: raw } });
    await expect(initializeCloudRuntimeConfig(second)).rejects.toThrow(/Persisted Cloud runtime configuration is invalid/);
    expect(() => getCloudRuntimeConfigSnapshot()).toThrow(/not been initialized/);
  });

  it.each(["database-bucket", "paperclip"])("accepts canonical DB bucket %s without local configuration provenance", async bucket => {
    const config = projectCloudRuntimeConfig(paperclipConfigSchema.parse(legacyConfig()));
    config.storage.s3.bucket = bucket;
    await cloudRuntimeConfigService(first).seedIfAbsent(config);
    fs.writeFileSync(configPath, "invalid local file must not be consulted");
    await initializeCloudRuntimeConfig(second);
    expect(loadConfig()).toMatchObject({ storageProvider: "s3", storageS3Bucket: bucket });
    expect(readConfigFile({ includeProvenance: true })).toMatchObject({ explicitStorageS3Bucket: true });
  });

  it("fails closed on invalid database settings without consulting a valid legacy file", async () => {
    fs.writeFileSync(configPath, JSON.stringify(legacyConfig()));
    await first.insert(instanceSettings).values({ singletonKey: CLOUD_RUNTIME_CONFIG_KEY, general: { version: 99, config: { secret: "hidden" } } });
    await expect(initializeCloudRuntimeConfig(second)).rejects.toThrow(/Persisted Cloud runtime configuration is invalid/);
    expect(() => getCloudRuntimeConfigSnapshot()).toThrow(/not been initialized/);
  });

  it("does not fall back to a file or old snapshot when the database fails", async () => {
    fs.writeFileSync(configPath, JSON.stringify(legacyConfig()));
    await initializeCloudRuntimeConfig(first);
    const unavailable = createDb(database.connectionString);
    await unavailable.$client.end({ timeout: 1 });
    await expect(initializeCloudRuntimeConfig(unavailable)).rejects.toThrow();
    expect(() => readConfigFile()).toThrow(/not been initialized/);
  });
});
