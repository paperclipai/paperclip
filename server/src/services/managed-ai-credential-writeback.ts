import { z } from "zod";
import { aiConnectionMetadataSchema } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { companySecrets, connectionGrants, toolConnections, type Db } from "@paperclipai/db";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideCodexAuthMerge, readSubscriptionAccountId, withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { decideGrokAuthMerge, parseGrokAuthPayload, hasUsableGrokAuthValue } from "@paperclipai/adapter-grok-local/server";
import { WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { aiConnectionService } from "./ai-connections.js";
import { secretService } from "./secrets.js";

export const managedAiCredentialWritebackBindingSchema = z.object({
  grantId: z.string().uuid(), secretId: z.string().uuid(), sessionEpoch: z.number().int().nonnegative(),
  versionSelector: z.union([z.literal("latest"), z.number().int().positive()]),
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
