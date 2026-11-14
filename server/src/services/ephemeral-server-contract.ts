import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { agentFileRoots, agents, executionWorkspaces, heartbeatRuns, providerTraceRecords, type Db } from "@paperclipai/db";
import type { Config } from "../config.js";
import { isValidLocalEncryptedMasterKey } from "../secrets/local-encrypted-provider.js";
import { agentInstructionsBundleMode } from "./agent-instructions.js";
import { skillInstallationMaintenance } from "./skill-installation-maintenance.js";
import { hasLocalNativeHarnessObligations } from "./native-runtime/native-harness-backup-migration.js";
import { findLocalNativeControllerObligation } from "./native-runtime/native-controller-migration.js";
import { hasUnsettledLocalInstructionCopies } from "./agent-instruction-copy-preservation.js";
import { hasLocalRuntimeSkillObligations } from "./native-runtime/runtime-skill-preservation.js";
import { localWorkspaceDependencyWhere } from "./local-workspace-dependencies.js";

import { ephemeralServerEnabled } from "./ephemeral-server-mode.js";
import { volumeFreeControllerStateOwned } from "./native-runtime/volume-free-controller-state.js";
import { logger } from "../middleware/logger.js";

export { ephemeralServerEnabled };

/** Validate before consumers can generate a replacement local identity. Error
 * messages name settings only, never credential values or connection URLs. */
export function assertEphemeralServerConfig(config: Pick<Config, "databaseUrl" | "storageProvider">, env = process.env): string | null {
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
  try { runtime = new URL(config.databaseUrl ?? ""); listener = new URL(env.PAPERCLIP_DATABASE_LISTEN_URL ?? ""); }
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
 * this set: that finding also covers retained sessions whose skill bundles
 * were never preserved, which the owner marker does not prove durable. */
const interruptedRunBlockers: ReadonlySet<string> = new Set([
  "native_harness_backups_require_migration",
  "local_instruction_copies_require_settlement",
]);

/** A readiness gate, not a periodic scan or an implicit migration. Existing
 * volume data is adopted by the owning maintenance commands before removal. */
export async function assertEphemeralServerData(db: Db) {
  if (!ephemeralServerEnabled()) return;
  const eligibility = await readEphemeralServerDataEligibility(db, { purpose: "startup" });
  const { controller } = eligibility;
  let blockers = eligibility.blockers;
  // Run state that never reached durable storage needs migration only while
  // it can still be on a volume. Once this filesystem carries the volume-free
  // owner marker there is no volume: the state was written by a volume-free
  // server, this one or a predecessor that stopped mid-run, and refusing to
  // start cannot bring it back. It would only keep every restart from
  // starting again. Restart recovery owns those runs; start and say so.
  // Configuration that would write new data to the local disk stays refused.
  const interrupted = blockers.filter(blocker => interruptedRunBlockers.has(blocker));
  if (interrupted.length && await volumeFreeControllerStateOwned()) {
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

export async function readEphemeralServerDataEligibility(db: Db, options: { purpose?: "migration" | "startup" } = {}) {
  const blockers: string[] = [];
  const [missingFiles] = await db.select({ id: agents.id }).from(agents).leftJoin(agentFileRoots,
    and(eq(agentFileRoots.companyId, agents.companyId), eq(agentFileRoots.agentId, agents.id)))
    .where(isNull(agentFileRoots.agentId)).limit(1);
  if (missingFiles) blockers.push("agent_files_require_migration");
  if (await hasUnsettledLocalInstructionCopies(db)) blockers.push("local_instruction_copies_require_settlement");
  // Only inspect configuration here; filesystem reads must never adopt an
  // empty directory on the replacement machine as the old server's content.
  const configured = await db.select({ id: agents.id, companyId: agents.companyId, name: agents.name, adapterConfig: agents.adapterConfig }).from(agents);
  if (configured.some(agent => agentInstructionsBundleMode(agent) === "external")) blockers.push("external_agent_instructions");
  const [localWorkspace] = await db.select({ id: executionWorkspaces.id }).from(executionWorkspaces)
    .where(localWorkspaceDependencyWhere(db)).limit(1);
  if (localWorkspace) blockers.push("workspaces_require_migration");
  const [localLog] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.logStore, "local_file"), isNotNull(heartbeatRuns.logRef),
  )).limit(1);
  if (localLog) blockers.push("run_logs_require_migration");
  const [localTrace] = await db.select({ id: providerTraceRecords.id }).from(providerTraceRecords).where(and(
    isNull(providerTraceRecords.deletedAt), sql`${providerTraceRecords.traceRef} not like 's3-segments-v1:%'`,
  )).limit(1);
  if (localTrace) blockers.push("provider_traces_require_migration");
  if (await hasLocalNativeHarnessObligations(db)) blockers.push("native_harness_backups_require_migration");
  const controller = await findLocalNativeControllerObligation(db);
  if (controller) blockers.push("native_controllers_require_migration");
  if (await hasLocalRuntimeSkillObligations(db)) blockers.push("runtime_skill_assets_require_migration");
  const skills = skillInstallationMaintenance(db);
  let after: string | undefined;
  for (;;) {
    const page = await skills.eligibility({ after, limit: 50, purpose: options.purpose });
    if (page.results.some(skill => skill.status !== "version_backed")) { blockers.push("skills_require_migration"); break; }
    if (page.inspected < 50 || !page.after) break;
    after = page.after;
  }
  return { eligible: blockers.length === 0, blockers, controller };
}
