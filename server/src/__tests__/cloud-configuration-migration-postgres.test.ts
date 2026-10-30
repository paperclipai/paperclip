import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations, closeRegisteredClients, createDb, instanceSettings, plugins, type Db } from "@paperclipai/db";
import { eq, inArray, sql } from "drizzle-orm";
import { paperclipConfigSchema } from "@paperclipai/shared";
import { adapterSettingsService, initializeAdapterSettings } from "../services/adapter-settings.js";
import { cloudRuntimeConfigService, initializeCloudRuntimeConfig } from "../services/cloud-runtime-config.js";
import { cloudConfigurationMigrationService } from "../services/cloud-configuration-migration.js";
import { qualifyCloudConfigurationForCurrentImage } from "../services/cloud-configuration-qualification.js";
import { runCloudConfigurationQualification } from "../qualify-cloud-configuration.js";
import { pluginLoader, type PluginRuntimeServices } from "../services/plugin-loader.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";
import { ensureBundledPlugins } from "../services/bundled-plugins.js";
import { bundledImageFixture } from "./helpers/bundled-image-fixture.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const externalDatabaseUrl = process.env.PAPERCLIP_CLOUD_CONFIGURATION_TEST_DATABASE_URL?.trim();
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const keys = ["adapter-settings:v1", "cloud-runtime-config:v1", "cloud-configuration-migration:v1"];
(support.supported ? describe : describe.skip)("Cloud configuration migration and current-image qualification", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let peer: Db;
  let homeA: string;
  let homeB: string;
  const roots: string[] = [];
  const fixture = (version = "1.0.0") => { const image = bundledImageFixture({ version }); roots.push(image.root); return image; };
  const env = (home = homeA) => ({ PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "test-cloud-token", PAPERCLIP_HOME: home, PAPERCLIP_CONFIG: path.join(home, "config.json") });
  const migration = (client = db, home = homeA) => cloudConfigurationMigrationService(client, { runtimeEnv: env(home) });
  beforeAll(async () => {
    if (externalDatabaseUrl) {
      await applyPendingMigrations(externalDatabaseUrl);
      database = { connectionString: externalDatabaseUrl, cleanup: () => closeRegisteredClients(externalDatabaseUrl) };
    } else database = await startEmbeddedPostgresTestDatabase("cloud-configuration-migration-");
    db = createDb(database.connectionString);
    peer = createDb(database.connectionString);
  }, 90_000);
  beforeEach(async () => {
    homeA = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-legacy-A-"));
    homeB = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-replacement-B-"));
    roots.push(homeA, homeB);
    await db.delete(instanceSettings).where(inArray(instanceSettings.singletonKey, keys));
    await db.delete(plugins);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });
  afterAll(async () => { await database?.cleanup(); });

  async function legacy() {
    const config = paperclipConfigSchema.parse({
      $meta: { version: 1, updatedAt: "2026-10-30T00:00:00.000Z", source: "configure" },
      database: { mode: "postgres" }, logging: { mode: "cloud" },
      server: { port: 3199 }, telemetry: { enabled: false },
    });
    await fs.writeFile(path.join(homeA, "config.json"), JSON.stringify(config));
    await fs.writeFile(path.join(homeA, "adapter-settings.json"), JSON.stringify({ disabledTypes: ["claude_local", "future_adapter"] }));
    await fs.writeFile(path.join(homeA, "adapter-plugins.json"), "[]");
    return config;
  }

  function loaderFor(image: ReturnType<typeof fixture>, client = db, services?: PluginRuntimeServices) {
    return pluginLoader(client, {
      localPluginDir: path.join(homeB, "plugins"), prebuiltOnly: true,
      resolvePackageRoot: image.resolver.resolve, assertPackageActivation: image.resolver.assertActivation,
      enableLocalFilesystem: false, enableNpmDiscovery: false,
    }, services);
  }
  async function install(image: ReturnType<typeof fixture>) {
    await loaderFor(image).installPlugin({ localPath: image.packageRoot });
    const registry = pluginRegistryService(db);
    const row = (await registry.getByKey(image.manifest.id))!;
    await registry.updateStatus(row.id, { status: "ready" });
    return row;
  }
  function qualify(image: ReturnType<typeof fixture>, client = db, home = homeA, expectedPackageEvidenceDigest?: string) {
    const loader = loaderFor(image, client);
    return migration(client, home).qualify({ installs: image.installs, loadManifest: (root) => loader.loadManifest(root), expectedPackageEvidenceDigest });
  }

  it("imports A atomically, retains later DB revisions, and starts B's real image worker after A disappears", async () => {
    await legacy();
    const oldImage = fixture();
    const newImage = fixture();
    const row = await install(oldImage);
    const first = await migration().migrate();
    expect(first.migration.adapter.authority).toBe("legacy_file");
    expect(first.migration.config.authority).toBe("legacy_file");
    const original = await qualify(oldImage);
    expect(original.configurationPackagesEligible).toBe(true);
    expect(original.samePackageOverlapEligible).toBe(false);
    await adapterSettingsService(peer, { runtimeEnv: env() }).setDisabled("codex_local", true);
    const config = (await cloudRuntimeConfigService(peer).inspectStored())!;
    expect(config.config).not.toBeNull();
    await cloudRuntimeConfigService(peer).replace({ ...config.config!, server: { ...config.config!.server, port: 3299 } }, config.revision);
    await fs.rm(homeA, { recursive: true });
    await fs.rm(oldImage.root, { recursive: true });
    expect((await migration(peer, homeB).migrate()).migration).toEqual(first.migration);
    await initializeAdapterSettings(peer, { runtimeEnv: env(homeB) });
    const restored = await initializeCloudRuntimeConfig(peer, { runtimeEnv: env(homeB) });
    expect(restored?.current.config?.server.port).toBe(3299);
    expect(await adapterSettingsService(peer, { runtimeEnv: env(homeB) }).getDisabledTypes()).toEqual(["claude_local", "codex_local", "future_adapter"]);
    const replacement = await qualify(newImage, peer, homeB, original.packageEvidenceDigest);
    expect(replacement).toMatchObject({ adapterRevision: 1, configRevision: 1, configurationPackagesEligible: true, samePackageOverlapEligible: true });
    expect(replacement.configurationDigest).not.toBe(original.configurationDigest);
    const manager = createPluginWorkerManager();
    try {
      const services = {
        workerManager: manager, lifecycleManager: { markError: vi.fn() },
        jobStore: { syncJobDeclarations: vi.fn() }, jobScheduler: { registerPlugin: vi.fn() },
        toolDispatcher: {}, eventBus: { forPlugin: vi.fn(), subscriptionCount: vi.fn(() => 0) },
        buildHostHandlers: vi.fn(() => ({})), instanceInfo: { instanceId: "qualification-fixture", hostVersion: "1.0.0" },
      } as unknown as PluginRuntimeServices;
      expect((await loaderFor(newImage, peer, services).loadSingle(row.id)).success).toBe(true);
      expect(await manager.call(row.id, "health", {})).toMatchObject({ status: "ok", details: { source: expect.stringContaining(newImage.packageRoot) } });
    } finally { await manager.stopAll(); }
  });

  it("serializes concurrent attempts and never imports stale inputs over later DB changes", async () => {
    await legacy();
    const [first, second] = await Promise.all([migration().migrate(), migration(peer).migrate()]);
    expect(first).toEqual(second);
    await adapterSettingsService(peer, { runtimeEnv: env() }).setDisabled("claude_local", false);
    await fs.writeFile(path.join(homeA, "config.json"), "invalid stale file");
    await fs.writeFile(path.join(homeA, "adapter-settings.json"), "invalid stale file");
    expect(await migration().migrate()).toEqual(first);
    expect(await adapterSettingsService(db, { runtimeEnv: env() }).getDisabledTypes()).toEqual(["future_adapter"]);
  });

  it("rolls back both seeds and the receipt if completion fails, then retries after the crash boundary", async () => {
    await legacy();
    await db.execute(sql`CREATE FUNCTION reject_cloud_migration_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.singleton_key = 'cloud-configuration-migration:v1' THEN RAISE EXCEPTION 'test receipt failure'; END IF; RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER reject_cloud_migration_receipt BEFORE UPDATE ON instance_settings FOR EACH ROW EXECUTE FUNCTION reject_cloud_migration_receipt()`);
    try {
      await expect(migration().migrate()).rejects.toMatchObject({ cause: { message: expect.stringContaining("test receipt failure") } });
      expect(await peer.select().from(instanceSettings).where(inArray(instanceSettings.singletonKey, keys))).toEqual([]);
    } finally {
      await db.execute(sql`DROP TRIGGER reject_cloud_migration_receipt ON instance_settings`);
      await db.execute(sql`DROP FUNCTION reject_cloud_migration_receipt()`);
    }
    expect((await migration(peer).migrate()).revision).toBe(0);
    expect((await peer.select().from(instanceSettings).where(inArray(instanceSettings.singletonKey, keys))).length).toBe(3);
  });

  it("fails without partial authority for malformed legacy config and preserves already-authoritative rows", async () => {
    await legacy();
    await fs.writeFile(path.join(homeA, "config.json"), "invalid");
    await expect(migration().migrate()).rejects.toThrow("Legacy Cloud runtime configuration");
    expect(await peer.select().from(instanceSettings).where(inArray(instanceSettings.singletonKey, keys))).toEqual([]);
    await adapterSettingsService(db, { runtimeEnv: env() }).seedIfAbsent({ disabledTypes: ["codex_local"] });
    await cloudRuntimeConfigService(db).seedIfAbsent(null);
    await fs.writeFile(path.join(homeA, "adapter-settings.json"), "invalid");
    const receipt = await migration(peer).migrate();
    expect(receipt.migration.adapter.authority).toBe("database");
    expect(receipt.migration.config.authority).toBe("database");
    expect((await cloudRuntimeConfigService(peer).inspectStored())?.config).toBeNull();
  });

  it("returns database errors instead of falling back to files or a completed receipt", async () => {
    await legacy();
    await migration().migrate();
    const broken = createDb(database.connectionString);
    await broken.$client.end({ timeout: 0 });
    await expect(migration(broken).migrate()).rejects.toThrow();
    const image = fixture();
    await expect(qualify(image, broken)).rejects.toThrow();
  });

  it("keeps external registration blockers durable when B has no legacy home and requires deliberate original-source resolution", async () => {
    await legacy();
    const sentinel = path.join(homeA, "external-code-executed");
    await fs.writeFile(path.join(homeA, "external.js"), `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');`);
    await fs.writeFile(path.join(homeA, "adapter-plugins.json"), JSON.stringify([{ type: "legacy_external", packageName: "legacy-adapter", localPath: path.join(homeA, "external.js") }]));
    const image = fixture();
    await install(image);
    await migration().migrate();
    expect((await qualify(image)).blockers).toContainEqual(expect.objectContaining({ code: "unsupported_external_adapters" }));
    await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    await migration(peer, homeB).migrate();
    const replacement = await qualify(image, peer, homeB);
    expect(replacement.configurationPackagesEligible).toBe(false);
    await expect(migration(peer, homeB).recheckLegacyExternalRegistrations(replacement.receiptRevision)).rejects.toThrow("original legacy source");
    await fs.unlink(path.join(homeA, "adapter-plugins.json"));
    await expect(migration().recheckLegacyExternalRegistrations(replacement.receiptRevision)).rejects.toThrow("present, valid registration file");
    expect((await migration().inspectStored())?.migration.externalRegistrations.blocker).toBe("unsupported_external_adapters");
    await fs.writeFile(path.join(homeA, "adapter-plugins.json"), "[]");
    await expect(migration().recheckLegacyExternalRegistrations(0)).rejects.toThrow("revision conflict");
    await migration().recheckLegacyExternalRegistrations(replacement.receiptRevision);
    expect((await qualify(image)).configurationPackagesEligible).toBe(true);
  });

  it("retains a metadata blocker for malformed or oversized registration files", async () => {
    await legacy();
    await fs.writeFile(path.join(homeA, "adapter-plugins.json"), Buffer.alloc(65_537));
    const receipt = await migration().migrate();
    expect(receipt.migration.externalRegistrations.blocker).toBe("invalid_external_registration_metadata");
    await fs.rm(homeA, { recursive: true });
    expect((await migration(peer, homeB).migrate()).migration.externalRegistrations).toEqual(receipt.migration.externalRegistrations);
  });

  it("records image mismatches before reconciliation, permits maintenance upgrades, and requires explicit fresh overlap evidence", async () => {
    await legacy();
    const oldImage = fixture();
    const nextImage = fixture("1.1.0");
    await install(oldImage);
    await migration().migrate();
    const old = await qualify(oldImage);
    const mismatch = await qualify(nextImage, peer, homeB, old.packageEvidenceDigest);
    expect(mismatch.configurationPackagesEligible).toBe(false);
    expect(mismatch.samePackageOverlapEligible).toBe(false);
    expect(mismatch.blockers).toContainEqual(expect.objectContaining({ code: "incompatible_bundled_package", registeredVersion: "1.0.0", imageVersion: "1.1.0" }));
    const registry = pluginRegistryService(db);
    await ensureBundledPlugins(nextImage.installs, {
      registry, loader: loaderFor(nextImage), lifecycle: { load: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }, { reinstallUninstalled: true, preservePackagePath: true });
    const current = await qualify(nextImage);
    expect(current.configurationPackagesEligible).toBe(true);
    expect(current.samePackageOverlapEligible).toBe(false);
    expect((await migration().inspectStored())?.lastPackageMismatch?.packageEvidenceDigest).toBe(mismatch.packageEvidenceDigest);
    expect((await qualify(nextImage, peer, homeB, current.packageEvidenceDigest)).samePackageOverlapEligible).toBe(true);
  });

  it("fails qualification for missing package or manifest bytes without loading a home fallback", async () => {
    await legacy();
    const image = fixture();
    await install(image);
    await migration().migrate();
    const good = await qualify(image);
    await fs.rm(path.join(image.packageRoot, "dist", "manifest.js"));
    const broken = await qualify(image, peer, homeB, good.packageEvidenceDigest);
    expect(broken.configurationPackagesEligible).toBe(false);
    expect(broken.samePackageOverlapEligible).toBe(false);
    expect(broken.blockers.length).toBeGreaterThan(0);
    await fs.rm(image.packageRoot, { recursive: true });
    expect((await qualify(image)).blockers).toContainEqual(expect.objectContaining({ code: "missing_bundled_package" }));
  });

  it("rejects changed image bytes before manifest import and never uses stale completed qualification", async () => {
    await legacy();
    const image = fixture();
    await install(image);
    await migration().migrate();
    const original = await qualify(image);
    await fs.appendFile(path.join(image.packageRoot, "dist", "worker.js"), "\nprocess.exit(99);\n");
    const loadManifest = vi.fn();
    const current = await migration(peer, homeB).qualify({ installs: image.installs, loadManifest, expectedPackageEvidenceDigest: original.packageEvidenceDigest });
    expect(current.configurationPackagesEligible).toBe(false);
    expect(current.samePackageOverlapEligible).toBe(false);
    expect(current.blockers).toContainEqual(expect.objectContaining({ code: "package_integrity_mismatch" }));
    expect(loadManifest).not.toHaveBeenCalled();
  });

  it("allows an administrator update while manifest inspection waits and refuses to certify the stale snapshot", async () => {
    await legacy();
    const image = fixture();
    await install(image);
    await migration().migrate();
    let started!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const release = new Promise<void>((resolve) => { resume = resolve; });
    const loader = loaderFor(image);
    const pending = migration().qualify({ installs: image.installs, loadManifest: async (root) => { started(); await release; return loader.loadManifest(root); } });
    await entered;
    try {
      const change = adapterSettingsService(peer, { runtimeEnv: env() }).setDisabled("codex_local", true);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(await Promise.race([change, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Admin update was blocked by image inspection")), 2_000); })])).toBe(true);
      } finally { clearTimeout(timer); }
    } finally { resume(); }
    const result = await pending;
    expect(result).toMatchObject({ configurationPackagesEligible: false, adapterRevision: 1 });
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "configuration_changed_during_inspection" }));
    expect((await qualify(image)).configurationPackagesEligible).toBe(true);
  });

  it("uses the current managed catalog through the operator command and durably records catalog failure", async () => {
    await legacy();
    const image = fixture();
    await install(image);
    await migration().migrate();
    const runtimeEnv = {
      ...env(homeB), DATABASE_URL: database.connectionString, PAPERCLIP_BUNDLED_PLUGIN_ROOT: image.root,
      PAPERCLIP_MANAGED_CONFIG: JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "fixture", features: {}, plugins: { autoInstall: ["fixture"] } }),
    };
    const initial = await qualifyCloudConfigurationForCurrentImage(db, { runtimeEnv });
    expect(initial?.configurationPackagesEligible).toBe(true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await runCloudConfigurationQualification(["--expected-package-evidence", initial!.packageEvidenceDigest], runtimeEnv)).toBe(0);
      const report = stdout.mock.calls.map((call) => String(call[0])).find((text) => text.startsWith('{\n  "receiptRevision"'));
      expect(report && JSON.parse(report).samePackageOverlapEligible).toBe(true);
    } finally { stdout.mockRestore(); }
    const missing = await qualifyCloudConfigurationForCurrentImage(peer, { runtimeEnv: { ...runtimeEnv, PAPERCLIP_MANAGED_CONFIG: runtimeEnv.PAPERCLIP_MANAGED_CONFIG.replace('"fixture"]', '"absent"]') } });
    expect(missing?.configurationPackagesEligible).toBe(false);
    expect(missing?.blockers).toContainEqual(expect.objectContaining({ code: "current_image_catalog_unavailable" }));
    expect((await migration().inspectStored())?.lastPackageMismatch?.blockers).toContainEqual(expect.objectContaining({ code: "current_image_catalog_unavailable" }));
  });

  it.skipIf(process.platform === "win32")("detects changed pnpm dependency bytes in a builtin package overlap comparison", async () => {
    await legacy();
    const image = fixture();
    await install(image);
    await migration().migrate();
    const dependency = path.join(image.packageRoot, "node_modules", ".pnpm", "dep@1.0.0", "node_modules", "dep");
    await fs.mkdir(dependency, { recursive: true });
    await fs.writeFile(path.join(dependency, "index.js"), "export const value = 1;");
    await fs.symlink(path.relative(path.join(image.packageRoot, "node_modules"), dependency), path.join(image.packageRoot, "node_modules", "dep"));
    const installs = image.installs.map(({ distribution: _distribution, ...install }) => install);
    const loader = loaderFor(image);
    const original = await migration().qualify({ installs, loadManifest: (root) => loader.loadManifest(root) });
    expect(original.configurationPackagesEligible).toBe(true);
    await fs.writeFile(path.join(dependency, "index.js"), "export const value = 2;");
    const changed = await migration(peer, homeB).qualify({ installs, loadManifest: (root) => loader.loadManifest(root), expectedPackageEvidenceDigest: original.packageEvidenceDigest });
    expect(changed.configurationPackagesEligible).toBe(true);
    expect(changed.samePackageOverlapEligible).toBe(false);
    expect(changed.overlapBlockers).toContainEqual(expect.objectContaining({ code: "package_evidence_changed" }));
  });
});
