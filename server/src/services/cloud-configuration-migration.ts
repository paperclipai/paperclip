import { instanceSettings, plugins, type Db } from "@paperclipai/db";
import { eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { adapterSettingsService, readLegacyAdapterSettings } from "./adapter-settings.js";
import { getAdapterPluginStorePath } from "./adapter-plugin-store.js";
import { cloudRuntimeConfigService, readLegacyCloudRuntimeConfig } from "./cloud-runtime-config.js";
import { isCloudManagedInstance, type CloudInstanceEnv } from "./cloud-instance.js";
import { cloudConfigurationDigest, externalRegistrationEvidenceSchema, inspectLegacyExternalRegistrations } from "./cloud-configuration-evidence.js";
import { cloudPackageEvidenceSchema, inspectCloudPackages, qualificationBlockerSchema } from "./cloud-package-qualification.js";
import type { ResolvedBundledPlugin } from "./bundled-plugins.js";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

const RECEIPT_KEY = "cloud-configuration-migration:v1";
const CONFIGURATION_KEYS = ["adapter-settings:v1", "cloud-runtime-config:v1"];
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type CloudConfigurationDb = Pick<Db | Transaction, "select" | "insert" | "update" | "transaction">;
const sourceSchema = z.object({
  authority: z.enum(["database", "legacy_file", "default"]), sourceDigest: z.string(),
  importedRevision: z.number().int().nonnegative(),
}).strict();
const qualificationSchema = z.object({
  scope: z.literal("configuration_and_packages"), checkedAt: z.string(),
  adapterRevision: z.number().int().nonnegative(), configRevision: z.number().int().nonnegative(),
  configurationDigest: z.string(), packageEvidenceDigest: z.string(),
  packageInspectionDurationMs: z.number().nonnegative(),
  expectedPackageEvidenceDigest: z.string().nullable(),
  configurationPackagesEligible: z.boolean(), samePackageOverlapEligible: z.boolean(),
  packages: z.array(cloudPackageEvidenceSchema), blockers: z.array(qualificationBlockerSchema),
  overlapBlockers: z.array(qualificationBlockerSchema),
}).strict();
const receiptSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  migration: z.object({ completedAt: z.string(), adapter: sourceSchema, config: sourceSchema, externalRegistrations: externalRegistrationEvidenceSchema }).strict(),
  qualification: qualificationSchema.nullable(), lastPackageMismatch: qualificationSchema.nullable(),
}).strict();
export type CloudConfigurationReceipt = z.infer<typeof receiptSchema>;

function parseReceipt(value: unknown): CloudConfigurationReceipt {
  const result = receiptSchema.safeParse(value);
  if (!result.success) throw new Error("Persisted Cloud configuration migration receipt is invalid");
  return result.data;
}

export function cloudConfigurationMigrationService(db: CloudConfigurationDb, options: { runtimeEnv?: CloudInstanceEnv; now?: () => Date } = {}) {
  const env = options.runtimeEnv ?? process.env;
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const adapters = adapterSettingsService(db, { runtimeEnv: env });
  const config = cloudRuntimeConfigService(db);

  function assertManaged() {
    if (!isCloudManagedInstance(env)) throw new Error("Cloud configuration qualification requires a managed instance");
  }
  async function readRow(handle: CloudConfigurationDb, lock = false) {
    const query = handle.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, RECEIPT_KEY));
    const [row] = lock ? await query.for("update") : await query;
    return row ?? null;
  }
  async function currentConfiguration(handle: CloudConfigurationDb) {
    await handle.select({ id: instanceSettings.id }).from(instanceSettings).where(inArray(instanceSettings.singletonKey, CONFIGURATION_KEYS))
      .orderBy(instanceSettings.singletonKey).for("update");
    const adapter = await adapters.inspectStored(handle);
    const runtime = await config.inspectStored(handle);
    if (!adapter || !runtime) throw new Error("Cloud configuration authority is incomplete");
    return { adapter, runtime };
  }
  async function registrationSnapshot(handle: CloudConfigurationDb, lock = false) {
    const query = handle.select({
      pluginKey: plugins.pluginKey, packageName: plugins.packageName, version: plugins.version,
      manifestJson: plugins.manifestJson, status: plugins.status,
    }).from(plugins).where(ne(plugins.status, "uninstalled")).orderBy(plugins.pluginKey);
    return lock ? query.for("share") : query;
  }
  async function save(handle: CloudConfigurationDb, id: string, receipt: CloudConfigurationReceipt) {
    const validated = parseReceipt(receipt);
    const updated = await handle.update(instanceSettings).set({ general: validated, updatedAt: new Date() }).where(eq(instanceSettings.id, id)).returning({ id: instanceSettings.id });
    if (updated.length !== 1) throw new Error("Cloud configuration migration receipt was not persisted");
    return validated;
  }

  return {
    async inspectStored(): Promise<CloudConfigurationReceipt | null> {
      const row = await readRow(db);
      return row ? parseReceipt(row.general) : null;
    },
    async migrate(): Promise<CloudConfigurationReceipt> {
      assertManaged();
      return db.transaction(async (tx) => {
        const inserted = await tx.insert(instanceSettings).values({ singletonKey: RECEIPT_KEY, general: { version: 1 } })
          .onConflictDoNothing({ target: instanceSettings.singletonKey }).returning({ id: instanceSettings.id });
        const row = await readRow(tx, true);
        if (!row) throw new Error("Cloud configuration migration receipt is unavailable");
        if (!inserted.length) {
          const receipt = parseReceipt(row.general);
          await currentConfiguration(tx);
          return receipt;
        }
        await tx.select({ id: instanceSettings.id }).from(instanceSettings).where(inArray(instanceSettings.singletonKey, CONFIGURATION_KEYS))
          .orderBy(instanceSettings.singletonKey).for("update");
        const storedAdapter = await adapters.inspectStored(tx);
        const storedConfig = await config.inspectStored(tx);
        const adapterCandidate = storedAdapter ? null : await readLegacyAdapterSettings(env);
        const configCandidate = storedConfig ? null : await readLegacyCloudRuntimeConfig(env);
        const adapterSeed = storedAdapter ? null : await adapters.seedIfAbsent({ disabledTypes: adapterCandidate?.disabledTypes ?? [] }, tx);
        const configSeed = storedConfig ? null : await config.seedIfAbsent(configCandidate, tx);
        const adapter = storedAdapter ?? adapterSeed!.current;
        const runtime = storedConfig ?? configSeed!.current;
        const adapterFromDatabase = Boolean(storedAdapter || !adapterSeed?.seeded);
        const configFromDatabase = Boolean(storedConfig || !configSeed?.seeded);
        const receipt: CloudConfigurationReceipt = {
          version: 1, revision: 0,
          migration: {
            completedAt: now(),
            adapter: { authority: adapterFromDatabase ? "database" : adapterCandidate ? "legacy_file" : "default", sourceDigest: cloudConfigurationDigest(adapterFromDatabase ? { disabledTypes: adapter.disabledTypes } : adapterCandidate), importedRevision: adapter.revision },
            config: { authority: configFromDatabase ? "database" : configCandidate ? "legacy_file" : "default", sourceDigest: cloudConfigurationDigest(configFromDatabase ? runtime.config : configCandidate), importedRevision: runtime.revision },
            externalRegistrations: await inspectLegacyExternalRegistrations(getAdapterPluginStorePath(env.PAPERCLIP_HOME)),
          },
          qualification: null, lastPackageMismatch: null,
        };
        return save(tx, row.id, receipt);
      });
    },
    async recheckLegacyExternalRegistrations(expectedRevision: number): Promise<CloudConfigurationReceipt> {
      assertManaged();
      return db.transaction(async (tx) => {
        const row = await readRow(tx, true);
        if (!row) throw new Error("Cloud configuration migration has not completed");
        const receipt = parseReceipt(row.general);
        if (receipt.revision !== expectedRevision) throw new Error("Cloud configuration migration receipt revision conflict");
        const filePath = getAdapterPluginStorePath(env.PAPERCLIP_HOME);
        if (cloudConfigurationDigest(filePath) !== receipt.migration.externalRegistrations.sourceLocatorDigest) {
          throw new Error("External registration recheck requires the original legacy source location");
        }
        const evidence = await inspectLegacyExternalRegistrations(filePath);
        if (evidence.state !== "parsed") throw new Error("External registration recheck requires a present, valid registration file");
        receipt.migration.externalRegistrations = evidence;
        receipt.revision += 1;
        receipt.qualification = null;
        return save(tx, row.id, receipt);
      });
    },
    async qualify(input: {
      installs: readonly ResolvedBundledPlugin[];
      catalogRoot?: string;
      loadManifest: (packageRoot: string) => Promise<PaperclipPluginManifestV1 | null>;
      expectedPackageEvidenceDigest?: string;
      imageCatalogUnavailable?: boolean;
    }) {
      assertManaged();
      const adapter = await adapters.inspectStored();
      const runtime = await config.inspectStored();
      if (!adapter || !runtime) throw new Error("Cloud configuration authority is incomplete");
      const configurationBefore = cloudConfigurationDigest({ adapter, runtime });
      const registrationsBefore = await registrationSnapshot(db);
      const evidence = await inspectCloudPackages({ ...input, registrations: registrationsBefore });
      return db.transaction(async (tx) => {
        const row = await readRow(tx, true);
        if (!row) throw new Error("Cloud configuration migration has not completed");
        const receipt = parseReceipt(row.general);
        const current = await currentConfiguration(tx);
        const registrations = await registrationSnapshot(tx, true);
        const blockers = [...evidence.blockers];
        if (configurationBefore !== cloudConfigurationDigest(current) || cloudConfigurationDigest(registrationsBefore) !== cloudConfigurationDigest(registrations)) {
          blockers.push({ code: "configuration_changed_during_inspection", reason: "Configuration or plugin registration changed during image inspection; run qualification again" });
        }
        if (input.imageCatalogUnavailable) blockers.push({ code: "current_image_catalog_unavailable", reason: "The current image package catalog could not be verified" });
        const external = receipt.migration.externalRegistrations;
        if (external.blocker) blockers.push({ code: external.blocker, reason: "Legacy external adapter registration metadata requires an explicit operator resolution" });
        const overlapBlockers = input.expectedPackageEvidenceDigest && input.expectedPackageEvidenceDigest !== evidence.packageEvidenceDigest
          ? [{ code: "package_evidence_changed", reason: "Current packages do not match the expected package evidence digest" }] : [];
        const qualification: z.infer<typeof qualificationSchema> = {
          scope: "configuration_and_packages", checkedAt: now(),
          adapterRevision: current.adapter.revision, configRevision: current.runtime.revision,
          configurationDigest: cloudConfigurationDigest(current), packageEvidenceDigest: evidence.packageEvidenceDigest,
          packageInspectionDurationMs: evidence.packageInspectionDurationMs,
          expectedPackageEvidenceDigest: input.expectedPackageEvidenceDigest ?? null,
          configurationPackagesEligible: blockers.length === 0,
          samePackageOverlapEligible: Boolean(input.expectedPackageEvidenceDigest && blockers.length === 0 && overlapBlockers.length === 0),
          packages: evidence.packages, blockers, overlapBlockers,
        };
        receipt.revision += 1;
        receipt.qualification = qualification;
        if (evidence.blockers.length || input.imageCatalogUnavailable || overlapBlockers.length) receipt.lastPackageMismatch = qualification;
        await save(tx, row.id, receipt);
        return { receiptRevision: receipt.revision, ...qualification };
      });
    },
  };
}

export async function migrateCloudConfiguration(db: CloudConfigurationDb, options: { runtimeEnv?: CloudInstanceEnv } = {}) {
  if (!isCloudManagedInstance(options.runtimeEnv ?? process.env)) return null;
  return cloudConfigurationMigrationService(db, options).migrate();
}
