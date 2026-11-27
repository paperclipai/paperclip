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
import { listLocalWorkspaceCompanies, listLocalWorkspaces } from "./local-workspace-dependencies.js";
import { reconcileOnlineWorkspaceOperations } from "./offline-workspace-operation-reconciliation.js";
import { inventoryRemoteWorkspaceMigration, migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import { migrateRunEvidencePage } from "./run-evidence-migration-page.js";

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
  workspaceCompanies: typeof listLocalWorkspaceCompanies;
  workspaceOperations: (db: Db, input: { companyId: string; signal: AbortSignal }) => Promise<{ reconciled: number; held: Array<{ reason: string }> }>;
  localWorkspaces: typeof listLocalWorkspaces;
  inventoryWorkspace: (db: Db, input: { companyId: string; workspaceId: string }) => Promise<{ reasons: string[]; sourceScopeUnproven?: string; details?: string[] }>;
  migrateWorkspace: (input: { db: Db; storage: StorageService; companyId: string; workspaceId: string; apply: true;
    signal: AbortSignal; sourceLockWaitMs: number }) => Promise<{ alreadyMigrated: boolean; reasons: string[]; filesUnavailable?: boolean }>;
  nativeHarnessBackups: typeof prestageNativeHarnessBackups;
  nativeControllers: typeof prestageNativeControllers;
  runEvidencePage: typeof migrateRunEvidencePage;
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
  workspaceCompanies: listLocalWorkspaceCompanies,
  workspaceOperations: reconcileOnlineWorkspaceOperations,
  localWorkspaces: listLocalWorkspaces,
  inventoryWorkspace: inventoryRemoteWorkspaceMigration,
  migrateWorkspace: migrateRemoteWorkspace,
  nativeHarnessBackups: prestageNativeHarnessBackups,
  nativeControllers: prestageNativeControllers,
  runEvidencePage: migrateRunEvidencePage,
  eligibility: readOnlineEphemeralEnrollmentEligibility,
  record: recordPass,
};

const PHASES = ["agent_files", "skill_objects", "skill_snapshots", "skill_versions", "skill_installations",
  "runtime_skill_assets", "run_logs", "provider_traces", "workspace_operations", "workspaces", "native_harness_backups", "native_controllers"] as const;
type Phase = typeof PHASES[number];

let running: Promise<OnlineDurableDataMigrationResult> | null = null;
let workspaceOwner: Promise<void> | null = null;
type Progress = { phase: number; after?: string; limit?: number; timeouts?: number };
let progress: Progress = { phase: 0 };
let carried: Record<string, number> = {};
const PHASE_CODES: Record<Phase, string[]> = { agent_files: ["agent_files"], skill_objects: ["skill_objects"],
  skill_snapshots: ["skill_snapshots"], skill_versions: ["skill_versions"], skill_installations: ["skill_installations", "skills"],
  runtime_skill_assets: ["runtime_skill_assets"], run_logs: ["run_logs"], provider_traces: ["provider_traces"],
  workspace_operations: ["workspace_operations"], workspaces: ["workspaces"],
  native_harness_backups: ["native_harness_backups", "native_harness"], native_controllers: ["native_controllers"] };
const DATA_BLOCKER_CODES: Record<string, { phases: Phase[]; unexplained: string }> = {
  agent_files_require_migration: { phases: ["agent_files"], unexplained: "agent_files:pending_inspection" },
  local_instruction_copies_require_settlement: { phases: ["agent_files"], unexplained: "agent_files:instruction_copy_unsettled" },
  external_agent_instructions: { phases: [], unexplained: "agent_instructions:external_instructions_configured" },
  skills_require_migration: { phases: ["skill_objects", "skill_snapshots", "skill_versions", "skill_installations"], unexplained: "skills:pending_inspection" },
  runtime_skill_assets_require_migration: { phases: ["runtime_skill_assets"], unexplained: "runtime_skill_assets:pending_inspection" },
  run_logs_require_migration: { phases: ["run_logs"], unexplained: "run_logs:pending_inspection" },
  provider_traces_require_migration: { phases: ["provider_traces"], unexplained: "provider_traces:pending_inspection" },
  workspaces_require_migration: { phases: ["workspace_operations", "workspaces"], unexplained: "workspaces:pending_inspection" },
  native_harness_backups_require_migration: { phases: ["native_harness_backups"], unexplained: "native_harness:pending_inspection" },
  native_controllers_require_migration: { phases: ["native_controllers"], unexplained: "native_controllers:pending_inspection" },
};
const prefixOf = (key: string) => key.slice(0, key.indexOf(":"));
const DEFAULT_LIMITS: Partial<Record<Phase, number>> = { agent_files: 5, skill_objects: 50, skill_snapshots: 50, skill_versions: 50,
  skill_installations: 50, runtime_skill_assets: 50, workspace_operations: 10, workspaces: 4 };
const WORKSPACE_SOURCE_LOCK_WAIT_MS = 1_000;
const WORKSPACE_BLOCKED = "remote_workspace_migration_blocked:";

function workspaceDeferrals(error: unknown): string[] {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith(WORKSPACE_BLOCKED)) {
    const reasons = message.slice(WORKSPACE_BLOCKED.length).split(",").filter(reason => /^[a-z_]{1,80}$/.test(reason));
    if (reasons.length) return reasons;
  }
  return [/^[a-z_]{1,80}$/.test(message) ? message : "owner_failed"];
}

export function resetOnlineDurableDataMigrationProgressForTests() {
  progress = { phase: 0 };
  carried = {};
  workspaceOwner = null;
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
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
  const defer = (key: string, by = 1) => { add(deferred, key, by); add(carried, key, by); };
  const finish = async (state: OnlineDurableDataMigrationResult["state"], reason?: string): Promise<OnlineDurableDataMigrationResult> => {
    const { eligible, blockers } = await owners.eligibility(db);
    for (const blocker of blockers) {
      const codes = DATA_BLOCKER_CODES[blocker];
      if (!codes) continue;
      const prefixes = codes.phases.flatMap(phase => PHASE_CODES[phase]);
      if (Object.keys(deferred).some(key => prefixes.includes(prefixOf(key)))) continue;
      const earlier = Object.entries(carried).filter(([key]) => prefixes.includes(prefixOf(key)));
      for (const [key, count] of earlier) deferred[key] = count;
      if (!earlier.length) deferred[codes.unexplained] = 1;
    }
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

    const page = async (phase: Phase, after: string | undefined, limit: number): Promise<string | null> => {
      switch (phase) {
        case "agent_files": {
          const result = await owners.agentFiles(db, { apply: true, writersStopped: false, after, limit, signal });
          for (const row of result.results) {
            if (row.state === "durable") add(counts, "agentFiles");
            else defer(`agent_files:${row.state}`);
          }
          return result.next ?? null;
        }
        case "skill_objects": {
          const result = await owners.skillObjects(db, { source: localSkills, destination: storage, writersStopped: false, online: true, signal, after, limit });
          add(counts, "skillObjects", result.migrated);
          defer("skill_objects:owner_busy", result.busy);
          return result.inspected < limit || !result.after ? null : result.after;
        }
        case "skill_snapshots":
        case "skill_versions": {
          const step = phase === "skill_snapshots" ? packages.migrateSnapshots : packages.migrateVersions;
          const result: Awaited<ReturnType<typeof step>> = await step({ apply: true, after, limit, signal });
          add(counts, phase === "skill_snapshots" ? "skillSnapshots" : "skillVersions", result.migrated);
          return result.inspected < limit || !result.after ? null : result.after;
        }
        case "skill_installations": {
          const result = await skills.installations({ apply: true, writersStopped: false, settleUnavailableSources: true, after, limit, signal });
          for (const row of result.results) {
            if (row.status === "converted") add(counts, row.reconstructed ? "skillInstallationsReconstructed" : "skillInstallations");
            else if (row.status === "source_unavailable") add(counts, "skillInstallationsSourceUnavailable");
            else if (row.status !== "unchanged") defer(`skills:${row.status === "blocked" ? row.code ?? "blocked" : row.status}`);
          }
          return result.inspected < limit || !result.after ? null : result.after;
        }
        case "runtime_skill_assets": {
          const result = await owners.runtimeSkillAssets(db, { apply: true, after, limit, signal }, storage);
          for (const row of result.results) {
            if (row.status === "preserved") add(counts, "runtimeSkillRuns");
            else if (row.status === "unsaved") defer(`runtime_skill_assets:${row.code}`);
          }
          return result.inspected < limit || !result.after ? null : result.after;
        }
        case "run_logs":
        case "provider_traces": {
          const logs = phase === "run_logs";
          const result = await untilAborted(owners.runEvidencePage(db, {
            kinds: [logs ? "log" : "trace"], limit, signal,
            ...(logs ? { afterRunId: after } : { afterTraceId: after }),
          }), signal);
          if (result.busy) { defer(`${phase}:owner_busy`); return null; }
          for (const item of result.items) {
            if (item.state === "migrated") add(counts, logs ? "runLogs" : "providerTraces");
            else if (item.state === "blocked") {
              const reason = item.reason && /^[a-z_]{1,60}$/.test(item.reason) ? item.reason : "migration_failed";
              defer(`${phase}:${reason}`);
            }
          }
          return (logs ? result.nextRunId : result.nextTraceId) ?? null;
        }
        case "workspace_operations": {
          const companies = await owners.workspaceCompanies(db, { after, limit });
          for (const companyId of companies) {
            const result = await owners.workspaceOperations(db, { companyId, signal });
            add(counts, "workspaceOperations", result.reconciled);
            for (const held of result.held) defer(`workspace_operations:${held.reason}`);
          }
          return companies.length < limit ? null : companies.at(-1)!;
        }
        case "workspaces": {
          if (workspaceOwner) {
            defer("workspaces:owner_busy");
            return null;
          }
          const rows = await owners.localWorkspaces(db, { after, limit });
          for (const { companyId, workspaceId } of rows) {
            let reasons: string[];
            try {
              const inventory = await owners.inventoryWorkspace(db, { companyId, workspaceId });
              reasons = inventory.sourceScopeUnproven && /^[a-z_]{1,60}$/.test(inventory.sourceScopeUnproven)
                ? [...inventory.reasons, `source_scope_${inventory.sourceScopeUnproven}`] : inventory.reasons;
              reasons = [...reasons, ...(inventory.details ?? []).filter(item => /^[a-z_]{1,60}:[a-z_]{1,60}$/.test(item))];
              if (!reasons.length) {
                const work = owners.migrateWorkspace({ db, storage, companyId, workspaceId, apply: true, signal,
                  sourceLockWaitMs: WORKSPACE_SOURCE_LOCK_WAIT_MS });
                const tracked: Promise<void> = work.then(() => undefined, () => undefined)
                  .finally(() => { if (workspaceOwner === tracked) workspaceOwner = null; });
                workspaceOwner = tracked;
                const result = await untilAborted(work, signal);
                reasons = result.alreadyMigrated ? [] : result.reasons.length ? result.reasons : ["not_migrated"];
                if (result.filesUnavailable) add(counts, "workspacesFilesUnavailable");
              }
            } catch (error) {
              if (signal.aborted) throw error;
              reasons = workspaceDeferrals(error);
            }
            if (!reasons.length) add(counts, "workspaces");
            for (const reason of reasons) defer(`workspaces:${reason}`);
          }
          return rows.length < limit ? null : rows.at(-1)!.cursor;
        }
        case "native_harness_backups": {
          await owners.nativeHarnessBackups(db, { storage, signal, onOutcome: outcome => {
            if (outcome === "published") add(counts, "nativeHarnessBackups");
            else if (outcome === "source_gone_recorded") add(counts, "nativeHarnessBackupSourcesGone");
            else if (outcome !== "current") defer(`native_harness:${outcome}`);
          } });
          return null;
        }
        case "native_controllers": {
          await owners.nativeControllers(db, { storage, signal, onOutcome: outcome => {
            if (outcome === "imported") add(counts, "nativeControllers");
            else if (!["unchanged", "archived_failed", "source_already_absent"].includes(outcome)) defer(`native_controllers:${outcome}`);
          } });
          return null;
        }
      }
    };

    while (progress.phase < PHASES.length) {
      if (spent()) return await finish("budget_exhausted");
      const phase = PHASES[progress.phase]!;
      if (progress.after === undefined) {
        const prefixes = PHASE_CODES[phase];
        for (const key of Object.keys(carried)) if (prefixes.includes(prefixOf(key))) delete carried[key];
      }
      let next: string | null;
      try {
        next = await page(phase, progress.after, progress.limit ?? DEFAULT_LIMITS[phase] ?? 1);
      } catch (error) {
        if (signal.reason instanceof BudgetSpent) throw error;
        const code = error instanceof Error && /^[a-z_]{1,60}(?::[a-z_]{1,40})?$/.test(error.message) ? error.message : "owner_failed";
        defer(`${phase}:${code}`);
        next = null;
      }
      progress = next ? { phase: progress.phase, after: next, limit: progress.limit } : { phase: progress.phase + 1 };
    }
    progress = { phase: 0 };
    return await finish("completed");
  } catch (error) {
    if (signal.reason instanceof BudgetSpent) {
      const phase = PHASES[progress.phase];
      if (phase) {
        const limit = progress.limit ?? DEFAULT_LIMITS[phase] ?? 1;
        if (limit > 1) progress = { ...progress, limit: Math.max(1, Math.floor(limit / 2)), timeouts: 0 };
        else if ((progress.timeouts ?? 0) + 1 >= 2) {
          defer(`${phase}:stalled`);
          progress = { phase: progress.phase + 1 };
        } else progress = { ...progress, timeouts: (progress.timeouts ?? 0) + 1 };
      }
      return await finish("budget_exhausted");
    }
    await owners.record(db, { state: "failed", counts }).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
