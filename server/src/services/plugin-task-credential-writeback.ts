import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { z, type PluginEnvironmentTaskCredential } from "@paperclipai/plugin-sdk";
import { isDeepStrictEqual } from "node:util";
import { managedAiCredentialWritebackBindingSchema, syncManagedAiCredentials, type ManagedAiCredentialWritebackBinding } from "./managed-ai-credential-writeback.js";

const handoffSchema = z.object({
  accountIdentity: z.string().min(1),
  binding: managedAiCredentialWritebackBindingSchema,
  state: z.enum(["pending", "complete"]),
  outcome: z.enum(["rotated", "unchanged", "binding_changed", "not_dispatched", "no_credentials"]).optional(),
}).strict();
const key = "runnerTaskCredentialHandoff";
type Scope = { companyId: string; leaseId: string; expectedTaskId?: string };

/** Save authority, never credential bytes or a controller-local temporary path. */
export async function registerPluginTaskCredentialHandoff(
  db: Db,
  scope: Scope,
  accountIdentity: string,
  binding: ManagedAiCredentialWritebackBinding,
) {
  const handoff = handoffSchema.parse({ accountIdentity, binding, state: "pending" });
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
      if (prior.accountIdentity !== accountIdentity || !isDeepStrictEqual(prior.binding, handoff.binding)) {
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
  return syncManagedAiCredentials(db, companyId, handoff.binding, "codex", async () => {
    const credential = await fetchCredential(handoff.accountIdentity);
    if (credential === null) return null;
    if (credential.type !== "codex-auth-json") throw new Error("Plugin task credential provider mismatch");
    return credential.authJson;
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
