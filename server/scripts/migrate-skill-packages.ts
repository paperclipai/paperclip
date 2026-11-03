/** Run from the server package with its configured storage and DATABASE_URL. */
import { createDb } from "@paperclipai/db";
import { loadStorageConfig } from "../src/storage/config.js";
import { createStorageProviderFromConfig } from "../src/storage/provider-registry.js";
import { createStorageService } from "../src/storage/service.js";
import { skillPackageMaintenance } from "../src/services/skill-package-maintenance.js";
import { skillInstallationMaintenance } from "../src/services/skill-installation-maintenance.js";
import { isCloudManagedInstance } from "../src/services/cloud-instance.js";
import { cloudRuntimeConfigService } from "../src/services/cloud-runtime-config.js";
import { setCloudRuntimeConfigSnapshot } from "../src/services/cloud-runtime-config-snapshot.js";

const value = (flag: string) => process.argv.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
const phase = value("--phase") ?? "snapshots";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must explicitly select the database to migrate");
const limit = Number(value("--limit") ?? 10);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("--limit must be between 1 and 50");
const db = createDb(url, { maxConnections: 2 });
try {
  if (isCloudManagedInstance()) {
    const current = await cloudRuntimeConfigService(db).inspectStored();
    if (!current) throw new Error("Initialize Cloud runtime configuration before running skill package maintenance");
    setCloudRuntimeConfigSnapshot(current);
  }
  // Maintenance must inspect the old provider before Cloud cutover. Server
  // startup prerequisites still apply to the normal global storage service.
  const storage = createStorageService(createStorageProviderFromConfig(loadStorageConfig()));
  const service = skillPackageMaintenance(db, storage);
  const installations = skillInstallationMaintenance(db, storage);
  const actions = { snapshots: service.migrateSnapshots, versions: service.migrateVersions,
    orphans: service.collectOrphans, deletions: service.deleteObjects,
    installations: installations.installations, eligibility: installations.eligibility, verification: installations.verifyVersions };
  const action = actions[phase as keyof typeof actions];
  if (!action) throw new Error("--phase must be snapshots, versions, orphans, deletions, installations, eligibility, or verification");
  const apply = process.argv.includes("--apply");
  const result = await action({ apply, writersStopped: process.argv.includes("--writers-stopped"),
    clearLegacy: process.argv.includes("--clear-legacy"), limit, after: value("--after"), companyId: value("--company") });
  console.log(JSON.stringify({ phase, apply, ...result }));
} finally { await db.$client.end({ timeout: 1 }); }
