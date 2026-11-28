import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { ENVIRONMENT_TASK_AUTH_FILE_PROVIDERS, z, type PluginEnvironmentTaskAuthFileProvider, type PluginEnvironmentTaskCredential } from "@paperclipai/plugin-sdk";
import { isDeepStrictEqual } from "node:util";
import { managedAiCredentialWritebackBindingSchema, syncManagedAiCredentials, syncManagedAntigravityCredential, type ManagedAiCredentialWritebackBinding } from "./managed-ai-credential-writeback.js";

const handoffSchema = z.object({
  accountIdentity: z.string().min(1),
  /** The provider whose saved sign-in file returns; absent on handoffs recorded before Grok, which are Codex. */
  provider: z.enum(ENVIRONMENT_TASK_AUTH_FILE_PROVIDERS).optional(),
  binding: managedAiCredentialWritebackBindingSchema,
  state: z.enum(["pending", "complete"]),
  outcome: z.enum(["rotated", "unchanged", "binding_changed", "not_dispatched", "no_credentials", "account_refused"]).optional(),
}).strict();
const key = "runnerTaskCredentialHandoff";
type Scope = { companyId: string; leaseId: string; expectedTaskId?: string };

export function canReadStoppedPluginTaskCredential(metadata: Record<string, unknown>, accountIdentity: string): boolean {
  const handoff = handoffSchema.safeParse(metadata[key]);
  return metadata.runnerTaskExecutionStopped === true && handoff.success &&
    handoff.data.state === "pending" && handoff.data.accountIdentity === accountIdentity;
}

/** Save authority, never credential bytes or a controller-local temporary path. */
export async function registerPluginTaskCredentialHandoff(
  db: Db,
  scope: Scope,
  accountIdentity: string,
  binding: ManagedAiCredentialWritebackBinding,
  provider: PluginEnvironmentTaskAuthFileProvider = "codex",
) {
  const handoff = handoffSchema.parse({ accountIdentity, binding, state: "pending", ...(provider === "codex" ? {} : { provider }) });
  await db.transaction(async tx => {
    const [lease] = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, scope.companyId), eq(environmentLeases.id, scope.leaseId),
    )).for("update");
    if (!lease || lease.status !== "active" || lease.metadata?.runnerTaskLease !== true ||
        lease.metadata.runnerTaskRetiring === true) {
      throw new Error("Plugin task credential lease unavailable");
    }
    const saved = lease.metadata[key];
    if (saved) {
      const prior = handoffSchema.parse(saved);
      if (prior.accountIdentity !== accountIdentity || !isDeepStrictEqual(prior.binding, handoff.binding) ||
          (prior.provider ?? "codex") !== provider) {
        throw new Error("Plugin task credential authority changed");
      }
      return;
    }
    await tx.update(environmentLeases).set({ metadata: { ...lease.metadata, [key]: handoff } })
      .where(eq(environmentLeases.id, lease.id));
  });
}

/** Live PRP updates use durable authority, including while a warm task is idle. */
export async function syncPluginTaskCredentialHandoff(
  db: Db,
  scope: Scope,
  fetchCredential: (accountIdentity: string) => Promise<PluginEnvironmentTaskCredential | null>,
) {
  const [lease] = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, scope.companyId), eq(environmentLeases.id, scope.leaseId),
    scope.expectedTaskId === undefined ? undefined : eq(environmentLeases.providerLeaseId, scope.expectedTaskId),
  ));
  if (!lease) throw new Error("Plugin task credential lease unavailable");
  if (!lease.metadata?.[key]) return;
  const handoff = handoffSchema.parse(lease.metadata[key]);
  if (handoff.state === "complete") return;
  const outcome = await writeBackCredentials(db, scope.companyId, handoff, fetchCredential);
  if (outcome === "no_credentials") throw new Error("Plugin task credential snapshot unavailable");
  return outcome;
}

async function writeBackCredentials(
  db: Db,
  companyId: string,
  handoff: z.infer<typeof handoffSchema>,
  fetchCredential: (accountIdentity: string) => Promise<PluginEnvironmentTaskCredential | null>,
) {
  if (handoff.binding.google) return syncManagedAntigravityCredential(db, companyId, handoff.binding, async () => {
    const credential = await fetchCredential(handoff.accountIdentity);
    if (credential === null) return null;
    const value = credential.type === "provider-env" && credential.provider === "antigravity"
      ? credential.environment.PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET : undefined;
    if (!value) throw new Error("Plugin task credential provider mismatch");
    return value;
  });
  const provider = handoff.provider ?? "codex";
  return syncManagedAiCredentials(db, companyId, handoff.binding, provider, async () => {
    const credential = await fetchCredential(handoff.accountIdentity);
    if (credential === null) return null;
    if (credential.type !== "auth-file" || credential.provider !== provider) throw new Error("Plugin task credential provider mismatch");
    return credential.content;
  });
}

/** Runs for live completion and the cleanup sweep, including after Core restarts. */
export async function settlePluginTaskCredentialHandoff(
  db: Db,
  scope: Scope,
  metadata: Record<string, unknown>,
  fetchCredential: (accountIdentity: string) => Promise<PluginEnvironmentTaskCredential | null>,
) {
  if (!metadata[key]) return;
  const handoff = handoffSchema.parse(metadata[key]);
  if (handoff.state === "complete") return;
  const dispatched = metadata.runnerTaskDispatched === true || !!metadata.runnerTaskIdentity;
  if (dispatched && metadata.runnerTaskExecutionStopped !== true) {
    throw new Error("Plugin task credential process termination is unconfirmed");
  }
  const outcome = dispatched
    ? await writeBackCredentials(db, scope.companyId, handoff, fetchCredential)
    : "not_dispatched";
  const settled = { ...handoff, state: "complete" as const, outcome };
  const completed = await db.update(environmentLeases).set({
    metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ [key]: settled })}::jsonb`,
  }).where(and(
    eq(environmentLeases.companyId, scope.companyId), eq(environmentLeases.id, scope.leaseId),
    scope.expectedTaskId === undefined ? undefined : eq(environmentLeases.providerLeaseId, scope.expectedTaskId),
    sql`${environmentLeases.metadata}->${key} = ${JSON.stringify(handoff)}::jsonb`,
  )).returning({ id: environmentLeases.id });
  if (completed.length !== 1) {
    const [current] = await db.select({ metadata: environmentLeases.metadata, taskId: environmentLeases.providerLeaseId }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, scope.companyId), eq(environmentLeases.id, scope.leaseId),
    ));
    const saved = handoffSchema.safeParse(current?.metadata?.[key]);
    if (scope.expectedTaskId !== undefined && current?.taskId !== scope.expectedTaskId ||
        !saved.success || !isDeepStrictEqual({ ...saved.data, outcome: settled.outcome }, settled)) {
      throw new Error("Plugin task credential handoff changed");
    }
  }
}
