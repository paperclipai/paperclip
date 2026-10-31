import { agentHarnessType } from "@paperclipai/shared";
import { observabilitySecretValues } from "@paperclipai/adapter-utils/agent-observability";
import { agentObservabilityService, unavailableAgentObservability, type ResolvedAgentObservability } from "../agent-observability.js";
import { agentObservabilityLaunch } from "../agent-observability-launch.js";
import { withSkillActor } from "../skill-access.js";
import type { AuthorizationActor } from "../authorization.js";
import { eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db, type agents, type projects } from "@paperclipai/db";
import type { AiConnectionBinding } from "@paperclipai/shared";
import { readPaperclipSkillSyncPreference, resolvePaperclipDesiredSkillNames, resolveLegacyPaperclipDesiredSkillNames,
  writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { parseObject } from "../../adapters/utils.js";
import { logger } from "../../middleware/logger.js";
import { AI_CONNECTION_BUSY_RETRY_REASON, extractWakeCommentIds, isNonAssigneeWorkspaceBusyRetry } from "../../modules/run-dispatch/index.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { agentIdentityService, supportsManagedAgentIdentity } from "../agent-identity.js";
import { readAiConnectionConfigurationFailure, readAiCredentialAccessFailure } from "../ai-connection-configuration-failure.js";
import { AI_AUTH_ENV_KEYS, isAiConnectionBusy, prepareManagedAiRuntime, stripAiAuthBindings } from "../ai-connection-runtime.js";
import { managedAiSessionIdentityCompatible } from "../ai-connection-session.js";
import type { companySkillService } from "../company-skills.js";
import { connectionIntentService } from "../connection-intents.js";
import { prepareConnectionInstructionDelivery } from "../connection-instructions.js";
import { applyConnectorSkills, prepareConnectorSkillDelivery, resolveConnectorAssignments } from "../connector-runtime.js";
import { resolveManagedGitHubIdentitySelection } from "../git-credentials.js";
import { resolveAssignedConnectionInstructionsForRun } from "../native-runtime/assigned-mcp-tools.js";
import { recordFailedSkillPreparation, type NativeRunHistoricalSpan } from "../native-runtime/native-run-trace.js";
import { collectRunFailureSecretValues } from "../run-failure-diagnostics.js";
import { skillVersionSelectionMap } from "../runtime-skill-selections.js";
import { environmentSkillConfig } from "../environment-skills.js";
import type { selectHeartbeatEnvironment } from "./environment-selection.js";
import type { createHeartbeatRetries } from "./retries.js";
import type { createHeartbeatLifecycle } from "./run-lifecycle.js";
import { createHeartbeatPreparationTiming } from "./preparation-timing.js";
import {
  ConfigurationIncompleteFailure, applyRunScopedMentionedSkillKeys, resolveExecutionRunAdapterConfig,
  resolveRunScopedMentionedSkillKeys, type createHeartbeatRunPreparation, type resolveAcceptedPlanWakeRoutingDecision,
} from "./run-preparation.js";
import { buildExecutionWorkspaceConfigSnapshot, stripWorkspaceRuntimeFromExecutionRunConfig } from "./workspaces.js";
import type { HeartbeatWorkspacePreparationInput } from "./workspace-preparation.js";

const ACCEPTED_PLAN_CONVERSION_SKILL_KEY =
  "paperclipai/paperclip/paperclip-converting-plans-to-tasks";

type ManagedAiRuntime = Awaited<ReturnType<typeof prepareManagedAiRuntime>>;
type EnvironmentSelection = Awaited<ReturnType<typeof selectHeartbeatEnvironment>>;

/** Preparation and routing must use the same immutable mode as native recovery. */
export function bindHeartbeatRunnerHomeMode(config: Record<string, unknown>, persistedExecution: unknown): Record<string, unknown> {
  const saved = parseObject(persistedExecution);
  if (Object.keys(saved).length === 0) return config;
  // Execution schemas before v7 always used isolated homes.
  return { ...config, homeMode: saved.homeMode ?? "isolated" };
}

export interface HeartbeatExecutionConfigurationInput {
  run: typeof heartbeatRuns.$inferSelect;
  agent: typeof agents.$inferSelect;
  task: {
    issueId: string | null;
    context: Record<string, unknown>;
    responsibleUserId: string | null;
    acceptedPlanContinuationWake: boolean;
    acceptedPlanWakeRoutingDecision: Awaited<ReturnType<typeof resolveAcceptedPlanWakeRoutingDecision>> | null;
    taskProjectContext: Pick<typeof projects.$inferSelect, "id" | "env"> | null;
    routineEnvContext: Awaited<ReturnType<ReturnType<typeof createHeartbeatRunPreparation>["getRoutineEnvForExecutionIssue"]>>;
    /** Resolved from the durable Studio test row by task-context, never wake input. */
    pinnedSkillTest?: { key: string; versionId: string } | null;
  };
  config: {
    sourceWorkspaceConfig: Record<string, unknown>;
    aiBinding: AiConnectionBinding | undefined;
  };
  policy: Pick<HeartbeatWorkspacePreparationInput["policy"],
    "trustPreset" | "useIsolatedTaskDirectory" | "requestedExecutionWorkspaceMode"> & { explicitTaskDirectory: boolean };
  environment: Pick<EnvironmentSelection,
    "selectedEnvironmentId" | "selectedEnvironmentForConfig" | "resolvedInstanceSettings" | "persistedNativeExecutionInput">;
  services: {
    secretsSvc: Parameters<typeof resolveExecutionRunAdapterConfig>[0]["secretsSvc"];
    companySkills: Pick<ReturnType<typeof companySkillService>, "withRuntimeSkillEntries">;
    appendRunEvent: ReturnType<typeof createHeartbeatLifecycle>["appendRunEvent"];
    finalizeAiConnectionBusyDeferral: ReturnType<typeof createHeartbeatRetries>["finalizeAiConnectionBusyDeferral"];
  };
  // The executor must observe these before a later preparation step can throw.
  onFailureSecretsResolved: (readSecrets: () => string[]) => void;
  onManagedAiRuntimeAcquired: (runtime: ManagedAiRuntime) => void;
  onIdentityRedactorPrepared: (redactor: ReturnType<typeof createAgentIdentityRedactor>) => void;
}

/** Assembles effective run configuration; the executor retains cleanup ownership. */
export async function prepareHeartbeatExecutionConfiguration(db: Db, input: HeartbeatExecutionConfigurationInput) {
  const { run, agent, onFailureSecretsResolved, onManagedAiRuntimeAcquired, onIdentityRedactorPrepared } = input;
  const time = createHeartbeatPreparationTiming(run.id);
  const { issueId, context, responsibleUserId, acceptedPlanContinuationWake, acceptedPlanWakeRoutingDecision, taskProjectContext, routineEnvContext, pinnedSkillTest } = input.task;
  const { selectedEnvironmentId, selectedEnvironmentForConfig, resolvedInstanceSettings, persistedNativeExecutionInput } = input.environment;
  const sourceWorkspaceConfig = agent.adapterType === "paperclip_runner"
    ? { ...input.config.sourceWorkspaceConfig,
        homeMode: bindHeartbeatRunnerHomeMode(parseObject(agent.adapterConfig), persistedNativeExecutionInput).homeMode }
    : input.config.sourceWorkspaceConfig;
  const preconfiguredHome = agent.adapterType === "paperclip_runner" && sourceWorkspaceConfig.homeMode === "preconfigured";
  if (preconfiguredHome && pinnedSkillTest) {
    throw new ConfigurationIncompleteFailure("Skill tests require an isolated Runner home to deliver the saved version.", {
      configurationIncomplete: { reason: "skill_unavailable", actionUrl: `/agents/${agent.id}/runtime` },
    });
  }
  const initialHarness = agentHarnessType(agent.adapterType, sourceWorkspaceConfig);
  const observabilityKind = (harness: string) => harness === "codex_local" ? "codex" as const
    : harness === "claude_local" ? "claude" as const
      : harness === "opencode_local" && agent.adapterType === "paperclip_runner" ? "opencode" as const : undefined;
  const unsupportedObservability = !observabilityKind(initialHarness)
    ? "unsupported_harness" as const : preconfiguredHome && initialHarness === "codex_local" ? "unsupported_home_mode" as const : undefined;
  const observabilitySnapshot: ResolvedAgentObservability = await agentObservabilityService(db).resolve(agent.companyId, { runId: run.id, agentId: agent.id, responsibleUserId, issueId, unavailableReason: unsupportedObservability })
    .catch(() => unavailableAgentObservability(agent.companyId, "configuration_invalid"));
  const identityRedactor = createAgentIdentityRedactor();
  const earlyObservability = unsupportedObservability === undefined && observabilityKind(initialHarness)
    ? agentObservabilityLaunch(observabilitySnapshot, { kind: observabilityKind(initialHarness)!, companyId: agent.companyId, agentId: agent.id }) : undefined;
  identityRedactor.values.push(...observabilitySecretValues(earlyObservability));
  onIdentityRedactorPrepared(identityRedactor);
  // The executor keeps these values in its failure redactor before any later
  // preparation step can fail. Subsequent provider/identity values extend it.
  onFailureSecretsResolved(() => []);
  const aiBinding = preconfiguredHome ? undefined : input.config.aiBinding;
  const { trustPreset, useIsolatedTaskDirectory, explicitTaskDirectory, requestedExecutionWorkspaceMode } = input.policy;
  const { secretsSvc, companySkills, appendRunEvent, finalizeAiConnectionBusyDeferral } = input.services;
  let managedAiRuntime: ManagedAiRuntime | undefined;
  const forceDirectoryStrategy = useIsolatedTaskDirectory || (explicitTaskDirectory && (
    requestedExecutionWorkspaceMode === "agent_default" || Object.keys(parseObject(sourceWorkspaceConfig.workspaceStrategy)).length > 0
  ));
  const mergedConfig = {
    ...sourceWorkspaceConfig,
    // The base below is already task-owned. Keep directory transport while
    // preserving isolated mode and the mandatory sandbox preflight.
    ...(forceDirectoryStrategy ? { workspaceStrategy: { type: "project_primary" } } : {}),
  };
  const configSnapshot = buildExecutionWorkspaceConfigSnapshot(
    mergedConfig,
    selectedEnvironmentId,
  );
  const executionRunConfig =
    stripWorkspaceRuntimeFromExecutionRunConfig(mergedConfig);
  const skillActor: AuthorizationActor = { type: "agent", agentId: agent.id, companyId: agent.companyId,
    runId: run.id, source: "agent_jwt", onBehalfOfUserId: responsibleUserId === "local-board" ? null : responsibleUserId };
  const [mentionedSkills, githubIdentity] = await Promise.allSettled([
    preconfiguredHome || pinnedSkillTest ? Promise.resolve([]) : time("configuration_mentions", () => resolveRunScopedMentionedSkillKeys({
      db,
      companyId: agent.companyId,
      issueId,
      commentIds: extractWakeCommentIds(context),
      actor: skillActor,
    })),
    time("configuration_github_identity", () => resolveManagedGitHubIdentitySelection(db, agent.companyId, {
      agentId: agent.id, responsibleUserId, allowStandingDelegation: false,
    })),
  ]);
  if (mentionedSkills.status === "rejected") throw mentionedSkills.reason;
  if (githubIdentity.status === "rejected") throw githubIdentity.reason;
  const runScopedMentionedSkillKeys = mentionedSkills.value;
  const runScopedSkillKeys =
    !pinnedSkillTest && acceptedPlanContinuationWake &&
    !acceptedPlanWakeRoutingDecision?.suppressAcceptedContinuation
      ? [...runScopedMentionedSkillKeys, ACCEPTED_PLAN_CONVERSION_SKILL_KEY]
      : runScopedMentionedSkillKeys;
  const githubSelection = githubIdentity.value;
  const useHostGitHub =
    !githubSelection.configured &&
    trustPreset.kind === "standard" &&
    ["local", "ssh"].includes(
      selectedEnvironmentForConfig?.driver ?? "local",
    );

  const { resolvedConfig, configuredTaskEnvironment, secretKeys, secretManifest } =
    await time("configuration_secrets", () => resolveExecutionRunAdapterConfig({
      managedAiCredentials: Boolean(aiBinding),
      managedGitHubCredentials: !useHostGitHub,
      companyId: agent.companyId,
      agentId: agent.id,
      adapterType: agent.adapterType,
      issueId,
      heartbeatRunId: run.id,
      environmentId: selectedEnvironmentForConfig?.id ?? null,
      environmentEnv: aiBinding ? stripAiAuthBindings(selectedEnvironmentForConfig?.envVars) : selectedEnvironmentForConfig?.envVars ?? null,
      environmentDriver: selectedEnvironmentForConfig?.driver ?? null,
      projectId: taskProjectContext?.id ?? null,
      routineId: routineEnvContext.routineId,
      responsibleUserId,
      executionRunConfig: aiBinding ? { ...executionRunConfig, env: stripAiAuthBindings(executionRunConfig.env) } : executionRunConfig,
      projectEnv: aiBinding ? stripAiAuthBindings(taskProjectContext?.env) : taskProjectContext?.env ?? null,
      routineEnv: aiBinding ? stripAiAuthBindings(routineEnvContext.env) : routineEnvContext.env,
      secretsSvc,
      trustPreset,
    }));
  onFailureSecretsResolved(() => collectRunFailureSecretValues(resolvedConfig.env, secretKeys));
  if (aiBinding) {
    try {
      managedAiRuntime = await time("configuration_ai_runtime", () => prepareManagedAiRuntime(db, { companyId: agent.companyId, agentId: agent.id, responsibleUserId, adapterType: agent.adapterType, binding: aiBinding, config: resolvedConfig }));
      onManagedAiRuntimeAcquired(managedAiRuntime);
    } catch (error) {
      // Only fresh executions can receive a pre-provider wait receipt. A
      // persisted native input may already have provider effects to recover.
      if (isAiConnectionBusy(error) && !persistedNativeExecutionInput) {
        // Use the authority recorded by the locked admission gate, never
        // the issue's mutable assignee observed during runtime preparation.
        const authorizedNonAssigneeWake =
          parseObject(run.runnerProfileJson).aiConnectionNonAssigneeCommentWake === true ||
          (run.scheduledRetryReason === AI_CONNECTION_BUSY_RETRY_REASON &&
            isNonAssigneeWorkspaceBusyRetry(run.scheduledRetryReason, parseObject(run.contextSnapshot)));
        await finalizeAiConnectionBusyDeferral(run, error, !authorizedNonAssigneeWake);
        return { prepared: false as const };
      }
      if (responsibleUserId && issueId) {
        await connectionIntentService(db).request({ sub: agent.id, company_id: agent.companyId, run_id: run.id, responsible_user_id: responsibleUserId }, aiBinding.provider, { purpose: "ai" }).catch(() => {
          logger.warn({ runId: run.id, agentId: agent.id }, "Could not attach AI connection request; runtime configuration action remains available");
        });
      }
      throw new ConfigurationIncompleteFailure(error instanceof Error ? error.message : "Configure this agent’s AI connection", {
        configurationIncomplete: { reason: "ai_connection_unavailable", companyId: agent.companyId, agentId: agent.id, responsibleUserId,
          ...(!persistedNativeExecutionInput && readAiConnectionConfigurationFailure(error)
            ? { selectionFailure: readAiConnectionConfigurationFailure(error) } : {}),
          ...(readAiCredentialAccessFailure(error)
            ? { credentialAccess: readAiCredentialAccessFailure(error) } : {}),
          provider: aiBinding.provider, method: aiBinding.method, actionUrl: `/agents/${agent.id}/runtime`,
          fingerprint: `ai:${agent.id}:${responsibleUserId}:${JSON.stringify(aiBinding)}` },
      });
    }
    const savedAiAccount = parseObject(run.contextSnapshot?.aiConnection);
    if (persistedNativeExecutionInput && !managedAiSessionIdentityCompatible(
      savedAiAccount.sessionIdentity ?? savedAiAccount.identity,
      managedAiRuntime.sessionIdentity,
      managedAiRuntime.identity,
    )) {
      throw new ConfigurationIncompleteFailure("The AI account changed while this native run was suspended. Start a new execution.", { configurationIncomplete: { reason: "ai_connection_changed", actionUrl: `/agents/${agent.id}/runtime` } });
    }
    Object.assign(resolvedConfig, managedAiRuntime.config);
    for (const key of AI_AUTH_ENV_KEYS) secretKeys.add(key);
    context.aiConnection = { ...managedAiRuntime.attribution, accountName: managedAiRuntime.accountName, identity: managedAiRuntime.identity, sessionIdentity: managedAiRuntime.sessionIdentity };
    await db.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ aiConnection: context.aiConnection, ...(context.aiRouterTaskKey ? { aiRouterTaskKey: context.aiRouterTaskKey } : {}), ...(context.aiRouterSelection ? { aiRouterSelection: context.aiRouterSelection } : {}) })}::jsonb` }).where(eq(heartbeatRuns.id, run.id));
  }
  if (secretManifest.length > 0) {
    context.paperclipSecrets = {
      manifest: secretManifest,
    };
  } else {
    delete context.paperclipSecrets;
  }
  const storedVersions = parseObject(run.contextSnapshot?.skillVersions);
  const hasStoredVersions = Object.prototype.hasOwnProperty.call(run.contextSnapshot ?? {}, "skillVersions");
  if (hasStoredVersions && (!run.contextSnapshot?.skillVersions || typeof run.contextSnapshot.skillVersions !== "object"
    || Array.isArray(run.contextSnapshot.skillVersions) || Object.values(storedVersions).some(value =>
      typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)))) {
    throw new ConfigurationIncompleteFailure("The saved skill selection is incomplete. Recover its exact versions before retrying.", {
      configurationIncomplete: { reason: "skill_unavailable", actionUrl: "/skills" },
    });
  }
  const savedShadowedSkills = Array.isArray(run.contextSnapshot?.shadowedSkills)
    ? run.contextSnapshot.shadowedSkills.flatMap(value => {
      const saved = parseObject(value);
      return typeof saved.key === "string" && typeof saved.shadowedBy === "string" && Object.hasOwn(storedVersions, saved.shadowedBy)
        ? [{ key: saved.key, shadowedBy: saved.shadowedBy }] : [];
    }) : [];
  const selectedConfig = pinnedSkillTest
    ? writePaperclipSkillSyncPreference(resolvedConfig, [pinnedSkillTest])
    : applyRunScopedMentionedSkillKeys(resolvedConfig, runScopedSkillKeys);
  const { config: effectiveResolvedConfig, skillKeys: environmentSkills, shadowedSkills } = hasStoredVersions
    ? { config: selectedConfig, skillKeys: [], shadowedSkills: savedShadowedSkills }
    : await environmentSkillConfig(db, agent.companyId, selectedEnvironmentForConfig, selectedConfig);
  if (shadowedSkills?.length) {
    context.shadowedSkills = shadowedSkills;
    if (!hasStoredVersions) await appendRunEvent(run, { eventType: "skills.shadowed", stream: "system", level: "warn",
      message: shadowedSkills.map(({ key, shadowedBy }) => `Skill "${key}" was skipped because required plugin skill "${shadowedBy}" uses the same name.`).join("\n"),
      payload: { shadowedSkills } });
  }
  const runtimeSkillPreference = readPaperclipSkillSyncPreference(
    effectiveResolvedConfig,
  );
  const nativeRunnerPreparationSpans: NativeRunHistoricalSpan[] = [];
  const skillsPrepareStartedAtMs = Date.now();
  let skillsPrepareEndedAtMs = skillsPrepareStartedAtMs;
  let skillDeliveryConfig = effectiveResolvedConfig;
  const prepareSkills = async () => {

    try {
      const versionSelections = hasStoredVersions
        ? new Map(Object.entries(storedVersions).filter((entry): entry is [string, string | null] => entry[1] === null || typeof entry[1] === "string"))
        : skillVersionSelectionMap(runtimeSkillPreference.desiredSkillEntries, {
          versionPinsEnabled: resolvedInstanceSettings.experimental.enableBetaSkills === true,
        });
      // Studio always executes its saved revision, independently of assignment
      // pins and the Beta skills preference. Recovery keeps the admitted map.
      if (!hasStoredVersions && pinnedSkillTest) versionSelections.set(pinnedSkillTest.key, pinnedSkillTest.versionId);
      return await withSkillActor(skillActor, () => companySkills.withRuntimeSkillEntries(agent.companyId, {
        versionSelections, snapshotLatest: true,
        ...(hasStoredVersions
          ? { onlyKeys: new Set(Object.keys(storedVersions)) }
          : { selectionConfig: effectiveResolvedConfig, includeLegacy: agent.adapterType !== "paperclip_runner" }),
        selectVersions: async entries => {
          const available = hasStoredVersions ? entries.filter(entry => Object.prototype.hasOwnProperty.call(storedVersions, entry.key)) : entries;
          const availableKeys = new Set(available.map(entry => entry.key));
          if (!hasStoredVersions && pinnedSkillTest && (!availableKeys.has(pinnedSkillTest.key)
            || shadowedSkills?.some(skill => skill.key === pinnedSkillTest.key))) {
            throw new ConfigurationIncompleteFailure("The skill test's pinned skill is unavailable or no longer permitted.", {
              configurationIncomplete: { reason: "skill_unavailable", actionUrl: "/skills" },
            });
          }
          if (hasStoredVersions && Object.keys(storedVersions).some(key => !availableKeys.has(key))) {
            throw new ConfigurationIncompleteFailure("A pinned skill is unavailable or no longer permitted.", {
              configurationIncomplete: { reason: "skill_unavailable", actionUrl: "/skills" },
            });
          }
          const desiredKeys = hasStoredVersions
            ? Object.keys(storedVersions)
            : agent.adapterType === "paperclip_runner"
              ? resolvePaperclipDesiredSkillNames(effectiveResolvedConfig, available)
              : resolveLegacyPaperclipDesiredSkillNames(effectiveResolvedConfig, available);
          const selectedKeys = new Set(desiredKeys.filter(key => availableKeys.has(key)));
          const resolved = available.filter(entry => selectedKeys.has(entry.key));
          skillDeliveryConfig = writePaperclipSkillSyncPreference(effectiveResolvedConfig,
            resolved.map(entry => ({ key: entry.key, versionId: entry.versionId ?? null })));
          if (!hasStoredVersions) {
            const skillVersions = Object.fromEntries(resolved.map(entry => [entry.key, entry.versionId ?? entry.currentVersionId ?? null]));
            context.skillVersions = skillVersions;
            context.skillSelectionSnapshot = true;
            await db.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ skillVersions, skillSelectionSnapshot: true, ...(shadowedSkills?.length ? { shadowedSkills } : {}) })}::jsonb` }).where(eq(heartbeatRuns.id, run.id));
          }
          return selectedKeys;
        },
      }, async entries => {
        for (const key of [...runScopedMentionedSkillKeys.filter(key => !shadowedSkills?.some(skill => skill.key === key)), ...(hasStoredVersions ? [] : environmentSkills)]) {
          const entry = entries.find(candidate => candidate.key === key);
          if (!entry || entry.sourceStatus === "missing") {
            throw new ConfigurationIncompleteFailure("A referenced skill is unavailable. Restore its installed version or update the task's skill reference.", {
              configurationIncomplete: { reason: "skill_unavailable", skillKey: key, actionUrl: "/skills" },
            });
          }
        }
        return entries;
      }));
    } catch (error) {
      if (agent.adapterType === "paperclip_runner") {
        await recordFailedSkillPreparation({
          runId: run.id,
          startedAtMs: skillsPrepareStartedAtMs,
          onEvent: async (event) => {
            await appendRunEvent(run, event);
          },
        });
      }
      throw error;
    }
  };
  const skillsPreparation = (preconfiguredHome ? Promise.resolve([]) : time("configuration_skills", prepareSkills))
    .finally(() => { skillsPrepareEndedAtMs = Date.now(); });
  const assignmentsPreparation = preconfiguredHome ? Promise.resolve([]) : time("configuration_connector_assignments", () => resolveConnectorAssignments(db, { companyId: agent.companyId, agentId: agent.id, runId: run.id, issueId: typeof context.issueId === "string" ? context.issueId : undefined }));
  const [preparedSkills, preparedAssignments, preparedInstructions] = await Promise.allSettled([
    skillsPreparation,
    assignmentsPreparation,
    assignmentsPreparation.then(() => time("configuration_connection_instructions", () => resolveAssignedConnectionInstructionsForRun(db, { companyId: agent.companyId, agentId: agent.id, runId: run.id }))),
  ]);
  if (preparedSkills.status === "rejected") throw preparedSkills.reason;
  if (preparedAssignments.status === "rejected") throw preparedAssignments.reason;
  if (preparedInstructions.status === "rejected") throw preparedInstructions.reason;
  const runtimeSkillEntries = preparedSkills.value;
  nativeRunnerPreparationSpans.push({
    name: "skills.prepare",
    parentName: "task.prepare",
    startedAtMs: skillsPrepareStartedAtMs,
    endedAtMs: skillsPrepareEndedAtMs,
  });
  const connectorAssignments = preparedAssignments.value;
  const connectorSkillConfig = await time("configuration_connector_skills", () => applyConnectorSkills(skillDeliveryConfig, runtimeSkillEntries, connectorAssignments));
  // Both CLI adapters and native context materialization use the same resolved set.
  runtimeSkillEntries.splice(0, runtimeSkillEntries.length, ...connectorSkillConfig.paperclipRuntimeSkills);
  const connectorDelivery = await time("configuration_connector_delivery", () => prepareConnectorSkillDelivery(connectorSkillConfig, agent.adapterType));
  // Always replace this runtime-only field; caller wake data cannot supply skills.
  context.paperclipWake = { ...parseObject(context.paperclipWake), connectorSkillInstructions: connectorDelivery.instructions };
  let runtimeConfig = await prepareConnectionInstructionDelivery({
    resolve: async () => preparedInstructions.value,
    context, config: connectorDelivery.config, native: agent.adapterType === "paperclip_runner",
  });
  const agentIdentity = supportsManagedAgentIdentity(agent.adapterType, agent.adapterConfig, run.runtimeMode === "native" ? run.driverKind : undefined)
    ? await time("configuration_agent_identity", () => agentIdentityService(db).ensureAgentIdentity(agent.companyId, agent.id))
    : undefined;
  identityRedactor.values.push(...createAgentIdentityRedactor(agentIdentity?.privateKeyPem).values);
  const harness = agentHarnessType(agent.adapterType, runtimeConfig);
  const observability = unsupportedObservability !== "unsupported_home_mode" && observabilityKind(harness)
    ? agentObservabilityLaunch(observabilitySnapshot, { kind: observabilityKind(harness)!, companyId: agent.companyId, agentId: agent.id }) : undefined;
  identityRedactor.values.push(...observabilitySecretValues(observability));
  identityRedactor.values.sort((a, b) => b.length - a.length);
  if (observabilitySnapshot.state === "unavailable") {
    logger.warn({ runId: run.id, reason: observabilitySnapshot.reason }, "Agent observability unavailable; execution continues without export");
    const reason = observabilitySnapshot.reason;
    await appendRunEvent(run, { eventType: "agent_observability.unavailable", stream: "system", level: "warn",
      message: reason === "unsupported_home_mode"
        ? "Company observability was not applied: automatic configuration of caller-owned Codex homes is unsupported."
        : reason === "unsupported_harness" ? "Company observability was not applied: this harness is not supported."
          : "Company observability is unavailable. Execution continues without company export.",
      payload: { reason, revision: observabilitySnapshot.revision } }).catch(() => {
        logger.warn({ runId: run.id }, "Could not record the agent observability availability diagnostic");
      });
  }
  onIdentityRedactorPrepared(identityRedactor);
  if (agentIdentity) secretKeys.add("PAPERCLIP_AGENT_PRIVATE_KEY");
  return {
    prepared: true as const,
    mergedConfig, configSnapshot, runScopedMentionedSkillKeys, githubSelection, useHostGitHub,
    resolvedConfig, configuredTaskEnvironment, secretKeys, secretManifest,
    runtimeSkillEntries, nativeRunnerPreparationSpans, runtimeConfig, agentIdentity, observability,
  };
}
