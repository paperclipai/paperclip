import { aiConnectionMetadataSchema } from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import { companySecrets, connectionGrants, environmentLeases, toolConnections, type Db } from "@paperclipai/db";
import { z, type PluginEnvironmentTaskCredential } from "@paperclipai/plugin-sdk";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decideCodexAuthMerge, withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { aiConnectionService } from "./ai-connections.js";
import { secretService } from "./secrets.js";

const bindingSchema = z.object({
  grantId: z.string().uuid(),
  secretId: z.string().uuid(),
  sessionEpoch: z.number().int().nonnegative(),
  versionSelector: z.union([z.literal("latest"), z.number().int().positive()]),
}).strict();
export type PluginTaskCredentialWritebackBinding = z.infer<typeof bindingSchema>;
const handoffSchema = z.object({
  accountIdentity: z.string().min(1),
  binding: bindingSchema,
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
  binding: PluginTaskCredentialWritebackBinding,
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
  const binding = handoff.binding;
  const home = await mkdtemp(join(await realpath(tmpdir()), "paperclip-task-credential-"));
  try {
    // Revocation or an explicit account replacement intentionally discards an old refresh.
    const account = async (database: Db) => {
      const [grant] = await database.select().from(connectionGrants).where(and(
        eq(connectionGrants.companyId, companyId), eq(connectionGrants.id, binding.grantId),
      )).for("update");
      if (!grant || grant.status !== "active") return null;
      const ref = grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential");
      if (!ref || ref.secretId !== binding.secretId ||
          (ref.versionSelector ?? "latest") !== binding.versionSelector) return null;
      const [secret] = await database.select().from(companySecrets).where(and(
        eq(companySecrets.companyId, companyId), eq(companySecrets.id, binding.secretId),
      )).for("update");
      if (!secret || secret.aiSessionEpoch !== binding.sessionEpoch) return null;
      const [connection] = await database.select().from(toolConnections).where(and(
        eq(toolConnections.companyId, companyId), eq(toolConnections.id, grant.connectionId),
      ));
      const ai = aiConnectionMetadataSchema.safeParse(connection?.config.ai);
      if (!connection || !ai.success || ai.data.provider !== "openai" || ai.data.method !== "subscription") return null;
      return { connection, grant };
    };
    const mutate = <T>(operation: (database: Db) => Promise<T>) => withAccountHomeSecretMutationLock(
      undefined, companyId, () => db.transaction(tx => operation(tx as unknown as Db)),
    );
    const current = await mutate(account);
    if (!current) return "binding_changed" as const;
    // Do not hold database or account locks while the provider exports its credential.
    const credential = await fetchCredential(handoff.accountIdentity);
    if (credential === null) return "no_credentials" as const;
    if (credential.type !== "codex-auth-json") throw new Error("Plugin task credential provider mismatch");
    const incoming = join(home, "incoming.json"), destination = join(home, "current.json");
    await writeFile(incoming, credential.authJson, { mode: 0o600 });
    const writeBack = () => mutate(async database => {
      const selected = await account(database);
      if (!selected) return "binding_changed" as const;
      const value = await aiConnectionService(database).credential(selected);
      await writeFile(destination, value, { mode: 0o600 });
      if (await decideCodexAuthMerge(incoming, destination, { errorLabel: "AI account refresh" }) !== 10) return "unchanged" as const;
      await secretService(database).rotate(binding.secretId, {
        value: credential.authJson, preserveAiSessionEpoch: true,
      }, { userId: selected.grant.subjectUserId });
      return "rotated" as const;
    });
    for (let attempt = 0; ; attempt++) {
      try {
        return await writeBack();
      } catch (error) {
        if (attempt >= 2 || (error as NodeJS.ErrnoException)?.code !== WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) throw error;
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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
