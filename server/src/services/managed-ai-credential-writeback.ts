import { z } from "zod";
import { aiConnectionMetadataSchema } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { companySecrets, connectionGrants, toolConnections, type Db } from "@paperclipai/db";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideCodexAuthMerge, readSubscriptionAccountId, withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { decideGrokAuthMerge, parseGrokAuthPayload, hasUsableGrokAuthValue } from "@paperclipai/adapter-grok-local/server";
import { WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { aiConnectionService } from "./ai-connections.js";
import { secretService } from "./secrets.js";
import { logActivity } from "./activity-log.js";
import { sanitizeAntigravityCredential } from "../vendor/paperclip-runner/index.js";
import { AntigravityAccountMismatchError, prepareAntigravityCredentialWriteback } from "./native-runtime/antigravity-runner-credentials.js";

export const managedAiCredentialWritebackBindingSchema = z.object({
  grantId: z.string().uuid(), secretId: z.string().uuid(), sessionEpoch: z.number().int().nonnegative(),
  versionSelector: z.union([z.literal("latest"), z.number().int().positive()]),
  google: z.object({ credentialSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();
export type ManagedAiCredentialWritebackBinding = z.infer<typeof managedAiCredentialWritebackBindingSchema>;

/** Credential ownership survives the invocation home; reconnects and revocations win. */
export async function syncManagedAiCredentials(
  db: Db,
  companyId: string,
  binding: ManagedAiCredentialWritebackBinding,
  provider: "codex" | "grok",
  fetchCredential: () => Promise<string | null>,
) {
  managedAiCredentialWritebackBindingSchema.parse(binding);
  const home = await mkdtemp(join(await realpath(tmpdir()), "paperclip-ai-credential-"));
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
      if (!connection || !ai.success || ai.data.provider !== (provider === "codex" ? "openai" : "xai") || ai.data.method !== "subscription") return null;
      return { connection, grant };
    };
    const mutate = <T>(operation: (database: Db) => Promise<T>) => withAccountHomeSecretMutationLock(
      undefined, companyId, () => db.transaction(tx => operation(tx as unknown as Db)),
    );
    const current = await mutate(account);
    if (!current) return "binding_changed" as const;
    // Do not hold database or account locks while the provider exports its credential.
    const credential = await fetchCredential();
    if (credential === null) return "no_credentials" as const;
    // A partial provider write must replay, not be acknowledged as unchanged.
    let usable = false;
    if (provider === "codex") usable = readSubscriptionAccountId(Buffer.from(credential)) !== null;
    else {
      try {
        const parsed = parseGrokAuthPayload(JSON.parse(credential));
        usable = parsed !== null && hasUsableGrokAuthValue(parsed.value);
      } catch { /* Do not expose credential bytes through JSON parser errors. */ }
    }
    if (!usable) throw new Error("Managed credential snapshot invalid");
    const incoming = join(home, "incoming.json"), destination = join(home, "current.json");
    await writeFile(incoming, credential, { mode: 0o600 });
    const writeBack = () => mutate(async database => {
      const selected = await account(database);
      if (!selected) return "binding_changed" as const;
      const value = await aiConnectionService(database).credential(selected);
      await writeFile(destination, value, { mode: 0o600 });
      if (await (provider === "codex" ? decideCodexAuthMerge : decideGrokAuthMerge)(incoming, destination, { errorLabel: "AI account refresh" }) !== 10) return "unchanged" as const;
      await secretService(database).rotate(binding.secretId, {
        value: credential, preserveAiSessionEpoch: true,
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

export function antigravityCredentialSha256(credential: string): string {
  return createHash("sha256").update(sanitizeAntigravityCredential(credential), "utf8").digest("hex");
}

/** Only the selected Google generation may replace itself, and only with a proven same-account refresh. */
export async function syncManagedAntigravityCredential(
  db: Db,
  companyId: string,
  binding: ManagedAiCredentialWritebackBinding,
  fetchCredential: () => Promise<string | null>,
) {
  const base = managedAiCredentialWritebackBindingSchema.parse(binding).google?.credentialSha256;
  if (!base) throw new Error("Managed credential binding is not a Google sign-in");
  const account = async (database: Db) => {
    const [grant] = await database.select().from(connectionGrants).where(and(
      eq(connectionGrants.companyId, companyId), eq(connectionGrants.id, binding.grantId),
    )).for("update");
    if (!grant || grant.status !== "active") return null;
    const ref = grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential");
    if (!ref || ref.secretId !== binding.secretId || (ref.versionSelector ?? "latest") !== binding.versionSelector) return null;
    const [secret] = await database.select().from(companySecrets).where(and(
      eq(companySecrets.companyId, companyId), eq(companySecrets.id, binding.secretId),
    )).for("update");
    if (!secret || secret.aiSessionEpoch !== binding.sessionEpoch) return null;
    const [connection] = await database.select().from(toolConnections).where(and(
      eq(toolConnections.companyId, companyId), eq(toolConnections.id, grant.connectionId),
    ));
    const ai = aiConnectionMetadataSchema.safeParse(connection?.config.ai);
    if (!connection || !ai.success || ai.data.provider !== "google" || ai.data.method !== "subscription") return null;
    const saved = await aiConnectionService(database).credential({ connection, grant });
    let stored: string;
    try { stored = sanitizeAntigravityCredential(saved); }
    catch { return null; }
    if (createHash("sha256").update(stored, "utf8").digest("hex") !== base) return null;
    return { connection, grant, stored };
  };
  const mutate = <T>(operation: (database: Db) => Promise<T>) => withAccountHomeSecretMutationLock(
    undefined, companyId, () => db.transaction(tx => operation(tx as unknown as Db)),
  );
  const current = await mutate(account);
  if (!current) return "binding_changed" as const;
  const credential = await fetchCredential();
  if (credential === null) return "no_credentials" as const;
  let incoming: string;
  try { incoming = sanitizeAntigravityCredential(credential); }
  catch { throw new Error("Managed credential snapshot invalid"); }
  if (incoming === current.stored) return "unchanged" as const;
  const accountEmail = current.grant.providerTenant?.name;
  const refuse = async (reason: string) => {
    await mutate(database => logActivity(database, { companyId, actorType: "system", actorId: "credential_refresh",
      action: "ai_connection.credential_refresh_refused", entityType: "tool_connection", entityId: current.connection.id,
      details: { provider: "google", grantId: current.grant.id, reason } }));
    return "account_refused" as const;
  };
  if (!accountEmail) return refuse("This Google connection has no saved account to compare the refreshed sign-in with, so it was not saved. Reconnect the Google account.");
  const home = await realpath(await mkdtemp(join(tmpdir(), "paperclip-google-writeback-")));
  let verified: string;
  try {
    await mkdir(join(home, "antigravity-acp"), { mode: 0o700 });
    await writeFile(join(home, "antigravity-acp", "acp_token.json"), incoming, { flag: "wx", mode: 0o600 });
    verified = await prepareAntigravityCredentialWriteback({ originalCredential: current.stored, refreshedCredential: incoming, managedHome: home, accountEmail });
  } catch (error) {
    if (!(error instanceof AntigravityAccountMismatchError)) throw error;
    return refuse("The refreshed Google sign-in belongs to a different Google account than this connection, so it was not saved.");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  const writeBack = () => mutate(async database => {
    const selected = await account(database);
    if (!selected || selected.grant.providerTenant?.name?.toLowerCase() !== accountEmail.toLowerCase()) return "binding_changed" as const;
    if (verified === selected.stored) return "unchanged" as const;
    await secretService(database).rotate(binding.secretId, { value: verified, preserveAiSessionEpoch: true }, { userId: selected.grant.subjectUserId });
    await logActivity(database, { companyId, actorType: "system", actorId: "credential_refresh",
      action: "ai_connection.credential_refreshed", entityType: "tool_connection", entityId: selected.connection.id,
      details: { provider: "google", grantId: selected.grant.id } });
    return "rotated" as const;
  });
  for (let attempt = 0; ; attempt++) {
    try {
      return await writeBack();
    } catch (error) {
      if (attempt >= 2 || (error as NodeJS.ErrnoException)?.code !== WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) throw error;
    }
  }
}
