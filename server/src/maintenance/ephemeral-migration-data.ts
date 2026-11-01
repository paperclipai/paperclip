import { inArray } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { getStorageService } from "../storage/index.js";
import { migrateAgentFiles, verifyAgentFileObjects } from "../services/agent-file-maintenance.js";
import { readEphemeralServerDataEligibility } from "../services/ephemeral-server-contract.js";
import { migrateRunEvidence } from "../services/run-evidence-migration.js";
import { skillInstallationMaintenance } from "../services/skill-installation-maintenance.js";
import { skillPackageMaintenance } from "../services/skill-package-maintenance.js";
import { hasUnsettledLocalInstructionCopies } from "../services/agent-instruction-working-copies.js";
import { providerTraceStore } from "../services/provider-trace-store.js";

/** Runs only in the maintenance process after Cloud has confirmed all legacy
 * deployments stopped. Each owner retains its own migration/publication rules;
 * a restart repeats idempotent pages, never reimports over durable authority. */
export async function migrateEphemeralServerData(db: Db, input: {
  signal: AbortSignal; phase: (name: string) => void;
}) {
  const { signal, phase } = input;
  const counts: Record<string, number> = {};
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(inArray(heartbeatRuns.status, ["running", "queued"])).limit(1);
  if (active) throw new Error("active_execution_requires_drain");
  if (await hasUnsettledLocalInstructionCopies(db)) throw new Error("local_instruction_copies_require_settlement");
  const before = await readEphemeralServerDataEligibility(db);
  const unsupported = before.blockers.filter(blocker => ![
    "agent_files_require_migration", "run_logs_require_migration", "provider_traces_require_migration", "skills_require_migration",
  ].includes(blocker));
  if (unsupported.length) throw new Error(unsupported[0]);

  phase("agent_files");
  let after: string | undefined;
  do {
    signal.throwIfAborted();
    const page = await migrateAgentFiles(db, { apply: true, writersStopped: true, after, limit: 25 });
    if (!page.pageReady) throw new Error("agent_file_migration_blocked");
    counts.agentFiles = (counts.agentFiles ?? 0) + page.results.length;
    after = page.next ?? undefined;
  } while (after);

  phase("run_evidence");
  // Separate cursors avoid restarting an exhausted kind when the other kind
  // still has pages. A blocked item fails enrollment instead of being skipped.
  for (const kind of ["log", "trace"] as const) {
    after = undefined;
    do {
      signal.throwIfAborted();
      const page = await migrateRunEvidence(db, { apply: true, kinds: [kind], limit: 50, signal,
        ...(kind === "log" ? { afterRunId: after } : { afterTraceId: after }) });
      if (page.items.some(item => item.state !== "migrated")) throw new Error(`${kind}_migration_blocked`);
      counts[kind] = (counts[kind] ?? 0) + page.items.length;
      after = kind === "log" ? page.nextRunId : page.nextTraceId;
    } while (after);
  }

  const packages = skillPackageMaintenance(db);
  const skills = skillInstallationMaintenance(db);
  for (const [name, migrate] of [["skill_packages", packages.migrateSnapshots], ["skill_versions", packages.migrateVersions]] as const) {
    phase(name);
    after = undefined;
    for (;;) {
      signal.throwIfAborted();
      const page: Awaited<ReturnType<typeof migrate>> = await migrate({ apply: true, after, limit: 50, signal });
      counts[name] = (counts[name] ?? 0) + page.inspected;
      if (page.inspected < 50 || !page.after) break;
      after = page.after;
    }
  }
  phase("skill_installations");
  after = undefined;
  for (;;) {
    signal.throwIfAborted();
    const page = await skills.installations({ apply: true, writersStopped: true, after, limit: 50, signal });
    if (page.results.some(row => !["converted", "unchanged"].includes(row.status))) throw new Error("skill_installation_migration_blocked");
    counts.skillInstallations = (counts.skillInstallations ?? 0) + page.inspected;
    if (page.inspected < 50 || !page.after) break;
    after = page.after;
  }

  phase("verify_agent_objects");
  const storage = getStorageService();
  if (storage.provider !== "s3") throw new Error("shared_object_storage_required");
  counts.verifiedAgentObjects = await verifyAgentFileObjects(db, storage, signal);
  phase("verify_skill_versions");
  after = undefined;
  for (;;) {
    signal.throwIfAborted();
    const page = await skills.verifyVersions({ after, limit: 50, signal });
    if (page.results.some(row => !["remote_storage", "database_release_snapshot", "database_snapshot", "expired_git_history"].includes(row.status))) {
      throw new Error("skill_version_verification_failed");
    }
    counts.verifiedSkillVersions = (counts.verifiedSkillVersions ?? 0) + page.inspected;
    if (page.inspected < 50 || !page.after) break;
    after = page.after;
  }
  phase("eligibility");
  // A trace can expire after the app stops or while other owners migrate.
  // Its owner tombstones and cleans all expired pages before final eligibility.
  const traces = providerTraceStore(db), expiryAt = new Date();
  for (;;) {
    signal.throwIfAborted();
    const removed = await traces.cleanupExpired(expiryAt, signal);
    counts.expiredTraces = (counts.expiredTraces ?? 0) + removed.length;
    if (removed.length < 100) break;
  }
  const eligibility = await readEphemeralServerDataEligibility(db);
  if (!eligibility.eligible) throw new Error("final_data_eligibility_failed");
  return { counts, eligibility };
}
