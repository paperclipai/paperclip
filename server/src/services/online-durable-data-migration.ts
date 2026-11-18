import type { Db } from "@paperclipai/db";
import { loadConfig } from "../config.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { getStorageService, type StorageService } from "../storage/index.js";
import { durableAgentFilesEnabled } from "./agent-file-durability.js";
import { migrateAgentFiles } from "./agent-file-maintenance.js";
import { readEphemeralServerDataEligibility } from "./ephemeral-server-contract.js";
import { migrateLocalSkillPackageObjects } from "./skill-package-storage-migration.js";
import { skillPackageMaintenance } from "./skill-package-maintenance.js";
import { skillInstallationMaintenance } from "./skill-installation-maintenance.js";
import { migrateRuntimeSkillAssets } from "./native-runtime/runtime-skill-preservation.js";
import { prestageNativeHarnessBackups } from "./native-runtime/native-harness-backup-migration.js";
import { prestageNativeControllers } from "./native-runtime/native-controller-migration.js";

export type OnlineDurableDataMigrationResult = {
  state: "completed" | "budget_exhausted" | "unsupported";
  reason?: string;
  counts: Record<string, number>;
  deferred: Record<string, number>;
  eligible: boolean;
  blockers: string[];
};

type Owners = {
  storage: () => StorageService;
  localSkillStorage: () => StorageService;
  durableAgentFiles: () => boolean;
  agentFiles: typeof migrateAgentFiles;
  skillObjects: typeof migrateLocalSkillPackageObjects;
  skillPackages: (db: Db, storage: StorageService) => Pick<ReturnType<typeof skillPackageMaintenance>, "migrateSnapshots" | "migrateVersions">;
  skillInstallations: (db: Db, storage: StorageService) => Pick<ReturnType<typeof skillInstallationMaintenance>, "installations">;
  runtimeSkillAssets: typeof migrateRuntimeSkillAssets;
  nativeHarnessBackups: typeof prestageNativeHarnessBackups;
  nativeControllers: typeof prestageNativeControllers;
  eligibility: typeof readEphemeralServerDataEligibility;
};

const defaultOwners: Owners = {
  storage: getStorageService,
  localSkillStorage: () => createStorageService(createLocalDiskStorageProvider(loadConfig().storageLocalDiskBaseDir)),
  durableAgentFiles: durableAgentFilesEnabled,
  agentFiles: migrateAgentFiles,
  skillObjects: migrateLocalSkillPackageObjects,
  skillPackages: skillPackageMaintenance,
  skillInstallations: skillInstallationMaintenance,
  runtimeSkillAssets: migrateRuntimeSkillAssets,
  nativeHarnessBackups: prestageNativeHarnessBackups,
  nativeControllers: prestageNativeControllers,
  eligibility: readEphemeralServerDataEligibility,
};

let running: Promise<OnlineDurableDataMigrationResult> | null = null;

export function runOnlineDurableDataMigration(db: Db, input: { budgetMs: number; now?: () => number }, owners: Owners = defaultOwners) {
  if (!running) running = migrate(db, input, owners).finally(() => { running = null; });
  return running;
}

async function migrate(db: Db, input: { budgetMs: number; now?: () => number }, owners: Owners): Promise<OnlineDurableDataMigrationResult> {
  const now = input.now ?? Date.now;
  const deadline = now() + input.budgetMs;
  const signal = AbortSignal.timeout(Math.max(1, input.budgetMs + 30_000));
  const counts: Record<string, number> = {};
  const deferred: Record<string, number> = {};
  const add = (bucket: Record<string, number>, key: string, by = 1) => { if (by) bucket[key] = (bucket[key] ?? 0) + by; };
  const finish = async (state: OnlineDurableDataMigrationResult["state"], reason?: string) => {
    const { eligible, blockers } = await owners.eligibility(db, { purpose: "startup" });
    return { state, ...(reason ? { reason } : {}), counts, deferred, eligible, blockers };
  };
  const storage = owners.storage();
  if (storage.provider !== "s3") return finish("unsupported", "shared_object_storage_required");
  if (!owners.durableAgentFiles()) return finish("unsupported", "durable_agent_files_disabled");
  const out = () => now() >= deadline;

  let after: string | undefined;
  do {
    if (out()) return finish("budget_exhausted");
    const page = await owners.agentFiles(db, { apply: true, writersStopped: false, after, limit: 25 });
    for (const row of page.results) {
      if (row.state === "durable") add(counts, "agentFiles");
      else add(deferred, `agent_files:${row.state}`);
    }
    after = page.next ?? undefined;
  } while (after);

  const localSkills = owners.localSkillStorage();
  after = undefined;
  for (;;) {
    if (out()) return finish("budget_exhausted");
    const page = await owners.skillObjects(db, { source: localSkills, destination: storage, writersStopped: false, online: true, signal, after });
    add(counts, "skillObjects", page.migrated);
    add(deferred, "skill_objects:owner_busy", page.busy);
    if (page.inspected < 50 || !page.after) break;
    after = page.after;
  }

  const packages = owners.skillPackages(db, storage);
  for (const [name, step] of [["skillSnapshots", packages.migrateSnapshots], ["skillVersions", packages.migrateVersions]] as const) {
    after = undefined;
    for (;;) {
      if (out()) return finish("budget_exhausted");
      const page: Awaited<ReturnType<typeof step>> = await step({ apply: true, after, limit: 50, signal });
      add(counts, name, page.migrated);
      if (page.inspected < 50 || !page.after) break;
      after = page.after;
    }
  }

  const skills = owners.skillInstallations(db, storage);
  after = undefined;
  for (;;) {
    if (out()) return finish("budget_exhausted");
    const page = await skills.installations({ apply: true, writersStopped: false, after, limit: 50, signal });
    for (const row of page.results) {
      if (row.status === "converted") add(counts, "skillInstallations");
      else if (row.status !== "unchanged") add(deferred, `skills:${row.status}`);
    }
    if (page.inspected < 50 || !page.after) break;
    after = page.after;
  }

  after = undefined;
  for (;;) {
    if (out()) return finish("budget_exhausted");
    const page = await owners.runtimeSkillAssets(db, { apply: true, after, limit: 50, signal }, storage);
    add(counts, "runtimeSkillRuns", page.results.filter(row => row.status === "preserved").length);
    if (page.inspected < 50 || !page.after) break;
    after = page.after;
  }

  if (out()) return finish("budget_exhausted");
  const harness = await owners.nativeHarnessBackups(db, { storage, signal });
  add(counts, "nativeHarnessBackups", harness.published);
  for (const [reason, count] of Object.entries(harness.deferred)) add(deferred, `native_harness:${reason}`, count);

  if (out()) return finish("budget_exhausted");
  const controllers = await owners.nativeControllers(db, { storage, signal });
  add(counts, "nativeControllers", controllers.imported);
  for (const [reason, count] of Object.entries(controllers.deferred)) add(deferred, `native_controllers:${reason}`, count);

  return finish("completed");
}
