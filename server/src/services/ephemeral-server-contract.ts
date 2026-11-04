import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { agentFileRoots, agents, executionWorkspaces, heartbeatRuns, providerTraceRecords, type Db } from "@paperclipai/db";
import type { Config } from "../config.js";
import { isValidLocalEncryptedMasterKey } from "../secrets/local-encrypted-provider.js";
import { agentInstructionsBundleMode } from "./agent-instructions.js";
import { skillInstallationMaintenance } from "./skill-installation-maintenance.js";

export const ephemeralServerEnabled = () => process.env.PAPERCLIP_EPHEMERAL_SERVER === "true";

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

/** A readiness gate, not a periodic scan or an implicit migration. Existing
 * volume data is adopted by the owning maintenance commands before removal. */
export async function assertEphemeralServerData(db: Db) {
  if (!ephemeralServerEnabled()) return;
  const { blockers } = await readEphemeralServerDataEligibility(db, { purpose: "startup" });
  if (blockers.length) throw new Error(`Volume-free server data is not eligible: ${blockers.join(", ")}`);
}

export async function readEphemeralServerDataEligibility(db: Db, options: { purpose?: "migration" | "startup" } = {}) {
  const blockers: string[] = [];
  const [missingFiles] = await db.select({ id: agents.id }).from(agents).leftJoin(agentFileRoots,
    and(eq(agentFileRoots.companyId, agents.companyId), eq(agentFileRoots.agentId, agents.id)))
    .where(isNull(agentFileRoots.agentId)).limit(1);
  if (missingFiles) blockers.push("agent_files_require_migration");
  // Only inspect configuration here; filesystem reads must never adopt an
  // empty directory on the replacement machine as the old server's content.
  const configured = await db.select({ id: agents.id, companyId: agents.companyId, name: agents.name, adapterConfig: agents.adapterConfig }).from(agents);
  if (configured.some(agent => agentInstructionsBundleMode(agent) === "external")) blockers.push("external_agent_instructions");
  const [localWorkspace] = await db.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(and(
    isNotNull(executionWorkspaces.cwd), sql`${executionWorkspaces.providerType} <> 'plugin'`,
    sql`coalesce(${executionWorkspaces.metadata}->'remoteWorkspace'->>'schema', '') <> 'paperclip.remote-workspace.v1'`,
  )).limit(1);
  if (localWorkspace) blockers.push("workspaces_require_migration");
  const [localLog] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.logStore, "local_file"), isNotNull(heartbeatRuns.logRef),
  )).limit(1);
  if (localLog) blockers.push("run_logs_require_migration");
  const [localTrace] = await db.select({ id: providerTraceRecords.id }).from(providerTraceRecords).where(and(
    isNull(providerTraceRecords.deletedAt), sql`${providerTraceRecords.traceRef} not like 's3-segments-v1:%'`,
  )).limit(1);
  if (localTrace) blockers.push("provider_traces_require_migration");
  const skills = skillInstallationMaintenance(db);
  let after: string | undefined;
  for (;;) {
    const page = await skills.eligibility({ after, limit: 50, purpose: options.purpose });
    if (page.results.some(skill => skill.status !== "version_backed")) { blockers.push("skills_require_migration"); break; }
    if (page.inspected < 50 || !page.after) break;
    after = page.after;
  }
  return { eligible: blockers.length === 0, blockers };
}
