import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { agentFileRoots, agents, executionWorkspaces, heartbeatRuns, providerTraceRecords, type Db } from "@paperclipai/db";
import type { Config } from "../config.js";
import { isValidLocalEncryptedMasterKey } from "../secrets/local-encrypted-provider.js";
import { agentInstructionsBundleMode } from "./agent-instructions.js";
import { skillInstallationMaintenance } from "./skill-installation-maintenance.js";
import { hasLocalNativeHarnessObligations } from "./native-runtime/native-harness-backup-migration.js";
import { findLocalNativeControllerObligation } from "./native-runtime/native-controller-migration.js";
import { hasUnsettledLocalInstructionCopies } from "./agent-instruction-copy-preservation.js";
import { hasLocalRuntimeSkillObligations, preserveLocalRuntimeSkillObligations } from "./native-runtime/runtime-skill-preservation.js";
import { localWorkspaceDependencyWhere } from "./local-workspace-dependencies.js";

import { ephemeralServerEnabled } from "./ephemeral-server-mode.js";
import { volumeFreeControllerStateOwned } from "./native-runtime/volume-free-controller-state.js";
import { logger } from "../middleware/logger.js";

export { ephemeralServerEnabled };

/** Validate before consumers can generate a replacement local identity. Error
 * messages name settings only, never credential values or connection URLs. */
export function assertEphemeralServerConfig(config: Pick<Config, "databaseUrl" | "storageProvider">, env = process.env,
  options: { allowMissingListener?: boolean } = {}): string | null {
  if (env.PAPERCLIP_EPHEMERAL_SERVER !== "true") return null;
  const refuse = (reason: string): never => { throw new Error(`Volume-free server configuration: ${reason}`); };
  if (config.storageProvider !== "s3" || env.PAPERCLIP_DURABLE_AGENT_FILES !== "true" || env.PAPERCLIP_SHARED_UI_ASSETS !== "true") {
    refuse("shared S3 storage, durable agent files and shared UI assets are required");
  }
  if (!env.PAPERCLIP_SECRETS_MASTER_KEY || !isValidLocalEncryptedMasterKey(env.PAPERCLIP_SECRETS_MASTER_KEY)) {
    refuse("a stable PAPERCLIP_SECRETS_MASTER_KEY is required");
  }
  if ((env.PAPERCLIP_DECISION_SIGNING_SECRET?.trim().length ?? 0) < 32) {
    refuse("a stable PAPERCLIP_DECISION_SIGNING_SECRET of at least 32 characters is required; preserve the existing decision key during migration");
  }
  let runtime: URL, listener: URL;
  const waiveListener = options.allowMissingListener === true && !env.PAPERCLIP_DATABASE_LISTEN_URL?.trim();
  const runtimeRequired = waiveListener ? "an external postgres DATABASE_URL is required"
    : "external DATABASE_URL and PAPERCLIP_DATABASE_LISTEN_URL are required";
  try { runtime = new URL(config.databaseUrl ?? ""); }
  catch { return refuse(runtimeRequired); }
  if (waiveListener) {
    if (!["postgres:", "postgresql:"].includes(runtime.protocol)) refuse(runtimeRequired);
    return null;
  }
  try { listener = new URL(env.PAPERCLIP_DATABASE_LISTEN_URL ?? ""); }
  catch { return refuse("external DATABASE_URL and PAPERCLIP_DATABASE_LISTEN_URL are required"); }
  if (![runtime, listener].every(url => ["postgres:", "postgresql:"].includes(url.protocol))
    || runtime.username !== listener.username || runtime.password !== listener.password || runtime.pathname !== listener.pathname
    || runtime.hostname.replace(/-pooler(?=\.)/, "") !== listener.hostname
    || /pooler|pgbouncer/i.test(listener.hostname)) {
    refuse("PAPERCLIP_DATABASE_LISTEN_URL must be a direct connection to the same database using the runtime role");
  }
  return listener.href;
}

/** Findings that describe work in progress when a server stopped, not data
 * waiting on a volume to be migrated. Every volume-free server that stops
 * during a run leaves some of them behind. Runtime skill assets are not in
 * this set: the server first copies the bundles still on this filesystem
 * (settleRuntimeSkillObligations), and waives only the ones not here. */
const interruptedRunBlockers: ReadonlySet<string> = new Set([
  "native_harness_backups_require_migration",
  "local_instruction_copies_require_settlement",
]);

export const RUNTIME_SKILL_ASSETS_BLOCKER = "runtime_skill_assets_require_migration";

/** Runtime skill bundles admitted before Core saved them at admission
 * (Nov 2026) can still be retained by old runs. Copy the ones this filesystem
 * holds into durable storage now. A bundle whose files are not here cannot be
 * saved by refusing to start: on a filesystem with the volume-free owner
 * marker there is no volume to read it from, and a volume-free stack never
 * gets its volume back. Refusing would keep the stack down on every restart
 * (staging, 2026-11-18: twelve days of failed deploys, then an outage). */
async function settleRuntimeSkillObligations(db: Db, owned: () => Promise<boolean>) {
  let outcome: Awaited<ReturnType<typeof preserveLocalRuntimeSkillObligations>>;
  try { outcome = await preserveLocalRuntimeSkillObligations(db); }
  catch (error) {
    logger.warn({ err: error }, "Volume-free server could not save retained runtime skill bundles to durable storage");
    return false;
  }
  if (outcome.bundles) logger.info({ bundles: outcome.bundles }, "Volume-free server saved retained runtime skill bundles to durable storage");
  // The copy pass visited every obligation, so its result is the answer.
  if (!outcome.unsaved.length) return true;
  if (!await owned()) return false;
  logger.warn({ blockers: [RUNTIME_SKILL_ASSETS_BLOCKER], runs: outcome.unsaved.length },
    "Volume-free server is starting over runtime skill bundles that never reached durable storage; restart recovery owns those runs");
  return true;
}

/** A readiness gate, not a periodic scan. Existing volume data is adopted by
 * the owning maintenance commands before removal; the one copy it makes
 * itself is of retained runtime skill bundles still on this filesystem. */
export async function assertEphemeralServerData(db: Db) {
  if (!ephemeralServerEnabled()) return;
  const eligibility = await readEphemeralServerDataEligibility(db, { purpose: "startup" });
  const { controller } = eligibility;
  let blockers = eligibility.blockers;
  let ownedMarker: Promise<boolean> | undefined;
  const owned = () => ownedMarker ??= volumeFreeControllerStateOwned();
  if (blockers.includes(RUNTIME_SKILL_ASSETS_BLOCKER) && await settleRuntimeSkillObligations(db, owned)) {
    blockers = blockers.filter(blocker => blocker !== RUNTIME_SKILL_ASSETS_BLOCKER);
  }
  // Run state that never reached durable storage needs migration only while
  // it can still be on a volume. Once this filesystem carries the volume-free
  // owner marker there is no volume: the state was written by a volume-free
  // server, this one or a predecessor that stopped mid-run, and refusing to
  // start cannot bring it back. It would only keep every restart from
  // starting again. Restart recovery owns those runs; start and say so.
  // Configuration that would write new data to the local disk stays refused.
  const interrupted = blockers.filter(blocker => interruptedRunBlockers.has(blocker));
  if (interrupted.length && await owned()) {
    blockers = blockers.filter(blocker => !interruptedRunBlockers.has(blocker));
    logger.warn({ blockers: interrupted },
      "Volume-free server is starting over run state that never reached durable storage; restart recovery owns those runs");
  }
  if (!blockers.length) return;
  const detail = (blocker: string) => blocker === "native_controllers_require_migration" && controller
    ? `${blocker} (run ${controller.runId} on task ${controller.issueId}: controller state at ${controller.source} is not proven by the database, and this filesystem has no volume-free owner marker, so it may be the only copy of that run's progress; adopt it with the native controller migration before starting a volume-free server)`
    : blocker;
  throw new Error(`Volume-free server data is not eligible: ${blockers.map(detail).join(", ")}`);
}

const failedCheckCode = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  if (/^[a-z_]{1,80}$/.test(message)) return `:${message}`;
  if (error instanceof SyntaxError) return ":invalid_source_json";
  const errno = (error as { code?: unknown } | null)?.code;
  return typeof errno === "string" && /^E[A-Z]{2,20}$/.test(errno) ? `:source_${errno.toLowerCase()}` : "";
};

export async function readEphemeralServerDataEligibility(db: Db, options: { purpose?: "migration" | "startup" } = {}) {
  const blockers: string[] = [];
  const check = async (area: string, blocker: string, inspect: () => Promise<boolean>) => {
    try {
      if (await inspect()) blockers.push(blocker);
    } catch (error) {
      logger.warn({ err: error, blocker }, "Volume-free data eligibility check failed");
      blockers.push(`${area}_check_failed${failedCheckCode(error)}`);
    }
  };
  await check("agent_files", "agent_files_require_migration", async () => {
    const [missingFiles] = await db.select({ id: agents.id }).from(agents).leftJoin(agentFileRoots,
      and(eq(agentFileRoots.companyId, agents.companyId), eq(agentFileRoots.agentId, agents.id)))
      .where(isNull(agentFileRoots.agentId)).limit(1);
    return Boolean(missingFiles);
  });
  await check("local_instruction_copies", "local_instruction_copies_require_settlement", () => hasUnsettledLocalInstructionCopies(db));
  // Only inspect configuration here; filesystem reads must never adopt an
  // empty directory on the replacement machine as the old server's content.
  await check("agent_instructions", "external_agent_instructions", async () => {
    const configured = await db.select({ id: agents.id, companyId: agents.companyId, name: agents.name, adapterConfig: agents.adapterConfig }).from(agents);
    return configured.some(agent => agentInstructionsBundleMode(agent) === "external");
  });
  await check("workspaces", "workspaces_require_migration", async () => {
    const [localWorkspace] = await db.select({ id: executionWorkspaces.id }).from(executionWorkspaces)
      .where(localWorkspaceDependencyWhere(db)).limit(1);
    return Boolean(localWorkspace);
  });
  await check("run_logs", "run_logs_require_migration", async () => {
    const [localLog] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.logStore, "local_file"), isNotNull(heartbeatRuns.logRef),
    )).limit(1);
    return Boolean(localLog);
  });
  await check("provider_traces", "provider_traces_require_migration", async () => {
    const [localTrace] = await db.select({ id: providerTraceRecords.id }).from(providerTraceRecords).where(and(
      isNull(providerTraceRecords.deletedAt), sql`${providerTraceRecords.traceRef} not like 's3-segments-v1:%'`,
    )).limit(1);
    return Boolean(localTrace);
  });
  await check("native_harness_backups", "native_harness_backups_require_migration", () => hasLocalNativeHarnessObligations(db));
  const found: { controller: Awaited<ReturnType<typeof findLocalNativeControllerObligation>> } = { controller: null };
  await check("native_controllers", "native_controllers_require_migration", async () => {
    found.controller = await findLocalNativeControllerObligation(db);
    return Boolean(found.controller);
  });
  await check("runtime_skill_assets", RUNTIME_SKILL_ASSETS_BLOCKER, () => hasLocalRuntimeSkillObligations(db));
  await check("skills", "skills_require_migration", async () => {
    const skills = skillInstallationMaintenance(db);
    let after: string | undefined;
    for (;;) {
      const page = await skills.eligibility({ after, limit: 50, purpose: options.purpose });
      if (page.results.some(skill => skill.status !== "version_backed" && skill.status !== "source_unavailable")) return true;
      if (page.inspected < 50 || !page.after) return false;
      after = page.after;
    }
  });
  return { eligible: blockers.length === 0, blockers, controller: found.controller };
}
