import { agentAppearanceSchema, randomAgentAppearance } from "@paperclipai/shared";
import { normalizePaperclipRunnerAdapterConfig } from "@paperclipai/adapter-utils/server-utils";
import { agents, toolConnectionInstalls, principalPermissionGrants, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { unprocessable } from "../errors.js";
import { isUniqueViolation } from "../db-errors.js";
import { logger } from "../middleware/logger.js";
import { readPlatformDefaultOpenAiKey } from "../secrets/platform-default-openai-key.js";
import { readPlatformDefaultRouterKey } from "../secrets/platform-default-router-key.js";
import { logActivity } from "./activity-log.js";
import type { ActivityPublication } from "../types/activity-publication.js";
import { agentMemoryExcludedSetupKeys } from "./default-mcp-agent-memory.js";
import { isDefaultMcpSpecEnabled, stripReservedDefaultMcpMetadata } from "./default-mcp-spec.js";
import { assertAgentMetadataShape, protectedMetadataReplacement } from "./agent-metadata-protection.js";
import { bindDefaultMcpOwnerForApproval, resolveCreatorOwnerUserId, snapshotDefaultMcpForNewAgent } from "./default-mcp-setup.js";
import {
  PLATFORM_DEFAULT_OPENAI_SECRET,
  PLATFORM_DEFAULT_ROUTER_SECRET,
  applyHermesRouterProviderDefault,
  assertExpectedCreateDefaults,
  needsPlatformDefaultOpenAiKey,
  needsPlatformDefaultRouterKey,
  projectHermesCreateDefaults,
} from "./hermes-create-defaults.js";
import { applyPiRouterDefaults, needsPlatformDefaultRouterKeyForPi } from "./pi-create-defaults.js";
import { agentRecordQueries, isPlainRecord, configPatchFromApprovalPayload, normalizeRuntimeConfigForNewAgent,
  deduplicateAgentName, type CreateAgentData, type CreateAgentOptions, type AgentConfigurationPatch, type AgentHireRecord } from "../lib/agent-records.js";
import { normalizeAgentPermissions, permissionsImplyLowTrust, NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS,
  newStandardAgentGrantScope } from "../lib/agent-permissions.js";
import { readBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { secretService, assertClaudeOAuthBindingInvariant, isSecretNameOrKeyConflict } from "./secrets.js";
import { agentCredentialService } from "./agent-credentials.js";
import { agentIdentityService } from "./agent-identity.js";
import { initializePrimaryAgent } from "./primary-agent.js";
import { resolveNewAgentRunnerForCompany } from "./agent-runner-selection.js";

type PlatformDefaultSecretOutcome = NonNullable<CreateAgentOptions["_platformDefaultSecretOutcome"]>;

/**
 * Bind a deployment platform default key (OpenAI or Ramp Router; a company secret) for a new Hermes agent. Runs inside the
 * hire transaction: the advisory lock serializes concurrent hires for the company, and each attempt runs in a
 * savepoint so a unique-violation does not abort the surrounding transaction.
 */
export async function ensurePlatformDefaultSecret(
  txDb: Db,
  companyId: string,
  secret: { key: string; name: string; description: string },
  value: string,
  unavailableMessage: string,
  options?: CreateAgentOptions,
): Promise<PlatformDefaultSecretOutcome> {
  await txDb.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${"paperclip:platform-default-secret:" + companyId + ":" + secret.key}, 0))`,
  );
  const defaultKeyInput = {
    ...secret,
    value,
  };
  const testHook = options?._testBeforeEnsureSecretCreate;
  const runInSavepoint = async <T>(fn: (spDb: Db) => Promise<T>): Promise<T> => {
    if (typeof (txDb as any).transaction === "function") {
      return (txDb as any).transaction(async (sp: any) => fn(sp as unknown as Db));
    }
    return fn(txDb);
  };
  const unavailable = () => unprocessable(
    unavailableMessage,
    { code: "platform_default_secret_unavailable" },
  );
  try {
    return await runInSavepoint((spDb) =>
      secretService(spDb).ensurePlatformDefaultCompanySecret(
        companyId,
        { ...defaultKeyInput, testBeforeCreate: testHook ? () => testHook(secret.key) : undefined },
        options?.actor,
      ));
  } catch (err) {
    if (isUniqueViolation(err) || isSecretNameOrKeyConflict(err)) {
      try {
        return await runInSavepoint(async (spDb): Promise<PlatformDefaultSecretOutcome> => {
          const svc = secretService(spDb);
          const existingByKey = await svc.getByKey(companyId, secret.key);
          if (existingByKey) {
            return existingByKey.status === "active"
              ? { outcome: "reused", secretId: existingByKey.id }
              : { outcome: "skipped_inactive_existing", secretId: null };
          }
          const existingByName = await svc.getByName(companyId, defaultKeyInput.name);
          if (existingByName) return { outcome: "skipped_name_conflict", secretId: null };
          throw unavailable();
        });
      } catch {
        throw unavailable();
      }
    }
    logger.warn(
      {
        companyId,
        code: "platform_default_secret_unavailable",
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
      },
      "platform default secret unavailable during agent creation",
    );
    throw unavailable();
  }
}

export async function prepareAgentHire(db: Db, companyId: string, input: CreateAgentData, options?: CreateAgentOptions): Promise<CreateAgentData> {
  const { runner, ...data } = input;
  const selection = options?.runnerResolved
    ? { adapterType: data.adapterType ?? "process", adapterConfig: isPlainRecord(data.adapterConfig) ? data.adapterConfig : {} }
    : await resolveNewAgentRunnerForCompany(db, companyId, {
        ...data, adapterConfig: isPlainRecord(data.adapterConfig) ? data.adapterConfig : {}, runner,
      });
  data.adapterType = selection.adapterType;
  data.adapterConfig = selection.adapterConfig;
  const { ensureManager, assertBuiltInAgentMetadataMutationAllowed } = agentRecordQueries(db);
  assertAgentMetadataShape(data.metadata);
  if (data.appearance?.customAvatarAssetId) throw unprocessable("Create the agent before uploading its avatar");
  assertBuiltInAgentMetadataMutationAllowed(null, data.metadata, options);
  if (data.reportsTo) {
    await ensureManager(companyId, data.reportsTo);
  }

  const existingAgents = await db
    .select({ id: agents.id, name: agents.name, status: agents.status })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const uniqueName = deduplicateAgentName(data.name, existingAgents.filter(agent => agent.id !== options?.setupAgentId));

  const role = data.role ?? "general";
  const normalizedPermissions = normalizeAgentPermissions(data.permissions, { context: "create" });
  const runtimeConfig = normalizeRuntimeConfigForNewAgent(data.runtimeConfig);
  const adapterType = data.adapterType ?? "process";

  // TECH-7959: judged on the caller's raw (pre-binding) config, like the OpenAI predicate.
  const defaultRouterKey = readPlatformDefaultRouterKey();
  const needsDefaultRouterKey = needsPlatformDefaultRouterKey(adapterType, data.adapterConfig, Boolean(defaultRouterKey));
  const needsPiRouterKey = needsPlatformDefaultRouterKeyForPi(adapterType, data.adapterConfig, Boolean(defaultRouterKey));
  const defaultOpenAiKey = readPlatformDefaultOpenAiKey();
  const needsDefaultOpenAiKey = needsPlatformDefaultOpenAiKey(adapterType, data.adapterConfig, Boolean(defaultOpenAiKey));

  const rawAdapterConfig = isPlainRecord(data.adapterConfig)
    ? await secretService(db).normalizeAdapterConfigForPersistence(companyId, data.adapterConfig, { adapterType })
    : {};
  let adapterConfig = normalizePaperclipRunnerAdapterConfig(adapterType, rawAdapterConfig);

  // Fixed order (and so a consistent advisory-lock order): Router first, then OpenAI. A skipped Router
  // secret (inactive existing / name conflict) binds nothing, and the rest of this create then behaves
  // exactly as it did before TECH-7959.
  let platformDefaultRouterKeyBound = false;
  if (needsDefaultRouterKey || needsPiRouterKey) {
    const outcome = await ensurePlatformDefaultSecret(
      db, companyId, PLATFORM_DEFAULT_ROUTER_SECRET, defaultRouterKey!,
      "The platform default Ramp Router key could not be stored; the agent was not created.", options,
    );
    if (options) options._platformDefaultRouterSecretOutcome = outcome;
    if (outcome.secretId) {
      if (needsPiRouterKey) {
        adapterConfig = applyPiRouterDefaults(adapterConfig, outcome.secretId);
      } else {
        platformDefaultRouterKeyBound = true;
        const existingEnv = isPlainRecord(adapterConfig.env) ? { ...adapterConfig.env } : {};
        existingEnv.RAMP_ROUTER_API_KEY = { type: "secret_ref", secretId: outcome.secretId, version: "latest" };
        adapterConfig = { ...adapterConfig, env: existingEnv };
      }
    }
  }
  // Unchanged OpenAI attempt: kept even on a Router agent, because native mem0 memory needs it.
  let platformDefaultOpenAiKeyBound = false;
  if (needsDefaultOpenAiKey) {
    const outcome = await ensurePlatformDefaultSecret(
      db, companyId, PLATFORM_DEFAULT_OPENAI_SECRET, defaultOpenAiKey!,
      "The platform default OpenAI key could not be stored; the agent was not created.", options,
    );
    if (options) options._platformDefaultSecretOutcome = outcome;
    if (outcome.secretId) {
      platformDefaultOpenAiKeyBound = true;
      const existingEnv = isPlainRecord(adapterConfig.env) ? { ...adapterConfig.env } : {};
      existingEnv.OPENAI_API_KEY = { type: "secret_ref", secretId: outcome.secretId, version: "latest" };
      adapterConfig = { ...adapterConfig, env: existingEnv };
    }
  }

  // Create-only default (TECH-7895). The update path deliberately keeps an existing agent's provider
  // untouched, so there is no migration or backfill.
  //
  // This runs after the platform-default secret step on purpose: ensurePlatformDefaultOpenAiSecret can
  // return skipped_inactive_existing / skipped_name_conflict with secretId=null, in which case NO
  // OPENAI_API_KEY is bound. Then the agent really is credential-free, so the Router default applies
  // instead of being suppressed for a credential that was never bound.
  const beforeRouterDefault = adapterConfig;
  adapterConfig = applyHermesRouterProviderDefault({
    adapterType,
    adapterConfig,
    bindsPlatformDefaultOpenAiKey: platformDefaultOpenAiKeyBound,
    bindsPlatformDefaultRouterKey: platformDefaultRouterKeyBound,
  });
  // Optional preflight consistency assertion, after the ACTUAL platform binding and Router default and
  // before any insert: a mismatch throws inside the hire transaction, rolling back every side effect
  // (including a platform-default secret created above).
  if (options?.expectedCreateDefaults && adapterType === "hermes_local") {
    assertExpectedCreateDefaults(
      options.expectedCreateDefaults,
      projectHermesCreateDefaults({
        before: beforeRouterDefault,
        after: adapterConfig,
        platformDefaultOpenAiKeyBound: platformDefaultOpenAiKeyBound,
        platformDefaultRouterKeyBound,
      }),
    );
  }

  // Run the binding invariant after generic normalization and the Router default, before any write.
  await agentCredentialService(db).enforceClaudeOAuthBindingClaim(db, {
    companyId, consume: true, environmentId: data.defaultEnvironmentId ?? null,
    childAdapterConfig: adapterConfig, claudeLogin: options?.claudeLogin,
    decision: assertClaudeOAuthBindingInvariant({ adapterType, nextConfig: adapterConfig }),
  });
  return { ...data, name: uniqueName,
    // `defaultMcp` is server-managed; a caller-supplied value is discarded.
    ...(data.metadata !== undefined ? { metadata: stripReservedDefaultMcpMetadata(data.metadata) } : {}),
    appearance: data.appearance == null ? randomAgentAppearance() : agentAppearanceSchema.parse(data.appearance),
    role, adapterType, adapterConfig, permissions: normalizedPermissions, runtimeConfig };
}

export async function initializeAgentHire(txDb: Db, created: AgentHireRecord, options?: CreateAgentOptions, publications?: ActivityPublication[]) {
  const tx = txDb;
  const companyId = created.companyId;
  await agentIdentityService(txDb).ensureAgentIdentity(companyId, created.id);
  // New standard agents receive the standard direct grants at activation.
  // Low-trust and bundled agents keep their explicit, narrower grants.
  if (!options?.setupOnly && created.status !== "pending_approval" && !permissionsImplyLowTrust(created.permissions) &&
      !readBuiltInAgentMarker(created.metadata)) {
    await tx.insert(principalPermissionGrants).values(
      NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS.map((permissionKey) => ({
        companyId,
        principalType: "agent" as const,
        principalId: created.id,
        permissionKey,
        scope: newStandardAgentGrantScope(permissionKey, created.id),
      })),
    ).onConflictDoNothing();
  }
  if (isDefaultMcpSpecEnabled()) {
    // Durable per-agent default (OFF unless the spec says otherwise), committed with the agent row.
    await snapshotDefaultMcpForNewAgent(txDb, {
      companyId,
      agentId: created.id,
      existingMetadata: created.metadata,
      // Verified human actor, derived by the route from `req.actor`. For an agent actor it is the
      // creating agent's own owner (resolveCreatorOwnerUserId); null for built-ins and plugins.
      // Nothing in the request body can set it.
      ownerUserId:
        options?.claudeLogin?.ownerUserId ??
        (await resolveCreatorOwnerUserId(txDb, companyId, options?.defaultMcpCreatorAgentId)),
      status: created.status,
      installDedicatedOnReady: true,
      newAgentCreation: true,
      // Agent memory (TECH-8409) is offered only to new agents of a profiled adapter (Hermes or Claude local) while the
      // server enables it; the memory tools (TECH-8832) only to Claude and Codex agents while their own flag is on.
      ...(() => {
        const excluded = agentMemoryExcludedSetupKeys(created.adapterType, created.adapterConfig);
        return excluded.size > 0 ? { excludedSetupKeys: excluded } : {};
      })(),
    });
  }
  if (options?.aiConnectionInstall) {
    const install = options.aiConnectionInstall;
    const connectionIds = [...new Set([install.connectionId, ...(install.memberConnectionIds ?? [])])];
    await tx.insert(toolConnectionInstalls).values(connectionIds.map(connectionId => ({
      companyId, connectionId,
      targetType: "agent" as const, targetId: created.id,
      createdByUserId: install.createdByUserId,
    }))).onConflictDoNothing();
  }
  await agentCredentialService(txDb).syncAgentSecretBindings(created, txDb);
  const logPlatformDefaultOutcome = async (
    outcome: PlatformDefaultSecretOutcome,
    meta: { actorId: string; secretKey: string; source: string },
  ) => {
    await logActivity(
      txDb,
      {
        companyId,
        actorType: "system",
        actorId: meta.actorId,
        action:
          outcome.outcome === "created" || outcome.outcome === "reused"
            ? "secret.platform_default.bound"
            : "secret.platform_default.skipped",
        entityType: "agent",
        entityId: created.id,
        details: {
          secretId: outcome.secretId ?? undefined,
          secretKey: meta.secretKey,
          outcome: outcome.outcome,
          source: meta.source,
        },
        responsibleUserIdOverride: options?.actor?.userId ?? undefined,
      },
      publications,
    );
  };
  if (options?._platformDefaultRouterSecretOutcome) {
    await logPlatformDefaultOutcome(options._platformDefaultRouterSecretOutcome, {
      actorId: "platform-default-router-key",
      secretKey: PLATFORM_DEFAULT_ROUTER_SECRET.key,
      source: "deployment_env:PAPERCLIP_DEFAULT_ROUTER_API_KEY",
    });
  }
  if (options?._platformDefaultSecretOutcome) {
    await logPlatformDefaultOutcome(options._platformDefaultSecretOutcome, {
      actorId: "platform-default-openai-key",
      secretKey: PLATFORM_DEFAULT_OPENAI_SECRET.key,
      source: "deployment_env:PAPERCLIP_DEFAULT_OPENAI_API_KEY",
    });
  }
  if (!options?.setupOnly && options?.createdByUserId && !readBuiltInAgentMarker(created.metadata)) {
    await initializePrimaryAgent(txDb, companyId, options.createdByUserId, created.id);
  }
}

export async function prepareAgentHireApproval(txDb: Db, existing: AgentHireRecord, approvedPayload?: Record<string, unknown> | null): Promise<AgentConfigurationPatch> {
  const approvedPatch = approvedPayload ? configPatchFromApprovalPayload(approvedPayload) : {};
  const patch = { ...approvedPatch } as AgentConfigurationPatch;
  const hasApprovedAdapterConfig = Object.prototype.hasOwnProperty.call(patch, "adapterConfig") && isPlainRecord(patch.adapterConfig);
  if (
    Object.prototype.hasOwnProperty.call(patch, "adapterConfig") &&
    isPlainRecord(patch.adapterConfig)
  ) {
    const normalizedAdapterConfig = await secretService(txDb).normalizeAdapterConfigForPersistence(
      existing.companyId, patch.adapterConfig, { adapterType: (patch.adapterType ?? existing.adapterType) as string },
    );
    patch.adapterConfig = normalizePaperclipRunnerAdapterConfig(
      (patch.adapterType ?? existing.adapterType) as string,
      normalizedAdapterConfig,
    );
  } else if (
    Object.prototype.hasOwnProperty.call(patch, "adapterType")
    && isPlainRecord(existing.adapterConfig)
  ) {
    patch.adapterConfig = normalizePaperclipRunnerAdapterConfig(
      patch.adapterType as string,
      existing.adapterConfig,
    );
  }
  if (patch.permissions !== undefined) {
    // The pending-approval activation replays the original hire
    // request, so the new-agent creation default applies.
    patch.permissions = normalizeAgentPermissions(patch.permissions, { context: "create" });
  }
  if (patch.metadata !== undefined) {
    // Replayed hire metadata goes through the same protected merge as any update.
    patch.metadata = protectedMetadataReplacement(patch.metadata) as unknown as AgentConfigurationPatch["metadata"];
  }
  if (hasApprovedAdapterConfig) {
    await agentCredentialService(txDb).enforceClaudeOAuthBindingClaim(txDb, {
      companyId: existing.companyId, consume: false, environmentId: null,
      childAdapterConfig: patch.adapterConfig,
      decision: assertClaudeOAuthBindingInvariant({ adapterType: patch.adapterType ?? existing.adapterType,
        nextConfig: patch.adapterConfig, priorConfig: existing.adapterConfig }),
    });
  }
  return patch;
}

export async function completeAgentHireApproval(
  txDb: Db,
  updated: AgentHireRecord,
  existing: AgentHireRecord,
  options?: { approverUserId?: string | null },
) {
  const tx = txDb;
  if (isDefaultMcpSpecEnabled()) {
    // Atomically with the activation and BEFORE the post-commit schedule: the verified approver
    // (an active member of this company) becomes the owner only where none was recorded.
    await bindDefaultMcpOwnerForApproval(txDb, {
      companyId: existing.companyId,
      agentId: updated.id,
      approverUserId: options?.approverUserId,
    });
  }
  await agentCredentialService(txDb).syncAgentSecretBindings(updated, txDb, existing.adapterConfig);
  if (!permissionsImplyLowTrust(updated.permissions) && !readBuiltInAgentMarker(updated.metadata)) {
    await tx.insert(principalPermissionGrants).values(
      NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS.map((permissionKey) => ({
        companyId: updated.companyId,
        principalType: "agent" as const,
        principalId: updated.id,
        permissionKey,
        scope: newStandardAgentGrantScope(permissionKey, updated.id),
      })),
    ).onConflictDoNothing();
  }
}
