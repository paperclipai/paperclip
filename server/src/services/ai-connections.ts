import { WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { syncConnectionCredentialBindings } from "./connection-credential-bindings.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  type Db,
  authUsers,
  adapterAuthSessions,
  aiConnectionDefaults,
  aiProviderDefaults,
  agents,
  heartbeatRuns,
  companyMemberships,
  companySecrets,
  userSecretDefinitions,
  connectionGrants,
  connectionGrantMembers,
  toolApplications,
  toolConnections,
  toolConnectionInstalls,
} from "@paperclipai/db";
import {
  AI_CONNECTION_CAPABILITIES,
  decisionProviderForConnection,
  aiConnectionCatalogSlug,
  getAppStoreDefinition,
  aiConnectionMetadataSchema,
  aiSubscriptionNeedsIsolatedLogin,
  isAiConnectionCompatible,
  supportsAiConnectionUsage,
  type AiConnectionBinding,
  type AiConnectionAttribution,
  type AiConnectionMetadata,
  type AiManagedConnectionSummary,
  type AiConnectionUsage,
  type CreateAiConnection,
  type AiConnectionLoginIntent,
} from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { aiConnectionConfigurationFailure, aiConnectionCredentialNotSharedFailure } from "./ai-connection-configuration-failure.js";
import { quotaCredentialRecovery, quotaCredentialHash } from "./quota-credential-recovery.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";
import { probeAiConnectionUsage } from "./ai-connection-usage.js";

/** Same human audience displayed by the existing Connections identity controls. */
function canUseCredential(
  grant: { kind: string; subjectUserId: string | null },
  userId: string | null,
  audience: { subjectType: string; subjectId: string }[],
) {
  if (!userId) return false;
  if (grant.kind === "user") return grant.subjectUserId === userId;
  return grant.kind === "organization" && (
    audience.length === 0 || audience.some((member) => member.subjectType === "user" && member.subjectId === userId)
  );
}

export function aiConnectionService(db: Db) {
  const secrets = secretService(db);
  async function membership(companyId: string, userId: string | null) {
    if (!userId) return false;
    return Boolean(
      (
        await db
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, userId),
              eq(companyMemberships.status, "active"),
            ),
          )
          .limit(1)
      )[0],
    );
  }
  async function rows(companyId: string) {
    return db
      .select({ connection: toolConnections, grant: connectionGrants })
      .from(toolConnections)
      .innerJoin(
        connectionGrants,
        and(
          eq(connectionGrants.companyId, toolConnections.companyId),
          eq(connectionGrants.connectionId, toolConnections.id),
        ),
      )
      .where(
        and(
          eq(toolConnections.companyId, companyId),
          eq(toolConnections.connectionPurpose, "ai"),
        ),
      );
  }
  async function list(
    companyId: string,
    userId: string,
    _agentId?: string,
  ): Promise<AiManagedConnectionSummary[]> {
    const [accounts, defaults, members, owners] =
      await Promise.all([
        rows(companyId),
        db
          .select()
          .from(aiProviderDefaults)
          .where(
            and(
              eq(aiProviderDefaults.companyId, companyId),
              eq(aiProviderDefaults.userId, userId),
            ),
          ),
        db
          .select()
          .from(connectionGrantMembers)
          .where(eq(connectionGrantMembers.companyId, companyId)),
        db
          .select({ id: authUsers.id, name: authUsers.name })
          .from(authUsers)
          .innerJoin(
            companyMemberships,
            and(
              eq(companyMemberships.principalId, authUsers.id),
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
            ),
          ),
      ]);
    return accounts.flatMap(({ connection, grant }) => {
      const metadata = aiConnectionMetadataSchema.safeParse(
        connection.config.ai,
      );
      if (!metadata.success) return [];
      const needsReconnect = aiSubscriptionNeedsIsolatedLogin(connection.config);
      if (!canUseCredential(grant, userId, members.filter((m) => m.grantId === grant.id)))
        return [];
      return [
        {
          id: connection.id,
          grantId: grant.id,
          companyId,
          ...metadata.data,
          usageProbeSupported: supportsAiConnectionUsage(metadata.data.provider, metadata.data.method),
          name: connection.name,
          accountLabel: grant.providerTenant?.name,
          ...(needsReconnect ? { unavailableReason: "Reconnect with a separate sign-in to protect your existing terminal login." } : {}),
          ownership:
            grant.kind === "user" ? ("personal" as const) : ("shared" as const),
          ownerUserId: grant.subjectUserId ?? undefined,
          ownerName:
            owners.find((owner) => owner.id === grant.subjectUserId)?.name ??
            (grant.subjectUserId === userId ? "You" : "Account owner"),
          isDefault: defaults.some((d) => d.grantId === grant.id),
          status:
            grant.status === "revoked"
              ? ("revoked" as const)
              : grant.status === "expired"
                ? ("expired" as const)
                : grant.status !== "active" ||
                    !connection.enabled ||
                    connection.status !== "active" ||
                    connection.healthStatus !== "ok" || needsReconnect
                  ? ("needs_attention" as const)
                  : ("connected" as const),
        },
      ];
    });
  }
  async function setDefault(
    companyId: string,
    userId: string,
    grantId: string,
  ) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ connection: toolConnections, grant: connectionGrants })
        .from(connectionGrants)
        .innerJoin(
          toolConnections,
          eq(toolConnections.id, connectionGrants.connectionId),
        )
        .where(
          and(
            eq(connectionGrants.companyId, companyId),
            eq(connectionGrants.id, grantId),
            eq(connectionGrants.subjectUserId, userId),
            eq(connectionGrants.kind, "user"),
          ),
        )
        .for("update");
      if (!row)
        throw forbidden("Only the owner can choose their personal default");
      if (
        row.connection.connectionPurpose !== "ai" ||
        row.grant.status !== "active" ||
        !row.connection.enabled ||
        row.connection.healthStatus !== "ok"
      )
        throw unprocessable(
          "Reconnect this account before making it your default",
        );
      const metadata = aiConnectionMetadataSchema.parse(row.connection.config.ai);
      if (metadata.routing) throw unprocessable("Custom providers use an explicit connection selection on the agent.");
      // Keep old servers' method preferences intact during an additive rollout.
      await tx.insert(aiConnectionDefaults)
        .values({ companyId, userId, ...metadata, grantId })
        .onConflictDoUpdate({
          target: [aiConnectionDefaults.companyId, aiConnectionDefaults.userId, aiConnectionDefaults.provider, aiConnectionDefaults.method],
          set: { grantId, updatedAt: new Date() },
        });
      await tx.insert(aiProviderDefaults)
        .values({ companyId, userId, provider: metadata.provider, grantId })
        .onConflictDoUpdate({
          target: [aiProviderDefaults.companyId, aiProviderDefaults.userId, aiProviderDefaults.provider],
          set: { grantId, updatedAt: new Date() },
        });
    });
  }
  /** On-demand account observation for either runner; never probes ambient CLI auth. */
  async function probeUsage(companyId: string, userId: string, connectionId: string, grantId?: string): Promise<AiConnectionUsage> {
    if (!(await membership(companyId, userId))) throw forbidden("An active company member is required");
    const candidates = (await rows(companyId)).filter((row) => row.connection.id === connectionId && (!grantId || row.grant.id === grantId));
    const audience = await db.select().from(connectionGrantMembers).where(eq(connectionGrantMembers.companyId, companyId));
    const visible = candidates.filter(({ grant }) => canUseCredential(grant, userId, audience.filter((member) => member.grantId === grant.id)));
    if (!visible.length) throw notFound("AI connection not found");
    if (visible.length > 1) throw unprocessable("Choose a credential grant for this usage check");
    const row = visible[0]!;
    const metadata = aiConnectionMetadataSchema.safeParse(row.connection.config.ai);
    if (!metadata.success) throw notFound("AI connection not found");
    const identity = { connectionId: row.connection.id, grantId: row.grant.id, ...metadata.data };
    const empty = { ...identity, checkedAt: new Date().toISOString(), source: null, planType: null, limits: [], overage: null };
    if (row.grant.status !== "active" || !row.connection.enabled || row.connection.status !== "active" ||
      row.connection.healthStatus !== "ok" || aiSubscriptionNeedsIsolatedLogin(row.connection.config)) {
      return { ...empty, status: "unavailable", errorCode: "connection_unavailable", message: "Reconnect or enable this AI connection before checking usage." };
    }
    if (!supportsAiConnectionUsage(metadata.data.provider, metadata.data.method)) {
      return { ...identity, ...await probeAiConnectionUsage(metadata.data, "") };
    }
    const value = await credential(row);
    return { ...identity, ...await probeAiConnectionUsage(metadata.data, value) };
  }
  async function select(input: {
    companyId: string;
    userId: string | null;
    agentId: string;
    adapterType: string;
    model?: unknown;
    runnerProvider?: unknown;
    acpxAgent?: unknown;
    allowUninstalledPersonal?: boolean;
    allowUninstalledShared?: boolean;
    allowLegacyValidation?: boolean;
    binding: AiConnectionBinding;
  }) {
    const { companyId, userId, agentId, binding } = input;
    if (
      !isAiConnectionCompatible(
        binding,
        input.adapterType,
        input.model,
        input.runnerProvider,
        input.acpxAgent,
      )
    )
      throw aiConnectionConfigurationFailure("ai_connection_incompatible", "Select an AI connection compatible with this harness and model");
    if (binding.mode === "responsible_user" && !userId)
      throw aiConnectionConfigurationFailure("ai_connection_responsible_user_missing", "This run needs a responsible user to select an AI connection");
    if (userId && !(await membership(companyId, userId)))
      throw forbidden("The responsible user is not an active company member");
    const defaultRow =
      binding.mode === "responsible_user"
        ? (
            await db
              .select()
              .from(aiProviderDefaults)
              .where(
                and(
                  eq(aiProviderDefaults.companyId, companyId),
                  eq(aiProviderDefaults.userId, userId!),
                  eq(aiProviderDefaults.provider, binding.provider),
                ),
              )
              .limit(1)
          )[0]
        : null;
    const grantId =
      binding.mode === "responsible_user"
        ? defaultRow?.grantId
        : binding.grantId;
    if (!grantId)
      throw aiConnectionConfigurationFailure("ai_connection_default_missing", "Connect an account and choose your personal default");
    const row = (await rows(companyId)).find(
      (r) =>
        r.grant.id === grantId &&
        (binding.mode === "responsible_user" ||
          r.connection.id === binding.connectionId),
    );
    if (!row)
      throw aiConnectionConfigurationFailure("ai_connection_missing", "The selected AI connection is unavailable");
    const { connection, grant } = row;
    const metadata = aiConnectionMetadataSchema.safeParse(connection.config.ai);
    if (
      !metadata.success ||
      metadata.data.provider !== binding.provider ||
      (binding.mode !== "responsible_user" && metadata.data.method !== binding.method) ||
      !isAiConnectionCompatible(metadata.data, input.adapterType, input.model, input.runnerProvider, input.acpxAgent)
    )
      throw aiConnectionConfigurationFailure("ai_connection_incompatible", "The selected AI connection is incompatible");
    if (aiSubscriptionNeedsIsolatedLogin(connection.config))
      throw aiConnectionConfigurationFailure("ai_connection_unavailable", "Reconnect this subscription with a separate sign-in to protect your existing terminal login.", { connectionId: connection.id });
    if (
      grant.status !== "active" ||
      !connection.enabled ||
      connection.status !== "active" ||
      (connection.healthStatus !== "ok" &&
        !(
          input.allowLegacyValidation &&
          connection.config.aiLegacyAdoption === true
        ))
    )
      throw aiConnectionConfigurationFailure("ai_connection_unavailable", "Reconnect or validate the selected AI account", { connectionId: connection.id });
    if (
      grant.kind === "user" &&
      !(await membership(companyId, grant.subjectUserId))
    )
      throw forbidden(
        "The account owner is no longer an active company member",
      );
    if (
      binding.mode === "responsible_user" &&
      (grant.kind !== "user" || grant.subjectUserId !== userId)
    )
      throw forbidden("The default must belong to the responsible user");
    if (binding.mode === "shared" && grant.kind !== "organization")
      throw forbidden("Select a company-shared account");
    if (binding.mode === "delegated" && grant.kind !== "user")
      throw forbidden("Select a personal account");
    const audience = await db
      .select()
      .from(connectionGrantMembers)
      .where(and(
        eq(connectionGrantMembers.companyId, companyId),
        eq(connectionGrantMembers.grantId, grant.id),
      ));
    // The existing human-access permission is authoritative for every binding,
    // including old explicit personal selections. Agent delegation cannot bypass it.
    if (!canUseCredential(grant, userId, audience)) {
      // Membership was checked above. A known user's sharing choice is an
      // operator action; absent identity must remain an unclassified denial.
      if (userId) throw aiConnectionCredentialNotSharedFailure({ connectionName: connection.name });
      throw forbidden("This credential is not shared with the responsible user");
    }
    const installs = await db
      .select()
      .from(toolConnectionInstalls)
      .where(
        and(
          eq(toolConnectionInstalls.companyId, companyId),
          eq(toolConnectionInstalls.connectionId, connection.id),
          or(
            and(
              eq(toolConnectionInstalls.targetType, "company"),
              eq(toolConnectionInstalls.targetId, companyId),
            ),
            and(
              eq(toolConnectionInstalls.targetType, "agent"),
              eq(toolConnectionInstalls.targetId, agentId),
            ),
          ),
        ),
      );
    if (
      !installs.length &&
      !(
        (input.allowUninstalledPersonal &&
          grant.kind === "user" && grant.subjectUserId === userId) ||
        (input.allowUninstalledShared && binding.mode === "shared" && grant.kind === "organization")
      )
    )
      throw forbidden("This connection is not permitted for this agent");
    return {
      ...row,
      attribution: {
        connectionId: connection.id,
        grantId: grant.id,
        provider: binding.provider,
        method: metadata.data.method,
        mode: binding.mode,
        responsibleUserId: userId,
      } satisfies AiConnectionAttribution,
    };
  }
  /** Internal decision use has its own capability check, never a pretend CLI harness. */
  async function selectDecision(input: {
    companyId: string; connectionId: string; grantId: string;
    userId: string | null; agentId?: string | null; sponsoredBackground?: boolean;
  }) {
    const [row] = await db.select({ connection: toolConnections, grant: connectionGrants })
      .from(toolConnections).innerJoin(connectionGrants, and(
        eq(connectionGrants.connectionId, toolConnections.id), eq(connectionGrants.companyId, toolConnections.companyId),
      )).where(and(eq(toolConnections.companyId, input.companyId), eq(toolConnections.id, input.connectionId),
        eq(connectionGrants.id, input.grantId), eq(toolConnections.connectionPurpose, "ai"))).limit(1);
    if (!row || row.grant.kind !== "organization") throw unprocessable("Shared AI connection unavailable", { code: "connection_unavailable" });
    const metadata = aiConnectionMetadataSchema.safeParse(row.connection.config.ai);
    const provider = metadata.success ? decisionProviderForConnection(metadata.data) : null;
    if (!provider) throw unprocessable("Connection does not support decisions", { code: "incompatible_connection" });
    if (row.grant.status !== "active" || !row.connection.enabled || row.connection.status !== "active" || row.connection.healthStatus !== "ok")
      throw unprocessable("Reconnect or enable this connection", { code: "connection_unavailable" });
    // Only the decision service may sponsor background use; ordinary AI selection never bypasses an audience.
    if (!input.sponsoredBackground) {
      if (!(await membership(input.companyId, input.userId))) throw forbidden("Active responsible user required");
      const audience = await db.select().from(connectionGrantMembers).where(and(
        eq(connectionGrantMembers.companyId, input.companyId), eq(connectionGrantMembers.grantId, input.grantId),
      ));
      if (!canUseCredential(row.grant, input.userId, audience)) throw forbidden("Connection is not shared with this user");
    } else if (input.userId || input.agentId) throw forbidden("Background sponsorship cannot replace caller permissions");
    if (input.agentId) {
      const [install] = await db.select({ id: toolConnectionInstalls.id }).from(toolConnectionInstalls).where(and(
        eq(toolConnectionInstalls.companyId, input.companyId), eq(toolConnectionInstalls.connectionId, input.connectionId),
        or(and(eq(toolConnectionInstalls.targetType, "company"), eq(toolConnectionInstalls.targetId, input.companyId)),
          and(eq(toolConnectionInstalls.targetType, "agent"), eq(toolConnectionInstalls.targetId, input.agentId))),
      )).limit(1);
      if (!install) throw forbidden("Connection is not permitted for this agent");
    }
    return { ...row, provider };
  }
  async function credential(row: Pick<Awaited<ReturnType<typeof select>>, "connection" | "grant">, retry = 0, audit?: { responsibleUserId: string | null; actorType: "user" | "agent" | "system"; actorId: string; issueId?: string | null; heartbeatRunId?: string | null }): Promise<string> {
    const metadata = aiConnectionMetadataSchema.parse(row.connection.config.ai);
    if (metadata.routing?.auth === "none") return "";
    const ref = row.grant.credentialSecretRefs.find(
      (r) => r.configPath === "ai.credential",
    );
    if (!ref)
      throw unprocessable("Reconnect this AI account", {
        code: "ai_connection_credential_missing",
      });
    const [secret] = await db
      .select()
      .from(companySecrets)
      .where(
        and(
          eq(companySecrets.id, ref.secretId),
          eq(companySecrets.companyId, row.connection.companyId),
        ),
      );
    if (!secret)
      throw unprocessable("Reconnect this AI account", {
        code: "ai_connection_credential_missing",
      });
    if (row.grant.kind === "user" && secret.scope !== "user")
      throw forbidden("Credential ownership mismatch");
    if (row.grant.kind === "organization" && secret.scope !== "company") throw forbidden("Credential ownership mismatch");
    const context = {
      consumerType: "tool_connection" as const,
      consumerId: row.connection.id,
      configPath: ref.configPath,
      responsibleUserId: row.grant.subjectUserId,
      actorType: "system" as const,
      ...audit,
    };
    let value: string;
    if (secret.scope === "user") {
      if (
        secret.ownerUserId !== row.grant.subjectUserId ||
        !secret.userSecretDefinitionId
      )
        throw forbidden("Credential ownership mismatch");
      const result = await secrets.resolveUserSecretValue(
        row.connection.companyId,
        {
          definitionId: secret.userSecretDefinitionId,
          responsibleUserId: secret.ownerUserId,
          required: true,
          version: "latest",
        },
        context,
      );
      if (!result) throw unprocessable("Reconnect this AI account");
      value = result.value;
    } else {
      value = await secrets.resolveSecretValue(row.connection.companyId, secret.id, "latest", context);
    }
    // Resolution records lastResolvedAt and can wait behind a rotating writer.
    // Re-read after that wait instead of handing a run the pre-rotation token.
    const [latest] = await db.select().from(companySecrets).where(and(
      eq(companySecrets.id, secret.id), eq(companySecrets.companyId, row.connection.companyId),
    ));
    if (!latest || latest.status !== "active") throw unprocessable("Reconnect this AI account");
    if (latest.latestVersion !== secret.latestVersion) {
      if (retry >= 2) throw unprocessable("AI credentials are changing. Retry this execution.", { code: "ai_connection_busy" });
      return credential(row, retry + 1, audit);
    }
    return value;
  }
  async function save(
    companyId: string,
    userId: string,
    input: CreateAiConnection | AiConnectionLoginIntent,
    verifiedCredential: string,
    sessionId?: string,
    attemptStartedAt = new Date(),
  ) {
    const routing = "routing" in input ? input.routing : undefined;
    if (!(await membership(companyId, userId)))
      throw forbidden("An active company member must own this connection");
    const reconnect = input.connectionId
      ? (await rows(companyId)).find(
          (r) => r.connection.id === input.connectionId,
        )
      : undefined;
    if (input.connectionId && !reconnect)
      throw notFound("AI connection not found");
    if (
      reconnect &&
      (reconnect.grant.createdByUserId !== userId ||
        (reconnect.grant.kind === "user" &&
          reconnect.grant.subjectUserId !== userId))
    )
      throw forbidden("Only the account owner can reconnect it");
    if (
      reconnect &&
      (reconnect.connection.config.ai as AiConnectionMetadata).provider !==
        input.provider
    )
      throw unprocessable("Reconnect cannot change providers");
    if (reconnect && !isDeepStrictEqual((reconnect.connection.config.ai as AiConnectionMetadata).routing, routing))
      throw unprocessable("Reconnect must retain this connection’s routing. Create another connection to change its destination.");
    if (
      reconnect &&
      ((reconnect.connection.config.ai as AiConnectionMetadata).method !==
        input.method ||
        (reconnect.grant.kind === "user") !== (input.ownership === "personal"))
    )
      throw unprocessable(
        "Reconnect cannot change the sign-in method or ownership",
      );
    const id = reconnect?.connection.id ?? randomUUID();
    const grantId = reconnect?.grant.id ?? randomUUID();
    const persist = () => withAccountHomeSecretMutationLock(undefined, companyId, () => db.transaction(async (tx) => {
      const secrets = secretService(tx);
      if (sessionId) {
        const [session] = await tx
          .select()
          .from(adapterAuthSessions)
          .where(
            and(
              input.provider === "anthropic"
                ? eq(adapterAuthSessions.publicSessionId, sessionId)
                : eq(adapterAuthSessions.id, sessionId),
              eq(adapterAuthSessions.companyId, companyId),
              eq(adapterAuthSessions.startedByUserId, userId),
            ),
          )
          .for("update");
        if (!session) throw forbidden("Login session ownership mismatch");
        attemptStartedAt = session.createdAt;

        if (session.connectionId && session.connectionGrantId)
          return {
            connectionId: session.connectionId,
            grantId: session.connectionGrantId,
          };
        if (
          !["promoting", "submitting", "awaiting_code"].includes(
            session.status,
          ) ||
          (session.expiresAt && session.expiresAt.getTime() <= Date.now())
        )
          throw unprocessable("The login attempt is no longer active");
        if (
          !session.aiConnection ||
          session.aiConnection.provider !== input.provider ||
          session.aiConnection.method !== input.method ||
          session.aiConnection.connectionId !== input.connectionId ||
          session.aiConnection.ownership !== input.ownership ||
          session.aiConnection.allAgents !== input.allAgents ||
          JSON.stringify(session.aiConnection.agentIds) !==
            JSON.stringify(input.agentIds)
        )
          throw forbidden("Login target mismatch");
      }
      if (reconnect) {
        const [current] = await tx
          .select()
          .from(connectionGrants)
          .where(eq(connectionGrants.id, grantId))
          .for("update");
        if (
          !current ||
          current.updatedAt.getTime() !== reconnect.grant.updatedAt.getTime() ||
          current.updatedAt.getTime() > attemptStartedAt.getTime()
        )
          throw unprocessable("The connection changed. Start reconnect again.");
      }
      let secretId = reconnect?.grant.credentialSecretRefs.find(
        (r) => r.configPath === "ai.credential",
      )?.secretId;
      // Adoption indexes existing credentials without transferring ownership.
      // Only rotate the private slot created for this grant. A reconnect of an
      // indexed credential must leave every legacy consumer's value untouched,
      // even after adoption has cleared the connection's validation marker.
      if (secretId) {
        const [source] = await tx.select({ name: companySecrets.name, key: userSecretDefinitions.key })
          .from(companySecrets)
          .leftJoin(userSecretDefinitions, eq(userSecretDefinitions.id, companySecrets.userSecretDefinitionId))
          .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, secretId)));
        const privateSlot = input.ownership === "personal"
          ? source?.key === `ai_${grantId.replaceAll("-", "_")}`
          : source?.name === `ai-${grantId}`;
        if (!privateSlot) secretId = undefined;
      }
      if (!verifiedCredential) { secretId = undefined; }
      else if (secretId)
        await secrets.rotate(
          secretId,
          { value: verifiedCredential },
          { userId },
        );
      else if (input.ownership === "personal") {
        const definition = await secrets.createUserSecretDefinition(
          companyId,
          {
            key: `ai_${grantId.replaceAll("-", "_")}`,
            name: input.name,
            provider: "local_encrypted",
          },
          { userId },
        );
        const secret = await secrets.createCurrentUserSecretValue(
          companyId,
          userId,
          { definitionId: definition.id, value: verifiedCredential },
          { userId },
        );
        secretId = secret.id;
      } else
        secretId = (
          await secrets.create(
            companyId,
            {
              name: `ai-${grantId}`,
              provider: "local_encrypted",
              value: verifiedCredential,
            },
            { userId },
          )
        ).id;
      if (input.agentIds.length) {
        const targets = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.companyId, companyId),
              inArray(agents.id, input.agentIds),
            ),
          );
        if (targets.length !== new Set(input.agentIds).size)
          throw forbidden("Agent does not belong to this company");
      }
      const source = aiConnectionCatalogSlug(input.provider, routing);
      const providerName = getAppStoreDefinition(source)?.name ?? AI_CONNECTION_CAPABILITIES[input.provider].name;
      const key = `app-gallery:${source}`;
      await tx
        .insert(toolApplications)
        .values({
          companyId,
          applicationKey: key,
          name: providerName,
          type: "mcp_http",
          metadata: { sourceTemplateKey: source },
          ownerUserId: userId,
        })
        .onConflictDoNothing();
      const [app] = await tx
        .select()
        .from(toolApplications)
        .where(
          and(
            eq(toolApplications.companyId, companyId),
            or(
              eq(toolApplications.applicationKey, key),
              eq(
                toolApplications.name,
                providerName,
              ),
            ),
          ),
        );
      if (!app) throw unprocessable("Could not find the provider application");
      if (reconnect)
        await tx
          .update(toolConnections)
          .set({
            enabled: true,
            status: "active",
            healthStatus: "ok",
            healthMessage: null,
            config: { ...reconnect.connection.config, aiIsolatedSubscription: input.method === "subscription" && input.provider !== "anthropic" },
            updatedAt: new Date(),
          })
          .where(eq(toolConnections.id, id));
      else
        await tx
          .insert(toolConnections)
          .values({
            id,
            companyId,
            applicationId: app.id,
            name: input.name,
            uid: `ai-${id}`,
            connectionPurpose: "ai",
            transport: "runtime_auth",
            authKind: input.method === "api_key" ? "api_key" : "oauth",
            credentialPolicy:
              input.ownership === "personal" ? "per_user" : "shared",
            status: "active",
            enabled: true,
            healthStatus: "ok",
            config: {
              sourceTemplateKey: source,
              ai: { provider: input.provider, method: input.method, ...(routing ? { routing } : {}) },
              aiIsolatedSubscription: input.method === "subscription" && input.provider !== "anthropic",
            },
            createdByUserId: userId,
          });
      let accountLabel: string | undefined;
      if (input.method === "subscription" && input.provider !== "anthropic") {
        try {
          const credential = JSON.parse(verifiedCredential);
          const claims = credential.tokens?.id_token
            ? JSON.parse(
                Buffer.from(
                  credential.tokens.id_token.split(".")[1],
                  "base64url",
                ).toString(),
              )
            : credential;
          const email = claims.email ?? claims.user?.email;
          if (
            typeof email === "string" &&
            /^[^\s@/\\]{1,100}@[^\s@/\\]{1,100}\.[^\s@/\\]{2,40}$/.test(email)
          )
            accountLabel = email;
        } catch {
          /* Safe account identity is optional. */
        }
      }
      const refs = secretId ? [
        {
          secretId: secretId!,
          configPath: "ai.credential",
          required: true,
          versionSelector: "latest" as const,
        },
      ] : [];
      if (reconnect)
        await tx
          .update(connectionGrants)
          .set({
            status: "active",
            providerTenant: accountLabel ? { name: accountLabel } : {},
            credentialSecretRefs: refs,
            revokedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(connectionGrants.id, grantId));
      else
        await tx
          .insert(connectionGrants)
          .values({
            id: grantId,
            companyId,
            connectionId: id,
            kind: input.ownership === "personal" ? "user" : "organization",
            subjectUserId: input.ownership === "personal" ? userId : null,
            isDefault: input.ownership === "shared",
            providerTenant: accountLabel ? { name: accountLabel } : {},
            credentialSecretRefs: refs,
            createdByUserId: userId,
          });
      const [savedConnection] = await tx
        .select()
        .from(toolConnections)
        .where(eq(toolConnections.id, id));
      await syncConnectionCredentialBindings(tx, savedConnection, refs);
      if (input.ownership === "personal" && !routing) {
        await tx
          .insert(aiConnectionDefaults)
          .values({
            companyId,
            userId,
            provider: input.provider,
            method: input.method,
            grantId,
          })
          .onConflictDoNothing();
        await tx.insert(aiProviderDefaults).values({ companyId, userId, provider: input.provider, grantId }).onConflictDoNothing();
      }
      if (!reconnect) {
        const installs = input.allAgents
          ? [{ targetType: "company" as const, targetId: companyId }]
          : input.agentIds.map((targetId) => ({
              targetType: "agent" as const,
              targetId,
            }));
        if (installs.length)
          await tx
            .insert(toolConnectionInstalls)
            .values(
              installs.map((i) => ({
                ...i,
                companyId,
                connectionId: id,
                createdByUserId: userId,
              })),
            );
      }
      if (sessionId)
        await tx
          .update(adapterAuthSessions)
          .set({
            connectionId: id,
            connectionGrantId: grantId,
            connectionMethod: input.method,
            ...(input.provider === "anthropic"
              ? { status: "stored" as const }
              : {}),
          })
          .where(
            input.provider === "anthropic"
              ? eq(adapterAuthSessions.publicSessionId, sessionId)
              : eq(adapterAuthSessions.id, sessionId),
          );
      await logActivity(tx as unknown as Db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: reconnect
          ? "ai_connection.reconnected"
          : "ai_connection.connected",
        entityType: "tool_connection",
        entityId: id,
        details: { provider: input.provider, method: input.method, grantId },
      });
      return { connectionId: id, grantId };
    }));
    // Quota refresh can hold this lock through a 60-second token exchange.
    // Keep the verified sign-in in memory across two 30-second acquisition
    // timeouts instead of making its caller discard a successful login.
    for (let attempt = 0; ; attempt++) {
      try { return await persist(); }
      catch (error) {
        if (attempt >= 2 || (error as NodeJS.ErrnoException)?.code !== WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) throw error;
      }
    }
  }
  async function recoverQuotaCredentialInTransaction(
    tx: Db, row: Parameters<typeof credential>[0], current: string, onRecoveryStarted?: () => void,
  ) {
    const metadata = aiConnectionMetadataSchema.safeParse(row.connection.config.ai);
    if (!metadata.success || metadata.data.provider !== "openai" || metadata.data.method !== "subscription") return null;
    const recovery = quotaCredentialRecovery(row.connection.companyId, row.grant.id);
    const pending = await recovery.read();
    if (!pending) return null;
    const ref = row.grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential");
    if (!ref || pending.secretId !== ref.secretId || pending.connectionId !== row.connection.id || pending.baseHash !== quotaCredentialHash(current)) {
      await recovery.clear();
      return null;
    }
    onRecoveryStarted?.();
    await secretService(tx).rotate(ref.secretId, { value: pending.value, preserveAiSessionEpoch: true }, { userId: row.grant.subjectUserId });
    // Automatic rotation changes secret revision, not the grant mutation marker
    // used to fence reconnect attempts. Ownership and access are unchanged.
    await logActivity(tx, { companyId: row.connection.companyId, actorType: "system", actorId: "quota_recovery",
      action: "ai_connection.credential_refreshed", entityType: "tool_connection", entityId: row.connection.id,
      details: { provider: "openai", grantId: row.grant.id } });
    return pending.value;
  }

  /** Never hand a consumed token to a new provider while its replacement awaits commit. */
  async function runtimeCredential(row: Parameters<typeof credential>[0]) {
    const metadata = aiConnectionMetadataSchema.safeParse(row.connection.config.ai);
    if (!metadata.success || metadata.data.provider !== "openai" || metadata.data.method !== "subscription") return credential(row);
    let savingReplacement = false;
    return withAccountHomeSecretMutationLock(undefined, row.connection.companyId, async () => {
      let recovered = false;
      const value = await db.transaction(async tx => {
        const [grant] = await tx.select().from(connectionGrants).where(and(
          eq(connectionGrants.id, row.grant.id), eq(connectionGrants.companyId, row.connection.companyId),
          eq(connectionGrants.connectionId, row.connection.id),
        )).for("update", { noWait: true });
        if (!grant || grant.status !== "active") throw new Error("credentials_unavailable");
        const ref = grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential");
        if (!ref) throw new Error("credentials_unavailable");
        await tx.select({ id: companySecrets.id }).from(companySecrets).where(and(
          eq(companySecrets.id, ref.secretId), eq(companySecrets.companyId, row.connection.companyId),
        )).for("update", { noWait: true });
        const selected = { connection: row.connection, grant };
        const current = await aiConnectionService(tx as unknown as Db).credential(selected);
        const pending = await recoverQuotaCredentialInTransaction(tx as unknown as Db, selected, current, () => {
          savingReplacement = true;
        });
        recovered = pending !== null;
        return pending ?? current;
      });
      if (recovered) await quotaCredentialRecovery(row.connection.companyId, row.grant.id).clear()
        .catch(error => logger.warn({ err: error, grantId: row.grant.id }, "Saved runtime credential recovery cleanup pending"));
      return value;
    }).catch(error => {
      // Once a matching replacement is found, a failed write or commit must
      // defer execution. Keep its journal so the next attempt can save it.
      if (savingReplacement) {
        throw unprocessable("AI credentials are being updated. Retry shortly.", { code: "ai_connection_busy" });
      }
      // Drizzle wraps Postgres errors in `cause`. Contention is a temporary
      // pre-provider wait, not evidence that this account needs reconnecting.
      let current: unknown = error;
      for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
        const value = current as { code?: unknown; cause?: unknown };
        if (value.code === WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE || value.code === "55P03") {
          throw unprocessable("AI credentials are being updated. Retry shortly.", { code: "ai_connection_busy" });
        }
        current = value.cause;
      }
      throw error;
    });
  }

  /** A late failure must never invalidate credentials that were refreshed or reconnected meanwhile. */
  async function markAuthenticationFailed(input: {
    companyId: string;
    runId?: string;
    agentId?: string;
    runStartedAt: Date;
    attribution: AiConnectionAttribution & { identity: string };
  }) {
    return withAccountHomeSecretMutationLock(undefined, input.companyId, async () => {
      let recovered = false;
      await db.transaction(async (tx) => {
        const { attribution } = input;
        const [grant] = await tx.select().from(connectionGrants).where(and(
          eq(connectionGrants.companyId, input.companyId),
          eq(connectionGrants.id, attribution.grantId),
          eq(connectionGrants.connectionId, attribution.connectionId),
        )).for("update");
        if (!grant || grant.status !== "active" || grant.updatedAt > input.runStartedAt) return;
        const [connection] = await tx.select().from(toolConnections).where(and(
          eq(toolConnections.companyId, input.companyId),
          eq(toolConnections.id, attribution.connectionId),
          eq(toolConnections.connectionPurpose, "ai"),
        ));
        if (!connection) return;
        const metadata = aiConnectionMetadataSchema.safeParse(connection.config.ai);
        if (!metadata.success || metadata.data.provider !== attribution.provider || metadata.data.method !== attribution.method) return;
        const ref = grant.credentialSecretRefs.find((candidate) => candidate.configPath === "ai.credential");
        if (!ref) return;
        await tx.select({ id: companySecrets.id }).from(companySecrets).where(and(
          eq(companySecrets.companyId, input.companyId), eq(companySecrets.id, ref.secretId),
        )).for("update");
        const value = await aiConnectionService(tx as unknown as Db).credential({ connection, grant });
        const generation = createHash("sha256").update(value).digest("hex").slice(0, 16);
        if (attribution.identity !== `${grant.id}:${attribution.responsibleUserId ?? "shared"}:${generation}`) return;
        // A quota exchange may have consumed this run's token before a failed
        // database commit. Save its working replacement instead of revoking it.
        recovered = await recoverQuotaCredentialInTransaction(tx as unknown as Db, { connection, grant }, value) !== null;
        if (recovered) return;
        await tx.update(connectionGrants).set({ status: "needs_reauthorization", updatedAt: new Date() })
          .where(eq(connectionGrants.id, grant.id));
        await tx.update(toolConnections).set({ healthStatus: "error", healthMessage: "Sign in again to restore this AI connection.", updatedAt: new Date() })
          .where(eq(toolConnections.id, connection.id));
        await logActivity(tx as unknown as Db, {
          companyId: input.companyId, actorType: "system", actorId: input.runId ? "heartbeat" : "adapter_test",
          agentId: input.agentId, runId: input.runId, action: "ai_connection.authentication_failed",
          entityType: "tool_connection", entityId: connection.id,
          details: { provider: attribution.provider, grantId: grant.id },
        });
      });
      if (recovered) await quotaCredentialRecovery(input.companyId, input.attribution.grantId).clear()
        .catch(error => logger.warn({ err: error, grantId: input.attribution.grantId }, "Saved failed-run credential recovery cleanup pending"));
    });
  }
  /** Refresh only the selected vaulted identity, serializing rotation and reconnect. */
  async function refreshQuotaCredential(row: Parameters<typeof credential>[0], failedValue: string, signal: AbortSignal) {
    return withAccountHomeSecretMutationLock(undefined, row.connection.companyId, async () => {
      const recovery = quotaCredentialRecovery(row.connection.companyId, row.grant.id);
      let savingReplacement = false;
      const save = () => db.transaction(async (tx) => {
        // Do not wait on a transaction that might itself be waiting for the file
        // lock. All database locks must be available before consuming OAuth tokens.
        const companyId = row.connection.companyId;
        const [grant] = await tx.select().from(connectionGrants).where(and(
          eq(connectionGrants.id, row.grant.id), eq(connectionGrants.companyId, companyId),
          eq(connectionGrants.connectionId, row.connection.id),
        )).for("update", { noWait: true });
        if (!grant || grant.status !== "active") throw new Error("credentials_unavailable");
        const ref = grant.credentialSecretRefs.find(ref => ref.configPath === "ai.credential");
        if (!ref) throw new Error("credentials_unavailable");
        await tx.select({ id: companySecrets.id }).from(companySecrets).where(and(
          eq(companySecrets.id, ref.secretId), eq(companySecrets.companyId, companyId),
        )).for("update", { noWait: true });
        const current = await aiConnectionService(tx as unknown as Db).credential({ connection: row.connection, grant });
        signal.throwIfAborted();
        let pending = await recovery.read();
        if (pending && (pending.secretId !== ref.secretId || pending.connectionId !== row.connection.id || pending.baseHash !== quotaCredentialHash(current))) {
          // Reconnect may reuse this grant. Once the current authorized token
          // itself expires, an older journal must not prevent refreshing it.
          await recovery.clear();
          pending = null;
        }
        // A delayed poll may have read A before B was saved and B's refresh
        // produced an uncommitted C. Recover C before returning or clearing its
        // journal; a newer database credential alone does not prove it is usable.
        if (current !== failedValue && !pending) return current;
        // An active provider may rotate this single-use token itself. Defer polling
        // until its credential write-back instead of invalidating its live copy.
        const [active] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
          .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, companyId))).where(and(
          eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running"]),
          or(sql`${heartbeatRuns.contextSnapshot}->'aiConnection'->>'grantId' = ${grant.id}`,
            sql`${agents.runtimeConfig}->'aiConnection'->>'provider' = 'openai'`, eq(agents.adapterType, "codex_local")),
        )).limit(1);
        if (active && !pending) throw new Error("provider_unavailable");
        let refreshed = pending?.value;
        if (!refreshed) {
          await recovery.prepare();
          const auth = JSON.parse(current);
          const refreshToken = auth.tokens?.refresh_token;
          if (typeof refreshToken !== "string" || !refreshToken) throw new Error("authentication_required");
          // Once exchange starts, its lifetime is independent of the dashboard's
          // shorter deadline. A consumed single-use token must still be read/saved.
          signal.throwIfAborted();
          const refreshSignal = AbortSignal.timeout(60_000);
          // Matches the Codex OAuth client (openai/codex, login/src/auth/manager.rs).
          const response = await fetch("https://auth.openai.com/oauth/token", {
            method: "POST", redirect: "error", signal: refreshSignal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann", grant_type: "refresh_token", refresh_token: refreshToken }),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(response.status === 400 || response.status === 401 ? "authentication_required" : "provider_unavailable");
          }
          const tokens = await response.json() as Record<string, unknown>;
          if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new Error("provider_unavailable");
          refreshed = JSON.stringify({ ...auth, tokens: { ...auth.tokens,
            access_token: tokens.access_token,
            ...(typeof tokens.refresh_token === "string" && tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
            ...(typeof tokens.id_token === "string" && tokens.id_token ? { id_token: tokens.id_token } : {}),
          }, last_refresh: new Date().toISOString() });
          // This fsynced encrypted journal survives transaction rollback and host
          // restart. Never exchange the consumed token again after a failed save.
          await recovery.write({ companyId, grantId: grant.id, connectionId: row.connection.id,
            secretId: ref.secretId, baseHash: quotaCredentialHash(current), value: refreshed });
        }
        savingReplacement = true;
        // Persist the rotated token even if the quota deadline expires after the
        // successful exchange; losing it would strand all subsequent executions.
        await secretService(tx).rotate(ref.secretId, { value: refreshed, preserveAiSessionEpoch: true }, { userId: grant.subjectUserId });
        await logActivity(tx as unknown as Db, { companyId, actorType: "system", actorId: "quota",
          action: "ai_connection.credential_refreshed", entityType: "tool_connection", entityId: row.connection.id,
          details: { provider: "openai", grantId: grant.id } });
        return refreshed;
      });
      for (let attempt = 0; ; attempt++) {
        try {
          const value = await save();
          // Clear only after commit. A committed-but-lost response is detected
          // by the current credential comparison on the next attempt.
          await recovery.clear().catch((error) => logger.warn({ err: error, grantId: row.grant.id }, "Saved quota credential recovery cleanup pending"));
          return value;
        } catch (error) {
          if (!savingReplacement || attempt >= 2) throw error;
          // Saving retries have no provider side effect. Persistent failures
          // retain the journal for the next quota poll, including after restart.
        }
      }
    });
  }
  // A quota read uses the same credential audience as execution. Operator status
  // alone never grants access to another member's personal subscription.
  async function quotaAccounts(companyId: string, userId: string, includeOtherProviders = false) {
    if (!(await membership(companyId, userId))) return [];
    const visible = await list(companyId, userId);
    const accounts = await rows(companyId);
    return accounts.flatMap(row => {
      const summary = visible.find(item => item.id === row.connection.id && item.grantId === row.grant.id);
      if (!summary || summary.method !== "subscription" || !(includeOtherProviders ? ["openai", "anthropic", "xai"] : ["openai", "anthropic"]).includes(summary.provider)) return [];
      return [{ ...row, summary }];
    });
  }
  return { list, selectDecision, quotaAccounts, subscriptionAccounts: (companyId: string, userId: string) => quotaAccounts(companyId, userId, true), refreshQuotaCredential, select, credential, runtimeCredential, probeUsage, save, setDefault, membership, markAuthenticationFailed };
}
