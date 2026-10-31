import express from "express";
import request from "supertest";
import { execFileSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, cpSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations, closeRegisteredClients, companies, createDb, plugins } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { PluginRecord } from "@paperclipai/shared";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";
import { pluginLoader, type PluginRuntimeServices } from "../services/plugin-loader.js";
import { linkSdkInto } from "../../../scripts/link-plugin-dev-sdk.mjs";
import { fileURLToPath } from "node:url";
import { createBundledPluginPackageResolver } from "../services/bundled-plugin-package.js";
import { inspectCloudPackages } from "../services/cloud-package-qualification.js";
import { resolveBundledPluginInstalls } from "../services/bundled-plugins.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { pluginUiStaticRoutes } from "../routes/plugin-ui-static.js";
import { errorHandler } from "../middleware/error-handler.js";
import { derivePluginDatabaseNamespace } from "../services/plugin-database.js";
import { ensureBundledPlugins } from "../services/bundled-plugins.js";
import daytonaManifest from "../../../packages/plugins/sandbox-providers/daytona/src/manifest.js";
import { bundledImageFixture } from "./helpers/bundled-image-fixture.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const externalDatabaseUrl = process.env.PAPERCLIP_BUNDLED_PLUGIN_TEST_DATABASE_URL?.trim();
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("bundled image registration in PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let peer: ReturnType<typeof createDb>;
  const roots: string[] = [];
  const fixture = () => { const result = bundledImageFixture(); roots.push(result.root); return result; };
  beforeAll(async () => {
    if (externalDatabaseUrl) {
      await applyPendingMigrations(externalDatabaseUrl);
      database = { connectionString: externalDatabaseUrl, cleanup: () => closeRegisteredClients(externalDatabaseUrl) };
    } else {
      database = await startEmbeddedPostgresTestDatabase("bundled-image-registration-");
    }
    db = createDb(database.connectionString);
    peer = createDb(database.connectionString);
  }, 90_000);
  afterEach(async () => {
    await db.delete(plugins);
    await db.delete(companies);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  afterAll(async () => { await database?.cleanup(); });

  function runtime() {
    const output: string[] = [];
    const services = {
      workerManager: {
        startWorker: vi.fn(async (_id: string, options: { entrypointPath: string }) => { output.push(execFileSync(process.execPath, [options.entrypointPath, "--source"], { encoding: "utf8" })); }),
        call: vi.fn(async () => ({})),
      },
      lifecycleManager: { markError: vi.fn() },
      jobStore: { syncJobDeclarations: vi.fn() }, jobScheduler: { registerPlugin: vi.fn() },
      toolDispatcher: {}, eventBus: { forPlugin: vi.fn(), subscriptionCount: vi.fn(() => 0) },
      buildHostHandlers: vi.fn(() => ({})), instanceInfo: { instanceId: "fixture", hostVersion: "1.0.0" },
    };
    return { services, output };
  }
  function loaderFor(image: ReturnType<typeof fixture>, databaseClient = db, services?: PluginRuntimeServices) {
    return pluginLoader(databaseClient, {
      localPluginDir: path.join(image.root, "lost-home"), prebuiltOnly: true,
      resolvePackageRoot: image.resolver.resolve, assertPackageActivation: image.resolver.assertActivation,
      enableLocalFilesystem: false, enableNpmDiscovery: false,
    }, services);
  }

  it("starts current-image workers after losing the old home and retains each company's config", async () => {
    const old = fixture();
    const first = fixture();
    const second = fixture();
    await loaderFor(old).installPlugin({ localPath: old.packageRoot });
    const registry = pluginRegistryService(db);
    let row = (await registry.getByKey(old.manifest.id))!;
    await registry.updateStatus(row.id, { status: "ready" });
    const [companyA, companyB, unconfigured] = await db.insert(companies).values([
      { name: "Company A", issuePrefix: "CFA" }, { name: "Company B", issuePrefix: "CFB" }, { name: "Unconfigured", issuePrefix: "CFC" },
    ]).returning();
    await registry.upsertConfig(row.id, companyA!.id, { configJson: { token: "only-A" } });
    await registry.upsertConfig(row.id, companyB!.id, { configJson: { token: "only-B" } });
    row = (await registry.getById(row.id))!;
    rmSync(old.root, { recursive: true });
    const original = { ...row };
    for (const image of [first, second]) {
      const current = runtime();
      const loader = loaderFor(image, db, current.services as unknown as PluginRuntimeServices);
      const result = await loader.loadSingle(row.id);
      expect(result.success).toBe(true);
      expect(current.output).toEqual([expect.stringContaining(image.packageRoot)]);
      expect(current.services.workerManager.startWorker).toHaveBeenCalledWith(row.id, expect.objectContaining({
        entrypointPath: path.join(image.packageRoot, "dist", "worker.js"), config: {}, proactiveCompanyScopes: [companyA!.id, companyB!.id].sort(),
      }));
      expect(current.services.workerManager.call.mock.calls).toEqual(expect.arrayContaining([
        [row.id, "configChanged", { companyId: companyA!.id, config: { token: "only-A" } }],
        [row.id, "configChanged", { companyId: companyB!.id, config: { token: "only-B" } }],
      ]));
      expect(current.services.workerManager.call).toHaveBeenCalledTimes(2);
      expect(await registry.getConfig(row.id, unconfigured!.id)).toBeNull();
      const app = express();
      app.use((req, _res, next) => {
        req.actor = { type: "board", userId: "fixture-user", source: "session", isInstanceAdmin: false, companyIds: [companyA!.id] };
        next();
      });
      app.use(pluginUiStaticRoutes(db, { localPluginDir: path.join(image.root, "lost-home"), resolvePackageRoot: image.resolver.resolve }));
      app.use(errorHandler);
      const served = await request(app).get(`/_plugins/${row.id}/ui/index.js`).query({ companyId: companyA!.id });
      expect(served.status).toBe(200);
      expect(served.text).toContain("current-image");
      expect((await request(app).get(`/_plugins/${row.id}/ui/index.js`).query({ companyId: companyB!.id })).status).toBe(403);

    }
    expect(await registry.getById(row.id)).toEqual(original);
  });

  it("completes the real worker initialize and health protocol from a relocated image", async () => {
    const old = fixture(); const image = fixture();
    await loaderFor(old).installPlugin({ localPath: old.packageRoot });
    const registry = pluginRegistryService(db);
    const row = (await registry.getByKey(old.manifest.id))!;
    await registry.updateStatus(row.id, { status: "ready" });
    rmSync(old.root, { recursive: true });
    const manager = createPluginWorkerManager();
    try {
      const services = { ...runtime().services, workerManager: manager } as unknown as PluginRuntimeServices;
      const result = await loaderFor(image, db, services).loadSingle(row.id);
      expect(result.success).toBe(true);
      expect(await manager.call(row.id, "health", {})).toMatchObject({ status: "ok", details: { source: expect.stringContaining(image.packageRoot), configs: {} } });
    } finally { await manager.stopAll(); }
  });

  it("qualifies and initializes the current release SDK/shared exports through the baked loader", async () => {
    const image = fixture();
    const catalogRoot = fileURLToPath(new URL("../../../packages/plugins", import.meta.url));
    const provider = mkdtempSync(path.join(catalogRoot, "sandbox-providers", "image-sdk-proof-"));
    roots.push(provider);
    cpSync(image.packageRoot, provider, { recursive: true });
    linkSdkInto(provider);
    writeFileSync(path.join(provider, "dist", "worker.js"), 'import { definePlugin, runWorker } from "@paperclipai/plugin-sdk"; runWorker(definePlugin({ async setup() {}, async onHealth() { return { status: "ok", message: "Current image SDK/shared loaded" }; } }), import.meta.url);');
    const installs = [{ key: "sdk-proof", pluginKey: image.manifest.id, localPath: provider }];
    const resolver = createBundledPluginPackageResolver(installs);
    const manager = createPluginWorkerManager();
    const loader = pluginLoader(db, {
      prebuiltOnly: true, resolvePackageRoot: resolver.resolve, assertPackageActivation: resolver.assertActivation,
      enableLocalFilesystem: false, enableNpmDiscovery: false,
    }, { ...runtime().services, workerManager: manager } as unknown as PluginRuntimeServices);
    const registry = pluginRegistryService(db);
    try {
      await loader.installPlugin({ localPath: provider });
      const installed = (await registry.getByKey(image.manifest.id))!;
      await registry.updateStatus(installed.id, { status: "ready" });
      const registration = (await registry.getById(installed.id))!;
      expect((await inspectCloudPackages({ installs, catalogRoot, registrations: [registration], loadManifest: (root) => loader.loadManifest(root) })).blockers).toEqual([]);
      expect((await loader.loadSingle(installed.id)).success).toBe(true);
      expect(await manager.call(installed.id, "health", {})).toMatchObject({ status: "ok", message: "Current image SDK/shared loaded" });
    } finally { await manager.stopAll(); }
  }, 90_000);

  it.skipIf(!existsSync(fileURLToPath(new URL("../../../packages/plugins/sandbox-providers/daytona/dist/worker.js", import.meta.url))))("qualifies and initializes the actual prebuilt Daytona release package", async () => {
    const catalogRoot = fileURLToPath(new URL("../../../packages/plugins", import.meta.url));
    const installs = resolveBundledPluginInstalls(["daytona"], { catalogRoot, env: {}, enforceCatalogRoot: true, distributionPlugins: [] });
    const resolver = createBundledPluginPackageResolver(installs);
    const manager = createPluginWorkerManager();
    const services = { ...runtime().services, workerManager: manager } as unknown as PluginRuntimeServices;
    const loader = pluginLoader(db, {
      localPluginDir: "/lost/release/home/plugins", prebuiltOnly: true,
      resolvePackageRoot: resolver.resolve, assertPackageActivation: resolver.assertActivation,
      enableLocalFilesystem: false, enableNpmDiscovery: false,
    }, services);
    const registry = pluginRegistryService(db);
    vi.stubEnv("DAYTONA_API_KEY", "");
    try {
      await loader.installPlugin({ localPath: installs[0]!.localPath });
      const installed = (await registry.getByKey(daytonaManifest.id))!;
      await registry.update(installed.id, { packagePath: "/lost/release/home/daytona" });
      await registry.updateStatus(installed.id, { status: "ready" });
      const registration = (await registry.getById(installed.id))!;
      const inspected = await inspectCloudPackages({ installs, catalogRoot, registrations: [registration], loadManifest: (root) => loader.loadManifest(root) });
      expect(inspected.blockers).toEqual([]);
      expect(inspected.packages[0]?.packageDigest).toMatch(/^sha256:/);
      expect((await loader.loadSingle(installed.id)).success).toBe(true);
      expect(await manager.call(installed.id, "health", {})).toMatchObject({ status: "ok", message: "Daytona sandbox provider plugin healthy" });
    } finally { await manager.stopAll(); vi.unstubAllEnvs(); }
  }, 90_000);

  it("registers the same package concurrently from two roots without replacing the winner", async () => {
    const first = fixture(); const second = fixture();
    await Promise.all([
      loaderFor(first).installPlugin({ localPath: first.packageRoot }),
      loaderFor(second, peer).installPlugin({ localPath: second.packageRoot }),
    ]);
    const rows = await pluginRegistryService(db).listInstalled();
    expect(rows).toHaveLength(1);
    const original = rows[0]!;
    expect([first.packageRoot, second.packageRoot]).toContain(original.packagePath);
    await loaderFor(second, peer).installPlugin({ localPath: second.packageRoot });
    expect(await pluginRegistryService(db).getById(original.id)).toEqual(original);
    await expect(pluginRegistryService(peer).install({ packageName: original.packageName }, { ...first.manifest, description: "different package metadata" }, { idempotent: true })).rejects.toThrow(/already installed/);
  });

  it("preserves disabled registrations and avoids path writes during managed boot", async () => {
    const old = fixture(); const image = fixture();
    await loaderFor(old).installPlugin({ localPath: old.packageRoot });
    const registry = pluginRegistryService(db);
    const row = (await registry.getByKey(old.manifest.id))!;
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, row.id));
    const original = await registry.getById(row.id);
    await ensureBundledPlugins(image.installs, { registry, loader: loaderFor(image), lifecycle: { load: vi.fn() }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }, { reinstallUninstalled: true, preservePackagePath: true });
    expect(await registry.getById(row.id)).toEqual(original);
  });

  it("fails before worker startup for missing image bytes without using a home fallback or building", async () => {
    const image = fixture();
    await loaderFor(image).installPlugin({ localPath: image.packageRoot });
    const registry = pluginRegistryService(db);
    const row = (await registry.getByKey(image.manifest.id))!;
    await registry.updateStatus(row.id, { status: "ready" });
    const fallback = path.join(image.root, "lost-home", "node_modules", row.packageName);
    mkdirSync(fallback, { recursive: true });
    writeFileSync(path.join(fallback, "package.json"), JSON.stringify({ name: row.packageName }));
    writeFileSync(path.join(fallback, "worker.js"), "throw new Error('must not start');");
    rmSync(path.join(image.packageRoot, "dist", "worker.js"));
    const current = runtime();
    const loader = loaderFor(image, db, current.services as unknown as PluginRuntimeServices);
    const result = await loader.loadSingle(row.id);
    expect(result.success).toBe(false);
    expect(result.error).toContain("ENOENT");
    expect(current.services.workerManager.startWorker).not.toHaveBeenCalled();
    await expect(loader.installPlugin({ packageName: row.packageName })).rejects.toThrow(/current image catalog/);
    await loader.cleanupInstallArtifacts(row as PluginRecord);
    expect(image.resolver.inspect(row, image.manifest).compatible).toBe(false);
  });

  it("applies plugin migrations from the current image after the legacy package disappears", async () => {
    const image = bundledImageFixture({
      capabilities: ["database.namespace.migrate", "database.namespace.read", "database.namespace.write"],
      database: { migrationsDir: "migrations" },
    });
    roots.push(image.root);
    const [row] = await db.insert(plugins).values({
      ...image.registration, packagePath: "/lost/legacy/home/plugin", apiVersion: 1, categories: image.manifest.categories, status: "ready",
    }).returning();
    const current = runtime();
    const result = await loaderFor(image, db, current.services as unknown as PluginRuntimeServices).loadSingle(row!.id);
    expect(result.success).toBe(true);
    expect(current.services.workerManager.startWorker).toHaveBeenCalledWith(row!.id, expect.objectContaining({ databaseNamespace: derivePluginDatabaseNamespace(image.manifest.id) }));
    await db.execute((await import("drizzle-orm")).sql.raw(`DROP SCHEMA "${derivePluginDatabaseNamespace(image.manifest.id)}" CASCADE`));
  });

  it("retains registry-install provider credentials for an ordinary npm package", async () => {
    const npmManifest = { ...daytonaManifest, id: "paperclip.image-npm-fixture" };
    const image = bundledImageFixture(npmManifest);
    roots.push(image.root);
    const localPluginDir = path.join(image.root, "npm-home");
    const packageRoot = path.join(localPluginDir, "node_modules", "@paperclipai", "plugin-daytona");
    mkdirSync(path.dirname(packageRoot), { recursive: true });
    cpSync(image.packageRoot, packageRoot, { recursive: true });
    const metadata = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    metadata.name = "@paperclipai/plugin-daytona";
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify(metadata));
    const registry = pluginRegistryService(db);
    const row = (await registry.install({ packageName: metadata.name }, npmManifest))!;
    await registry.updateStatus(row.id, { status: "ready" });
    vi.stubEnv("DAYTONA_API_KEY", "synthetic-provider-key");
    try {
      const current = runtime();
      const loader = pluginLoader(db, { localPluginDir, enableNpmDiscovery: false, enableLocalFilesystem: false }, current.services as unknown as PluginRuntimeServices);
      expect((await loader.loadSingle(row.id)).success).toBe(true);
      expect(current.services.workerManager.startWorker).toHaveBeenCalledWith(row.id, expect.objectContaining({ env: expect.objectContaining({ DAYTONA_API_KEY: "synthetic-provider-key" }) }));
    } finally { vi.unstubAllEnvs(); }
  });

  it("keeps self-hosted local-path loading available without a managed resolver", async () => {
    const image = fixture();
    const loader = pluginLoader(db, { localPluginDir: path.join(image.root, "selfhost"), enableNpmDiscovery: false, enableLocalFilesystem: false });
    await loader.installPlugin({ localPath: image.packageRoot });
    const row = (await pluginRegistryService(db).getByKey(image.manifest.id))!;
    expect(row.packagePath).toBe(image.packageRoot);
    await expect(loader.installPlugin({ localPath: image.packageRoot })).rejects.toThrow(/already installed/);
  });
});
