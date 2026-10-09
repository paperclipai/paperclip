import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { companySecrets, companySecretProposals, managedAgentProfiles, routineTriggers, userSecretDefinitions, type connectionGrants, type toolConnections } from "@paperclipai/db";
import type { ToolCredentialSecretRef } from "@paperclipai/shared";
import { connectionCredentialConfigPath } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";

export { connectionCredentialConfigPath } from "@paperclipai/shared";

type CredentialDb = Parameters<typeof secretService>[0];
type SecretActor = Parameters<ReturnType<typeof secretService>["create"]>[2];
type ConsumerContext = NonNullable<Parameters<ReturnType<typeof secretService>["resolveUserSecretValue"]>[2]>;

/** These consumers reference secrets directly, without connection bindings. */
export async function connectionSecretsUsedByOtherConsumers(db: CredentialDb, secretIds: string[]) {
  if (!secretIds.length) return new Set<string>();
  const profiles = await db.select({ secretId: managedAgentProfiles.apiKeySecretId }).from(managedAgentProfiles)
    .where(inArray(managedAgentProfiles.apiKeySecretId, secretIds));
  const triggers = await db.select({ secretId: routineTriggers.secretId }).from(routineTriggers)
    .where(inArray(routineTriggers.secretId, secretIds));
  const proposals = await db.select({ secretId: companySecretProposals.secretId, createdSecretId: companySecretProposals.createdSecretId })
    .from(companySecretProposals).where(or(inArray(companySecretProposals.secretId, secretIds), inArray(companySecretProposals.createdSecretId, secretIds)));
  return new Set([...profiles, ...triggers, ...proposals, ...proposals.map((row) => ({ secretId: row.createdSecretId }))]
    .flatMap((row) => row.secretId ? [row.secretId] : []));
}

export function connectionGrantCredentialRef(
  grant: Pick<typeof connectionGrants.$inferSelect, "credentialSecretRefs">,
  ref: { name: string },
): ToolCredentialSecretRef | undefined {
  return grant.credentialSecretRefs.find((candidate) =>
    candidate.configPath === ref.name || candidate.configPath === connectionCredentialConfigPath(ref),
  );
}

/** Create/replace invocation credentials in the selected identity's vault. */
export async function writeConnectionCredential(
  db: CredentialDb,
  input: {
    companyId: string;
    connectionName: string;
    configPath: string;
    label: string;
    value: string;
    ownerUserId?: string | null;
    existingRef?: ToolCredentialSecretRef;
    /** OAuth shares one definition per connection/path, with one value per owner. */
    definitionKey?: string;
    actor?: SecretActor;
  },
) {
  const vault = secretService(db);
  if (input.existingRef) {
    const [existing] = await db.select().from(companySecrets).where(and(
      eq(companySecrets.id, input.existingRef.secretId),
      eq(companySecrets.companyId, input.companyId),
    )).limit(1);
    if (existing?.scope === "user" && existing.ownerUserId !== input.ownerUserId) {
      throw unprocessable("Reconnect this connection as its credential owner.", { code: "grant_credential_invalid" });
    }
    if (existing?.status === "active" && (input.ownerUserId
      ? existing.scope === "user" && Boolean(existing.userSecretDefinitionId)
      : existing.scope === "company")) {
      const secret = input.ownerUserId
        ? await vault.rotateCurrentUserSecretValue(input.companyId, input.ownerUserId, existing.id, { value: input.value }, input.actor)
        : await vault.rotate(existing.id, { value: input.value }, input.actor);
      return { secret, created: false, definitionId: null };
    }
    // Re-entering a credential is fresh consent. Replace a legacy company
    // secret with a new owner value; never rotate or adopt the old shared row.
  }
  const metadata = {
    name: `${input.connectionName} ${input.label} ${randomUUID().slice(0, 8)}`,
    key: `tool_app.${randomUUID()}.${input.configPath.replace(/[^a-z0-9_:-]+/gi, "_")}`,
    provider: "local_encrypted" as const,
    description: `Credential for ${input.connectionName} (${input.configPath}).`,
  };
  if (!input.ownerUserId) {
    return { secret: await vault.create(input.companyId, { ...metadata, value: input.value }, input.actor), created: true, definitionId: null };
  }
  let definition = input.definitionKey ? (await db.select().from(userSecretDefinitions).where(and(
    eq(userSecretDefinitions.companyId, input.companyId), eq(userSecretDefinitions.key, input.definitionKey),
    isNull(userSecretDefinitions.deletedAt),
  )).limit(1))[0] : undefined;
  let createdDefinitionId: string | null = null;
  if (!definition) {
    if (input.definitionKey) {
      [definition] = await db.insert(userSecretDefinitions).values({
        ...metadata, key: input.definitionKey, companyId: input.companyId,
        managedMode: "paperclip_managed", createdByUserId: input.actor?.userId, createdByAgentId: input.actor?.agentId,
      }).onConflictDoNothing().returning();
      if (definition) createdDefinitionId = definition.id;
      else [definition] = await db.select().from(userSecretDefinitions).where(and(
        eq(userSecretDefinitions.companyId, input.companyId), eq(userSecretDefinitions.key, input.definitionKey),
        isNull(userSecretDefinitions.deletedAt),
      )).limit(1);
    } else {
      definition = await vault.createUserSecretDefinition(input.companyId, metadata, input.actor);
      createdDefinitionId = definition.id;
    }
  }
  if (!definition) throw unprocessable("Reconnect this connection to restore its credential definition.", { code: "grant_credential_invalid" });
  const [ownerValue] = await db.select().from(companySecrets).where(and(
    eq(companySecrets.companyId, input.companyId), eq(companySecrets.scope, "user"),
    eq(companySecrets.ownerUserId, input.ownerUserId), eq(companySecrets.userSecretDefinitionId, definition.id),
    ne(companySecrets.status, "deleted"),
  )).limit(1);
  if (ownerValue) {
    if (ownerValue.status !== "active") await vault.updateCurrentUserSecretValue(input.companyId, input.ownerUserId, ownerValue.id,
      { status: "active" }, input.actor);
    return { secret: await vault.rotateCurrentUserSecretValue(input.companyId, input.ownerUserId, ownerValue.id,
      { value: input.value }, input.actor), created: false, definitionId: createdDefinitionId };
  }
  const secret = await vault.createCurrentUserSecretValue(input.companyId, input.ownerUserId,
    { definitionId: definition.id, value: input.value }, input.actor);
  return { secret, created: true, definitionId: createdDefinitionId };
}

/** Validate metadata without reading secret values, including for connection pickers. */
export async function validateConnectionGrantSecretOwnership(
  db: CredentialDb,
  connection: Pick<typeof toolConnections.$inferSelect, "id" | "companyId">,
  grant: Pick<typeof connectionGrants.$inferSelect, "id" | "companyId" | "connectionId" | "kind" | "subjectUserId">,
  ref: ToolCredentialSecretRef,
) {
  const [secret] = await db.select().from(companySecrets).where(and(
    eq(companySecrets.id, ref.secretId), eq(companySecrets.companyId, connection.companyId),
  )).limit(1);
  const personal = grant.kind === "user";
  if (grant.companyId !== connection.companyId || grant.connectionId !== connection.id || !secret
    || (personal
      ? !grant.subjectUserId || secret.scope !== "user" || secret.ownerUserId !== grant.subjectUserId || !secret.userSecretDefinitionId
      : secret.scope !== "company")) {
    throw unprocessable("This connection's credential does not belong to the selected identity. Its owner must reconnect it.", {
      code: "grant_credential_invalid", connectionId: connection.id, grantId: grant.id, credential: ref.configPath,
    });
  }
  return secret;
}

/** The same owner/declaration checks apply during setup, testing and execution. */
export async function resolveConnectionGrantSecret(
  db: CredentialDb,
  connection: Pick<typeof toolConnections.$inferSelect, "id" | "companyId">,
  grant: Pick<typeof connectionGrants.$inferSelect, "id" | "companyId" | "connectionId" | "kind" | "subjectUserId">,
  ref: ToolCredentialSecretRef,
  context: ConsumerContext,
) {
  const secret = await validateConnectionGrantSecretOwnership(db, connection, grant, ref);
  const personal = grant.kind === "user";
  const accessContext = { ...context, consumerType: "tool_connection" as const, consumerId: connection.id,
    configPath: ref.configPath, responsibleUserId: grant.subjectUserId };
  const vault = secretService(db);
  if (!personal) {
    return { value: await vault.resolveSecretValue(connection.companyId, ref.secretId, ref.versionSelector ?? "latest",
      { accessContext }), latestVersion: secret.latestVersion };
  }
  const resolved = await vault.resolveUserSecretValue(connection.companyId, {
    definitionId: secret.userSecretDefinitionId!, responsibleUserId: grant.subjectUserId!,
    version: ref.versionSelector ?? "latest", required: ref.required ?? true,
  }, accessContext);
  if (!resolved) throw unprocessable("Your credential is missing. Reconnect this connection.", {
    code: "user_secret_missing", connectionId: connection.id, grantId: grant.id, credential: ref.configPath,
  });
  return { value: resolved.value, latestVersion: secret.latestVersion };
}
