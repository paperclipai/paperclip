import type { Db } from "@paperclipai/db";
import { loadConfig } from "../config.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { getStorageService, type StorageService } from "../storage/index.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { durableAgentFilesEnabled } from "./agent-file-durability.js";
import { migrateAgentFiles } from "./agent-file-maintenance.js";
import { cloudTenantPrimaryCompanyId, getCloudStackContext } from "./cloud-instance.js";
import { readOnlineEphemeralEnrollmentEligibility } from "./ephemeral-enrollment.js";
import { migrateLocalSkillPackageObjects } from "./skill-package-storage-migration.js";
import { skillPackageMaintenance } from "./skill-package-maintenance.js";
import { skillInstallationMaintenance } from "./skill-installation-maintenance.js";
import { migrateRuntimeSkillAssets } from "./native-runtime/runtime-skill-preservation.js";
import { prestageNativeHarnessBackups } from "./native-runtime/native-harness-backup-migration.js";
import { prestageNativeControllers } from "./native-runtime/native-controller-migration.js";

export type OnlineDurableDataMigrationResult = {
  state: "completed" | "budget_exhausted" | "unsupported";
  reason?: string;
  resumePhase?: string;
  counts: Record<string, number>;
  deferred: Record<string, number>;
  eligible: boolean;
  blockers: string[];
};

type PassRecord = OnlineDurableDataMigrationResult | { state: "failed"; counts: Record<string, number> };

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
  eligibility: (db: Db) => Promise<{ eligible: boolean; blockers: string[] }>;
  record: (db: Db, result: PassRecord) => Promise<void>;
};

async function recordPass(db: Db, result: PassRecord) {
  const stackId = getCloudStackContext()?.stackId;
  if (!stackId) return;
  const { publication } = await persistActivity(db, { companyId: cloudTenantPrimaryCompanyId(stackId), actorType: "system",
    actorId: "paperclip-cloud", action: "instance.durable_data_migration.pass", entityType: "instance", entityId: stackId, details: result });
  publishActivity(publication);
}

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
  eligibility: readOnlineEphemeralEnrollmentEligibility,
  record: recordPass,
};

const PHASES = ["agent_files", "skill_objects", "skill_snapshots", "skill_versions", "skill_installations",
  "runtime_skill_assets", "native_harness_backups", "native_controllers"] as const;
type Phase = typeof PHASES[number];

let running: Promise<OnlineDurableDataMigrationResult> | null = null;
let progress: { phase: number; after?: string } = { phase: 0 };

export function resetOnlineDurableDataMigrationProgressForTests() {
  progress = { phase: 0 };
}

export function runOnlineDurableDataMigration(db: Db, input: { budgetMs: number; now?: () => number }, owners: Owners = defaultOwners) {
  if (!running) running = migrate(db, input, owners).finally(() => { running = null; });
  return running;
}

class BudgetSpent extends Error {}

async function migrate(db: Db, input: { budgetMs: number; now?: () => number }, owners: Owners): Promise<OnlineDurableDataMigrationResult> {
  const now = input.now ?? Date.now;
  const deadline = now() + input.budgetMs;
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(new BudgetSpent()), Math.max(1, input.budgetMs));
  const signal = budget.signal;
  const counts: Record<string, number> = {};
  const deferred: Record<string, number> = {};
  const add = (bucket: Record<string, number>, key: string, by = 1) => { if (by) bucket[key] = (bucket[key] ?? 0) + by; };
  const finish = async (state: OnlineDurableDataMigrationResult["state"], reason?: string): Promise<OnlineDurableDataMigrationResult> => {
    const { eligible, blockers } = await owners.eligibility(db);
    const result: OnlineDurableDataMigrationResult = { state, ...(reason ? { reason } : {}),
      ...(state === "budget_exhausted" ? { resumePhase: PHASES[progress.phase] } : {}), counts, deferred, eligible, blockers };
    await owners.record(db, result);
    return result;
  };
  const spent = () => now() >= deadline || signal.aborted;

  try {
    const storage = owners.storage();
    if (storage.provider !== "s3") return await finish("unsupported", "shared_object_storage_required");
    if (!owners.durableAgentFiles()) return await finish("unsupported", "durable_agent_files_disabled");
    const localSkills = owners.localSkillStorage();
    const packages = owners.skillPackages(db, storage);
    const skills = owners.skillInstallations(db, storage);

    const page = async (phase: Phase, after: string | undefined): Promise<string | null> => {
      switch (phase) {
        case "agent_files": {
          const result = await owners.agentFiles(db, { apply: true, writersStopped: false, after, limit: 25 });
          for (const row of result.results) {
            if (row.state === "durable") add(counts, "agentFiles");
            else add(deferred, `agent_files:${row.state}`);
          }
          return result.next ?? null;
        }
        case "skill_objects": {
          const result = await owners.skillObjects(db, { source: localSkills, destination: storage, writersStopped: false, online: true, signal, after });
          add(counts, "skillObjects", result.migrated);
          add(deferred, "skill_objects:owner_busy", result.busy);
          return result.inspected < 50 ? null : result.after;
        }
        case "skill_snapshots":
        case "skill_versions": {
          const step = phase === "skill_snapshots" ? packages.migrateSnapshots : packages.migrateVersions;
          const result: Awaited<ReturnType<typeof step>> = await step({ apply: true, after, limit: 50, signal });
          add(counts, phase === "skill_snapshots" ? "skillSnapshots" : "skillVersions", result.migrated);
          return result.inspected < 50 ? null : result.after;
        }
        case "skill_installations": {
          const result = await skills.installations({ apply: true, writersStopped: false, after, limit: 50, signal });
          for (const row of result.results) {
            if (row.status === "converted") add(counts, "skillInstallations");
            else if (row.status !== "unchanged") add(deferred, `skills:${row.status}`);
          }
          return result.inspected < 50 ? null : result.after;
        }
        case "runtime_skill_assets": {
          const result = await owners.runtimeSkillAssets(db, { apply: true, after, limit: 50, signal }, storage);
          add(counts, "runtimeSkillRuns", result.results.filter(row => row.status === "preserved").length);
          return result.inspected < 50 ? null : result.after;
        }
        case "native_harness_backups": {
          const result = await owners.nativeHarnessBackups(db, { storage, signal });
          add(counts, "nativeHarnessBackups", result.published);
          for (const [reason, count] of Object.entries(result.deferred)) add(deferred, `native_harness:${reason}`, count);
          return null;
        }
        case "native_controllers": {
          const result = await owners.nativeControllers(db, { storage, signal });
          add(counts, "nativeControllers", result.imported);
          for (const [reason, count] of Object.entries(result.deferred)) add(deferred, `native_controllers:${reason}`, count);
          return null;
        }
      }
    };

    while (progress.phase < PHASES.length) {
      if (spent()) return await finish("budget_exhausted");
      const next = await page(PHASES[progress.phase]!, progress.after);
      progress = next ? { phase: progress.phase, after: next } : { phase: progress.phase + 1 };
    }
    progress = { phase: 0 };
    return await finish("completed");
  } catch (error) {
    if (signal.reason instanceof BudgetSpent) return await finish("budget_exhausted");
    await owners.record(db, { state: "failed", counts }).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
