import { spekoToolsForSession } from "../voice/speko-agent-tools.js";
import { githubConfiguredInstructionSources } from "../chat-github-review-policy.js";
import { CONFIGURED_ENVIRONMENT_KEYS } from "../../vendor/paperclip-runner/index.js";
import { ASSIGNED_MCP_SERVER_NAME } from "../mcp-tool-names.js";
import { externalConversationStateSql } from "../slack-conversation-state.js";
import { githubBotConnectionIdsForRun } from "../chat-github-tools.js";
import { isBrowserUseConnection } from "../browser-use-client.js";
import { explicitOperatorRunIdentity } from "../run-identity.js";
import {
  type DurableChatWakeupRequest,
} from "../durable-chat-wakeup.js";
import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  CHAT_PROVIDERS,
  CONNECTION_INTENT_AGENT_GUIDANCE,
  CONNECTION_RUNTIME_TOOL_NAMES,
  envBindingSchema,
  isToolConnectionAttentionHealth,
  type ChatProvider,
  type RoutineRevisionSnapshotV1,
  type SourceTrustMetadata,
} from "@paperclipai/shared";
import {
  agents,
  assets,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatMessageLinks,
  companyMemberships,
  companySkillTestRuns,
  companySkillVersions,
  companySkills as companySkillsTable,
  companies,
  documentAnnotationComments,
  documentAnnotationThreads,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issuePlanDecompositions,
  issueRecoveryActions,
  issues,
  routineRevisions,
  routineRuns,
  routines,
  toolMcpGateways,
  toolMcpGatewayTokens,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import { filterResolvedGitHubConnectionsForRun } from "../git-credentials.js";
import type {
  AdapterRuntimeMcpAccess,
  AdapterRuntimeMcpServer,
  AdapterRuntimeToolAccess,
} from "../../adapters/index.js";
import { createRuntimeToolsToken } from "../../runtime-tools-token.js";
import { parseObject } from "../../adapters/utils.js";
import {
  authorizeChatConversationForBoundRun,
  isExternalChatWaitAuthorizationContention,
} from "../native-runtime/chat-attachment-reuse.js";
import {
  EXTERNAL_CHAT_QUESTION_RESPONSE_KEY,
  resolveExternalChatQuestionResponse,
} from "../native-runtime/external-chat-question-response.js";
import {
  secretService,
  type MissingRuntimeBinding,
} from "../secrets.js";
import { createToolGatewayService } from "../tool-gateway.js";
import { toolAccessService } from "../tool-access.js";
import {
  buildDocumentReviewContext,
  buildPlanReviewContext,
} from "../plan-review-context.js";
import {
  WAKE_COMMENT_IDS_KEY,
  extractWakeCommentIds,
  deriveCommentId,
} from "../../modules/run-dispatch/index.js";
import {
  DIRECT_NON_INVOKABLE_STATUSES,
  type AgentOrgRow,
} from "../agent-invokability.js";
import {
  isLowTrustQuarantined,
  redactQuarantinedBodyForHigherTrust,
  sanitizeQuarantinedCommentForHigherTrust,
} from "../source-trust.js";
import { redactSensitiveText } from "../../redaction.js";
import { createRunSecretRedactionRegistry } from "../run-secret-redaction.js";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import {
  extractSkillMentionIds,
  isUuidLike,
} from "@paperclipai/shared";
import { evaluateCodexCredentialReadiness } from "@paperclipai/adapter-codex-local/server";
import type { TrustPresetResolution } from "../trust-preset-resolver.js";

const EXTERNAL_ATTACHMENT_OMISSIONS_KEY = "externalAttachmentOmissions";

export const PAPERCLIP_WAKE_PAYLOAD_KEY = "paperclipWake";

const PAPERCLIP_AGENT_MESSAGE_KEY = "paperclipAgentMessage";

export const PAPERCLIP_HARNESS_CHECKOUT_KEY = "paperclipHarnessCheckedOut";

export const PAPERCLIP_EXTERNAL_CHAT_EXECUTION_BOUND_KEY =
  "paperclipExternalChatExecutionBound";

const MAX_INLINE_WAKE_COMMENTS = 8;

const MAX_INLINE_WAKE_ATTACHMENTS = 20;

const MAX_INLINE_WAKE_COMMENT_BODY_CHARS = 4_000;

const MAX_INLINE_WAKE_COMMENT_BODY_TOTAL_CHARS = 12_000;

const MAX_INLINE_WAKE_ISSUE_DESCRIPTION_CHARS = 12_000;

const MAX_AGENT_SESSION_MESSAGE_CHARS = 12_000;

export const CONFIGURATION_INCOMPLETE_FAILURE_CODE = "configuration_incomplete";

// Pre-dispatch gate outcome: required secret/env bindings are missing, so the
// run must not be dispatched. Surfaced as a configuration-incomplete blocker
// routed to a human owner instead of N opaque dispatched-then-failed runs.
export class ConfigurationIncompleteFailure extends Error {
  code = CONFIGURATION_INCOMPLETE_FAILURE_CODE;
  resultJson: Record<string, unknown>;

  constructor(message: string, resultJson: Record<string, unknown>) {
    super(message);
    this.name = "ConfigurationIncompleteFailure";
    this.resultJson = resultJson;
  }
}

const ISSUE_RESPONSIBLE_USER_WAKE_REASONS = new Set([
  "issue_assigned",
  "issue_checked_out",
  "issue_commented",
  "issue_comment_mentioned",
  "issue_reopened_via_comment",
  "issue_blockers_resolved",
  "issue_children_completed",
  "issue_status_changed",
  "issue_tree_restored",
  "issue_recovery_action_restored",
  "execution_review_requested",
  "execution_approval_requested",
  "execution_changes_requested",
  "approval_approved",
]);

type RuntimeConfigSecretResolver = Pick<
  ReturnType<typeof secretService>,
  | "resolveAdapterConfigForRuntime"
  | "resolveEnvBindings"
  | "collectMissingRuntimeBindings"
  | "collectMissingAdapterConfigRuntimeBindings"
>;

function formatMissingBindingForOperator(
  missing: MissingRuntimeBinding,
): string {
  if (missing.bindingType === "user_secret_ref") {
    const definitionLabel = missing.userSecretDefinitionName
      ? `"${missing.userSecretDefinitionName}"`
      : missing.userSecretDefinitionKey
        ? `"${missing.userSecretDefinitionKey}"`
        : "declared user secret";
    const ownerLabel = missing.responsibleUserId
      ? ` for responsible user ${missing.responsibleUserId}`
      : "";
    return `user secret ${definitionLabel}${ownerLabel} not available at ${missing.consumerType} ${missing.configPath}`;
  }
  const secretLabel = missing.secretName
    ? `"${missing.secretName}"`
    : (missing.secretId ?? "unknown");
  return `secret ${secretLabel} not bound at ${missing.consumerType} ${missing.configPath}`;
}

function isConfiguredEnvBindingValue(binding: unknown) {
  const parsed = envBindingSchema.safeParse(binding);
  if (!parsed.success) return false;
  const value = parsed.data;
  if (typeof value === "string") return value.trim().length > 0;
  if (value.type === "plain") return value.value.trim().length > 0;
  return true;
}

const LOW_TRUST_SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;

// PAPERCLIP_* env binding policy:
// 1. PAPERCLIP_API_KEY is never accepted from user/adapter/project/routine
//    config — the harness-minted run token is the only source.
// 2. A PAPERCLIP_* runtime var the harness assigns for the run (RUN_ID,
//    AGENT_ID, wake/workspace vars, ...) always wins over a same-named
//    binding; adapters enforce this at env-merge time.
// 3. Any other PAPERCLIP_*-named binding is user data and flows through to
//    the run env like any non-prefixed binding.
const FORBIDDEN_ENV_BINDING_KEYS = new Set([
  CONFIGURED_ENVIRONMENT_KEYS,
  "PAPERCLIP_AGENT_KEY_ID", "PAPERCLIP_AGENT_PUBLIC_KEY", "PAPERCLIP_AGENT_PRIVATE_KEY",
  "PAPERCLIP_RUNNER_NETWORK_ACCESS",
  "PAPERCLIP_RUNNER_NETWORK_ROOTS",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_GITHUB_AUTH_MODE",
  "PAPERCLIP_GITHUB_HOST_HOME",
  "PAPERCLIP_GIT_METADATA_ROOTS",
  "PAPERCLIP_GITHUB_BROKER_TOKEN",
  "PAPERCLIP_GITHUB_BROKER_URL",
  "PAPERCLIP_GITHUB_BRIDGE_TOKEN",
  "PAPERCLIP_GITHUB_LAUNCHER_DIR",
]);

export const MANAGED_GITHUB_TOKEN_KEYS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "PAPERCLIP_GIT_TOKEN",
]);

function stripForbiddenEnvBindings(
  envValue: unknown,
  managedGitHubCredentials = false,
): Record<string, unknown> | null {
  const record = parseObject(envValue);
  const filtered = Object.fromEntries(
    Object.entries(record).filter(
      ([key]) =>
        !FORBIDDEN_ENV_BINDING_KEYS.has(key.toUpperCase()) &&
        !(managedGitHubCredentials && MANAGED_GITHUB_TOKEN_KEYS.has(key)),
    ),
  );
  return Object.keys(filtered).length > 0 ? filtered : null;
}

function stripForbiddenEnvFromAdapterConfig(
  config: Record<string, unknown>,
  managedGitHubCredentials = false,
): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(config, "env")) return config;
  return {
    ...config,
    env: stripForbiddenEnvBindings(config.env, managedGitHubCredentials) ?? {},
  };
}

function assertLowTrustEnvConfigAllowed(envValue: unknown, source: string) {
  const record = stripForbiddenEnvBindings(envValue);
  if (!record) return;
  for (const [key, rawBinding] of Object.entries(record)) {
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const binding = parsed.data;
    const isPlainBinding =
      typeof binding === "string" ||
      (typeof binding === "object" &&
        binding !== null &&
        binding.type === "plain");
    if (isPlainBinding && LOW_TRUST_SENSITIVE_ENV_KEY_RE.test(key)) {
      throw new HttpError(
        422,
        `Low-trust execution cannot use inline sensitive env value ${source}.${key}`,
        {
          code: "low_trust_inline_sensitive_env_denied",
        },
      );
    }
  }
}

export async function resolveExecutionRunAdapterConfig(input: {
  managedAiCredentials?: boolean;
  companyId: string;
  agentId?: string | null;
  adapterType?: string | null;
  issueId?: string | null;
  heartbeatRunId?: string | null;
  responsibleUserId?: string | null;
  environmentId?: string | null;
  environmentEnv?: unknown;
  environmentDriver?: string | null;
  projectId?: string | null;
  routineId?: string | null;
  executionRunConfig: Record<string, unknown>;
  projectEnv: unknown;
  routineEnv?: unknown;
  secretsSvc: RuntimeConfigSecretResolver;
  trustPreset?: TrustPresetResolution;
  requiredScopedEnvBinding?: {
    keys: string[];
    consumerScopes: Array<"agent" | "project">;
    reason: string;
    remediation: string;
  };
  /** Managed GitHub tokens are resolved only when operations start. */
  managedGitHubCredentials?: boolean;
  /** Audited class-3 values resolved by an internal credential broker. */
  trustedEnvProjection?: Record<string, string>;
  trustedEnvSecretKeys?: string[];
}) {
  const executionRunConfig = stripForbiddenEnvFromAdapterConfig(
    input.executionRunConfig,
    input.managedGitHubCredentials,
  );
  const environmentEnv = stripForbiddenEnvBindings(
    input.environmentEnv,
    input.managedGitHubCredentials,
  );
  const projectEnv = stripForbiddenEnvBindings(
    input.projectEnv,
    input.managedGitHubCredentials,
  );
  const routineEnv = stripForbiddenEnvBindings(
    input.routineEnv,
    input.managedGitHubCredentials,
  );
  const agentEnv = parseObject(executionRunConfig.env);
  const lowTrustAllowedBindingIds =
    input.trustPreset?.kind === "low_trust_review"
      ? (input.trustPreset.boundary.allowedSecretBindingIds ?? [])
      : undefined;
  const allowTrustedEnvProjection =
    input.trustPreset?.kind !== "low_trust_review";
  if (input.trustPreset?.kind === "low_trust_review") {
    assertLowTrustEnvConfigAllowed(environmentEnv, "environment.env");
    assertLowTrustEnvConfigAllowed(executionRunConfig.env, "agent.env");
    assertLowTrustEnvConfigAllowed(projectEnv, "project.env");
    assertLowTrustEnvConfigAllowed(routineEnv, "routine.env");
  }
  const requiredScopedEnvBinding = input.requiredScopedEnvBinding ?? null;
  const requiredScopedBindingsConfigured = requiredScopedEnvBinding
    ? requiredScopedEnvBinding.keys.some(
        (key) =>
          (allowTrustedEnvProjection &&
            typeof input.trustedEnvProjection?.[key] === "string") ||
          (requiredScopedEnvBinding.consumerScopes.includes("agent") &&
            isConfiguredEnvBindingValue(agentEnv[key])) ||
          (requiredScopedEnvBinding.consumerScopes.includes("project") &&
            isConfiguredEnvBindingValue(projectEnv?.[key])),
      )
    : false;
  if (requiredScopedEnvBinding && !requiredScopedBindingsConfigured) {
    throw new ConfigurationIncompleteFailure(
      `configuration incomplete: ${requiredScopedEnvBinding.remediation}`,
      {
        configurationIncomplete: {
          reason: requiredScopedEnvBinding.reason,
          companyId: input.companyId,
          agentId: input.agentId ?? null,
          issueId: input.issueId ?? null,
          projectId: input.projectId ?? null,
          routineId: input.routineId ?? null,
          requiredEnvKeys: requiredScopedEnvBinding.keys,
          requiredScopes: requiredScopedEnvBinding.consumerScopes,
          missingBindings: [],
        },
      },
    );
  }
  // Pre-dispatch binding-validation gate: detect declared secret refs that have
  // no binding before resolving any secret value. Missing bindings short-circuit
  // to a configuration-incomplete blocker routed to a human owner instead of a
  // dispatched-then-failed run (which previously surfaced as opaque setup_failed).
  if (typeof input.secretsSvc.collectMissingRuntimeBindings === "function") {
    const missingBindings: MissingRuntimeBinding[] = [];
    if (environmentEnv && input.environmentId) {
      missingBindings.push(
        ...(await input.secretsSvc.collectMissingRuntimeBindings(
          input.companyId,
          environmentEnv,
          {
            consumerType: "environment",
            consumerId: input.environmentId,
            responsibleUserId: input.responsibleUserId ?? null,
          },
        )),
      );
    }
    if (input.agentId) {
      missingBindings.push(
        ...(await input.secretsSvc.collectMissingRuntimeBindings(
          input.companyId,
          parseObject(executionRunConfig.env),
          {
            consumerType: "agent",
            consumerId: input.agentId,
            responsibleUserId: input.responsibleUserId ?? null,
          },
        )),
      );
      if (
        typeof input.secretsSvc.collectMissingAdapterConfigRuntimeBindings ===
        "function"
      ) {
        missingBindings.push(
          ...(await input.secretsSvc.collectMissingAdapterConfigRuntimeBindings(
            input.companyId,
            executionRunConfig,
            input.adapterType ?? null,
            {
              consumerType: "agent",
              consumerId: input.agentId,
              responsibleUserId: input.responsibleUserId ?? null,
            },
          )),
        );
      }
    }
    if (projectEnv && input.projectId) {
      missingBindings.push(
        ...(await input.secretsSvc.collectMissingRuntimeBindings(
          input.companyId,
          projectEnv,
          {
            consumerType: "project",
            consumerId: input.projectId,
            responsibleUserId: input.responsibleUserId ?? null,
          },
        )),
      );
    }
    if (routineEnv && input.routineId) {
      missingBindings.push(
        ...(await input.secretsSvc.collectMissingRuntimeBindings(
          input.companyId,
          routineEnv,
          {
            consumerType: "routine",
            consumerId: input.routineId,
            responsibleUserId: input.responsibleUserId ?? null,
          },
        )),
      );
    }
    if (requiredScopedEnvBinding) {
      const requiredEnvKeys = new Set(requiredScopedEnvBinding.keys);
      const requiredScopes = new Set(requiredScopedEnvBinding.consumerScopes);
      const requiredMissingBindings = missingBindings.filter(
        (binding) =>
          requiredScopes.has(binding.consumerType as "agent" | "project") &&
          requiredEnvKeys.has(binding.envKey),
      );
      if (requiredMissingBindings.length > 0) {
        const detail = requiredMissingBindings
          .map(formatMissingBindingForOperator)
          .join("; ");
        throw new ConfigurationIncompleteFailure(
          `configuration incomplete: ${requiredScopedEnvBinding.remediation}; ${detail}`,
          {
            configurationIncomplete: {
              reason: requiredScopedEnvBinding.reason,
              companyId: input.companyId,
              agentId: input.agentId ?? null,
              issueId: input.issueId ?? null,
              projectId: input.projectId ?? null,
              routineId: input.routineId ?? null,
              requiredEnvKeys: requiredScopedEnvBinding.keys,
              requiredScopes: requiredScopedEnvBinding.consumerScopes,
              missingBindings: requiredMissingBindings,
            },
          },
        );
      }
    }
    if (missingBindings.length > 0) {
      const detail = missingBindings
        .map(formatMissingBindingForOperator)
        .join("; ");
      throw new ConfigurationIncompleteFailure(
        `configuration incomplete: ${detail}`,
        {
          configurationIncomplete: {
            reason: "secret_binding_missing",
            companyId: input.companyId,
            agentId: input.agentId ?? null,
            issueId: input.issueId ?? null,
            projectId: input.projectId ?? null,
            routineId: input.routineId ?? null,
            missingBindings,
          },
        },
      );
    }
  }
  const environmentEnvResolution = environmentEnv
    ? await input.secretsSvc.resolveEnvBindings(
        input.companyId,
        environmentEnv,
        input.environmentId
          ? {
              consumerType: "environment",
              consumerId: input.environmentId,
              actorType: "agent",
              actorId: input.agentId ?? null,
              responsibleUserId: input.responsibleUserId ?? null,
              issueId: input.issueId ?? null,
              heartbeatRunId: input.heartbeatRunId ?? null,
              ...(lowTrustAllowedBindingIds !== undefined
                ? { allowedBindingIds: lowTrustAllowedBindingIds }
                : {}),
            }
          : undefined,
      )
    : { env: {}, secretKeys: new Set<string>(), manifest: [] };
  const {
    config: resolvedConfig,
    secretKeys,
    manifest,
  } = await input.secretsSvc.resolveAdapterConfigForRuntime(
    input.companyId,
    executionRunConfig,
    input.agentId
      ? {
          consumerType: "agent",
          consumerId: input.agentId,
          actorType: "agent",
          actorId: input.agentId,
          responsibleUserId: input.responsibleUserId ?? null,
          issueId: input.issueId ?? null,
          heartbeatRunId: input.heartbeatRunId ?? null,
          ...(lowTrustAllowedBindingIds !== undefined
            ? { allowedBindingIds: lowTrustAllowedBindingIds }
            : {}),
        }
      : undefined,
    { adapterType: input.adapterType ?? null },
  );
  if (Object.keys(environmentEnvResolution.env).length > 0) {
    resolvedConfig.env = {
      ...environmentEnvResolution.env,
      ...parseObject(resolvedConfig.env),
    };
    for (const key of environmentEnvResolution.secretKeys) {
      secretKeys.add(key);
    }
  }
  const projectEnvResolution = projectEnv
    ? await input.secretsSvc.resolveEnvBindings(
        input.companyId,
        projectEnv,
        input.projectId
          ? {
              consumerType: "project",
              consumerId: input.projectId,
              actorType: "agent",
              actorId: input.agentId ?? null,
              responsibleUserId: input.responsibleUserId ?? null,
              issueId: input.issueId ?? null,
              heartbeatRunId: input.heartbeatRunId ?? null,
              ...(lowTrustAllowedBindingIds !== undefined
                ? { allowedBindingIds: lowTrustAllowedBindingIds }
                : {}),
            }
          : undefined,
      )
    : { env: {}, secretKeys: new Set<string>(), manifest: [] };
  if (Object.keys(projectEnvResolution.env).length > 0) {
    resolvedConfig.env = {
      ...parseObject(resolvedConfig.env),
      ...projectEnvResolution.env,
    };
    for (const key of projectEnvResolution.secretKeys) {
      secretKeys.add(key);
    }
  }
  const routineEnvResolution = routineEnv
    ? await input.secretsSvc.resolveEnvBindings(
        input.companyId,
        routineEnv,
        input.routineId
          ? {
              consumerType: "routine",
              consumerId: input.routineId,
              actorType: "agent",
              actorId: input.agentId ?? null,
              responsibleUserId: input.responsibleUserId ?? null,
              issueId: input.issueId ?? null,
              heartbeatRunId: input.heartbeatRunId ?? null,
              ...(lowTrustAllowedBindingIds !== undefined
                ? { allowedBindingIds: lowTrustAllowedBindingIds }
                : {}),
            }
          : undefined,
      )
    : { env: {}, secretKeys: new Set<string>(), manifest: [] };
  if (Object.keys(routineEnvResolution.env).length > 0) {
    resolvedConfig.env = {
      ...parseObject(resolvedConfig.env),
      ...routineEnvResolution.env,
    };
    for (const key of routineEnvResolution.secretKeys) {
      secretKeys.add(key);
    }
  }
  if (
    allowTrustedEnvProjection &&
    input.trustedEnvProjection &&
    Object.keys(input.trustedEnvProjection).length > 0
  ) {
    resolvedConfig.env = {
      ...parseObject(resolvedConfig.env),
      ...input.trustedEnvProjection,
    };
    for (const key of input.trustedEnvSecretKeys ?? []) secretKeys.add(key);
  }
  // Pre-dispatch credential gate for codex_local: a managed Codex home with no
  // usable auth.json and an empty OPENAI_API_KEY would dispatch a run that
  // immediately fails with "no Codex credentials provisioned" (adapter_failed),
  // making a configuration problem look like a runtime failure. Surface it as a
  // configuration-incomplete blocker instead, naming the missing credential
  // action and owner without leaking any secret value. This runs after secret
  // resolution so a per-agent OPENAI_API_KEY (plain or resolved secret) counts
  // as satisfying the credential. It shares the exact readiness predicate the
  // adapter uses at execute time, so the two cannot drift.
  //
  // Sandbox-destined runs are exempt: the sandbox image may carry its own
  // Codex login (`~/.codex/auth.json` baked in at image setup), which only the
  // adapter can probe once the sandbox is up — and on managed cloud hosts a
  // host-side login never exists at all. The adapter's execute-time gate
  // remains the authority there; it probes the sandbox before failing.
  if (
    !input.managedAiCredentials && (input.adapterType ?? null) === "codex_local" &&
    (input.environmentDriver ?? null) !== "sandbox"
  ) {
    const resolvedEnv = parseObject(resolvedConfig.env);
    const readiness = await evaluateCodexCredentialReadiness({
      env: process.env,
      companyId: input.companyId,
      configuredCodexHome: readNonEmptyString(resolvedEnv.CODEX_HOME),
      configuredApiKey: readNonEmptyString(resolvedEnv.OPENAI_API_KEY),
    });
    if (readiness.managed && !readiness.ready) {
      throw new ConfigurationIncompleteFailure(
        `configuration incomplete: no Codex credentials available for managed home "${readiness.effectiveHome}". ` +
          `Sign in to Codex on the host with a ChatGPT subscription, or bind a per-agent OPENAI_API_KEY secret for this agent.`,
        {
          configurationIncomplete: {
            reason: "codex_credentials_missing",
            companyId: input.companyId,
            agentId: input.agentId ?? null,
            issueId: input.issueId ?? null,
            projectId: input.projectId ?? null,
            routineId: input.routineId ?? null,
            responsibleUserId: input.responsibleUserId ?? null,
            adapterType: "codex_local",
            requiredEnvKeys: ["OPENAI_API_KEY"],
            effectiveCodexHome: readiness.effectiveHome,
            missingBindings: [],
          },
        },
      );
    }
  }
  return {
    resolvedConfig,
    // Capture resolved task values before provider credential injection or host
    // inheritance. Native-only launch limits are checked at native dispatch.
    configuredTaskEnvironment: Object.fromEntries(
      Object.entries(parseObject(resolvedConfig.env)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    secretKeys,
    secretManifest: [
      ...(environmentEnvResolution.manifest ?? []),
      ...(manifest ?? []),
      ...(projectEnvResolution.manifest ?? []),
      ...(routineEnvResolution.manifest ?? []),
    ],
  };
}

export function extractMentionedSkillIdsFromSources(
  sources: Array<string | null | undefined>,
): string[] {
  const mentionedIds = new Set<string>();
  for (const source of sources) {
    if (typeof source !== "string" || source.length === 0) continue;
    for (const skillId of extractSkillMentionIds(source)) {
      if (!isUuidLike(skillId)) continue;
      mentionedIds.add(skillId);
    }
  }
  return [...mentionedIds];
}

export function applyRunScopedMentionedSkillKeys(
  config: Record<string, unknown>,
  skillKeys: string[],
): Record<string, unknown> {
  const normalizedSkillKeys = Array.from(
    new Set(skillKeys.map((value) => value.trim()).filter(Boolean)),
  );
  if (normalizedSkillKeys.length === 0) return config;

  const existingPreference = readPaperclipSkillSyncPreference(config);
  return writePaperclipSkillSyncPreference(config, [
    ...existingPreference.desiredSkillEntries,
    ...normalizedSkillKeys,
  ]);
}

export async function resolveRunScopedMentionedSkillKeys(input: {
  db: Db;
  companyId: string;
  issueId: string | null;
  commentIds?: string[];
}): Promise<string[]> {
  if (!input.issueId) return [];

  const issue = await input.db
    .select({
      title: issues.title,
      description: issues.description,
    })
    .from(issues)
    .where(
      and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)),
    )
    .then((rows) => rows[0] ?? null);
  if (!issue) return [];

  let sources: string[];
  const githubConversations = await input.db.select({ id: chatConversations.id })
    .from(chatConversations)
    .innerJoin(chatEndpoints, and(
      eq(chatEndpoints.companyId, chatConversations.companyId),
      eq(chatEndpoints.id, chatConversations.endpointId),
    ))
    .where(and(
      eq(chatConversations.companyId, input.companyId),
      eq(chatConversations.issueId, input.issueId),
      eq(chatEndpoints.provider, "github"),
    ));
  if (githubConversations.length) {
    const binding = and(
      eq(chatDeliveries.companyId, input.companyId),
      inArray(chatDeliveries.conversationId, githubConversations.map((row) => row.id)),
      eq(chatDeliveries.state, "processed"),
    );
    const admitted = () => input.db.select({ event: chatDeliveries.normalizedEvent })
      .from(chatDeliveries)
      .innerJoin(chatMessageLinks, and(
        eq(chatMessageLinks.companyId, chatDeliveries.companyId),
        eq(chatMessageLinks.endpointId, chatDeliveries.endpointId),
        eq(chatMessageLinks.deliveryId, chatDeliveries.id),
        eq(chatMessageLinks.conversationId, chatDeliveries.conversationId),
        eq(chatMessageLinks.direction, "inbound"),
      ));
    const forComments = input.commentIds?.length
      ? await admitted().where(and(binding, inArray(chatMessageLinks.commentId, input.commentIds)))
      : [];
    // Interaction continuations and board wakes have no inbound comment id.
    // Retain the latest admitted configuration, never provider-derived text.
    const rows = forComments.length ? forComments : await admitted().where(binding)
      .orderBy(desc(chatDeliveries.createdAt), desc(chatDeliveries.id)).limit(1);
    sources = rows.flatMap((row) => githubConfiguredInstructionSources(row.event));
  } else {
    const comments = await input.db.select({ body: issueComments.body }).from(issueComments)
      .where(and(
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.companyId, input.companyId),
        isNull(issueComments.deletedAt),
      ));
    sources = [issue.title, issue.description ?? "", ...comments.map((comment) => comment.body)];
  }
  const mentionedSkillIds = extractMentionedSkillIdsFromSources(sources);
  if (mentionedSkillIds.length === 0) return [];

  const skillRows = await input.db
    .select({
      id: companySkillsTable.id,
      key: companySkillsTable.key,
    })
    .from(companySkillsTable)
    .where(
      and(
        eq(companySkillsTable.companyId, input.companyId),
        inArray(companySkillsTable.id, mentionedSkillIds),
      ),
    );
  const skillKeyById = new Map(skillRows.map((row) => [row.id, row.key]));
  return mentionedSkillIds
    .map((skillId) => skillKeyById.get(skillId) ?? null)
    .filter((skillKey): skillKey is string => Boolean(skillKey));
}


export interface WakeupOptions {
  /** Set only by authenticated board wake routes; never copied from caller payloads. */
  manualUserWake?: boolean;
  /** Internal resume of a queue with persisted board interruption intent. */
  queuedCommentInterruptId?: string;
  /** Internal delivery of an existing undelivered user comment. */
  queuedCommentRequestId?: string;
  /** Exact failed run selected by an authenticated board Retry request. */
  failedRunId?: string | null;
  durableChatRequest?: DurableChatWakeupRequest;
  /** Server-owned Dot admission receipt; never accepted from API payloads. */
  durableDotRequest?: {
    id: string;
    companyId: string;
    agentId: string;
    issueId: string;
    requestId: string;
    idempotencyKey: string;
    requestedAt: Date;
  };
  /** Server-owned Muse admission receipt; never accepted from API payloads. */
  durableMuseRequest?: NonNullable<WakeupOptions["durableDotRequest"]> & {
    bindingId: string;
    bindingGeneration: number;
    requestDigest: string;
  };
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
  issueStateGuard?: {
    statuses: string[];
    assigneeAgentId: string;
    statusVersion?: number;
    monitorNextCheckAt?: string;
    monitorWakeRequestedAt?: string;
  };
  /** Keep causally distinct external chat continuations out of an existing run. */
  allowRunCoalescing?: boolean;
}

function sanitizeAgentSessionMessageText(value: unknown): string | null {
  const text = readNonEmptyString(value);
  if (!text) return null;
  const redacted = redactSensitiveText(text).slice(
    0,
    MAX_AGENT_SESSION_MESSAGE_CHARS,
  );
  return redacted.trim().length > 0 ? redacted : null;
}

type ManagedMcpGatewayRunConfig = {
  version: 1;
  managedMcpOnly: boolean;
  gateways: Array<{
    id: string;
    name: string;
    endpointPath: string;
    bearerToken: string;
    tokenPrefix: string;
  }>;
};

export function configuredPaperclipApiBaseUrl(): string | null {
  const configured = readNonEmptyString(process.env.PAPERCLIP_API_URL);
  return configured
    ? configured.replace(/\/+$/, "").replace(/\/api$/, "")
    : null;
}

export function paperclipApiBaseUrl(): string {
  const configured = configuredPaperclipApiBaseUrl();
  if (!configured) {
    throw new Error(
      "PAPERCLIP_API_URL is required to deliver managed runtime MCP servers",
    );
  }
  return configured;
}

export async function revokeHeartbeatRunGatewayTokens(input: {
  db: Db;
  companyId: string;
  runId: string;
}): Promise<void> {
  const now = new Date();
  await input.db
    .update(toolMcpGatewayTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(toolMcpGatewayTokens.companyId, input.companyId),
        eq(toolMcpGatewayTokens.subjectType, "heartbeat_run"),
        eq(toolMcpGatewayTokens.subjectId, input.runId),
        isNull(toolMcpGatewayTokens.revokedAt),
      ),
    );
}

export async function buildPaperclipRuntimeMcpServers(input: {
  db: Db;
  agent: Pick<typeof agents.$inferSelect, "id" | "companyId" | "name">;
  runId: string;
  expectedAssignmentDigest?: string | null;
}): Promise<AdapterRuntimeMcpServer[]> {
  const access = toolAccessService(input.db);
  const effective = await access.getEffectiveProfilesForAgent(
    input.agent.companyId,
    input.agent.id,
  );
  const [runIdentity] = await input.db
    .select({
      contextSnapshot: heartbeatRuns.contextSnapshot,
      responsibleUserId: heartbeatRuns.responsibleUserId,
      activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.agent.companyId),
        eq(heartbeatRuns.agentId, input.agent.id),
      ),
    )
    .limit(1);
  const resolvedInstalledConnections = runIdentity?.activeIdentityContextId
    ? effective.installedConnections
    : await filterResolvedGitHubConnectionsForRun({
        db: input.db,
        companyId: input.agent.companyId,
        agentId: input.agent.id,
        responsibleUserId: runIdentity?.responsibleUserId ?? null,
        connections: effective.installedConnections,
      });
  const permittedConnectionIds = new Set([
    ...effective.entries
      .filter((entry) => entry.effect === "include" && entry.connectionId)
      .map((entry) => entry.connectionId!),
    ...effective.allowedTools.map((tool) => tool.connectionId),
  ]);
  const allInstalledConnectionIds = new Set(
    effective.installedConnections.map((connection) => connection.id),
  );
  const permittedConnections =
    permittedConnectionIds.size > 0
      ? await input.db
          .select({
            id: toolConnections.id,
            name: toolConnections.name,
            transport: toolConnections.transport,
            config: toolConnections.config,
          })
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.companyId, input.agent.companyId),
              inArray(toolConnections.id, [...permittedConnectionIds]),
            ),
          )
      : [];
  const permittedNotInstalledConnections = permittedConnections
    .filter(
      (connection) =>
        (connection.transport === "mcp_remote" ||
          connection.transport === "local_stdio" || isBrowserUseConnection(connection)) &&
        !allInstalledConnectionIds.has(connection.id),
    )
    .map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const githubBotConnectionIds = await githubBotConnectionIdsForRun(input.db, input.agent.companyId, input.agent.id, input.runId);
  const spekoConnectionIds = effective.installedConnections.some(connection => connection.transport === "voice")
    ? new Set((await spekoToolsForSession(input.db, {
        companyId: input.agent.companyId,
        agentId: input.agent.id,
        runId: input.runId,
        issueId: readNonEmptyString(runIdentity?.contextSnapshot?.issueId ?? runIdentity?.contextSnapshot?.taskId),
        identityContextId: runIdentity?.activeIdentityContextId,
      })).map(tool => tool.connectionId))
    : new Set<string>();
  const assignedConnections = resolvedInstalledConnections.filter(
    (connection) =>
      permittedConnectionIds.has(connection.id) &&
      connection.status === "active" &&
      connection.enabled &&
      ((Boolean(runIdentity?.activeIdentityContextId) &&
        (connection.config?.sourceTemplateKey === "github" ||
          connection.transportConfig?.sourceTemplateKey === "github")) ||
        connection.credentialPolicy === "per_user" ||
        !isToolConnectionAttentionHealth(connection.healthStatus)) &&
      (connection.transport === "mcp_remote" ||
        connection.transport === "local_stdio" || isBrowserUseConnection(connection) || githubBotConnectionIds.has(connection.id) || spekoConnectionIds.has(connection.id)),
  );
  const assignedConnectionIds = new Set(
    assignedConnections.map((connection) => connection.id),
  );
  const assignedTools = effective.allowedTools.filter((tool) =>
    assignedConnectionIds.has(tool.connectionId),
  );
  const service = createToolGatewayService(input.db);
  if (assignedConnections.length === 0) {
    await service.recordRuntimeMcpDeliveryDiagnostic({
      companyId: input.agent.companyId,
      agentId: input.agent.id,
      runId: input.runId,
      permittedNotInstalledConnections,
    });
    return [];
  }
  const assignment = {
    version: 1,
    agentId: input.agent.id,
    connections: assignedConnections.map((connection) => connection.id).sort(),
    tools: assignedTools.map((tool) => tool.id).sort(),
  };
  const assignmentDigest = createHash("sha256")
    .update(JSON.stringify(assignment))
    .digest("hex");
  // Native runs may lose access after their immutable context is captured, but
  // they must never gain a new or changed assignment during dispatch.
  if (
    input.expectedAssignmentDigest !== undefined &&
    input.expectedAssignmentDigest !== assignmentDigest
  ) {
    return [];
  }
  const profileKey = `native:${input.agent.id}:${assignmentDigest}`;
  let [profile] = await input.db
    .select()
    .from(toolProfiles)
    .where(
      and(
        eq(toolProfiles.companyId, input.agent.companyId),
        eq(toolProfiles.profileKey, profileKey),
      ),
    )
    .limit(1);

  if (!profile) {
    const fullConnectionIds = new Set(
      effective.entries
        .filter(
          (entry) =>
            entry.effect === "include" &&
            entry.selectorType === "connection" &&
            entry.connectionId,
        )
        .map((entry) => entry.connectionId!),
    );
    const entries = [
      ...assignedConnections
        .filter((connection) => fullConnectionIds.has(connection.id))
        .map((connection) => ({
          selectorType: "connection" as const,
          effect: "include" as const,
          applicationId: connection.applicationId,
          connectionId: connection.id,
        })),
      ...assignedTools
        .filter((tool) => !fullConnectionIds.has(tool.connectionId))
        .map((tool) => ({
          selectorType: "catalog_entry" as const,
          effect: "include" as const,
          applicationId: tool.applicationId,
          connectionId: tool.connectionId,
          catalogEntryId: tool.id,
        })),
    ];
    // The 250-entry limit bounds a public profile-edit request, not the
    // effective assignment assembled from existing profiles. Keep every exact
    // selector here: truncating or replacing them with connection-wide grants
    // would either lose assigned tools or authorize tools outside this snapshot.
    try {
      const created = await access.createProfile(input.agent.companyId, {
        profileKey,
        name: `Native ${input.agent.id.slice(0, 8)} ${assignmentDigest.slice(0, 12)}`,
        description: "Immutable Paperclip Runner MCP assignment profile.",
        status: "active",
        defaultAction: "deny",
        metadata: {
          source: "paperclip_runner",
          agentId: input.agent.id,
          assignmentDigest,
        },
        entries,
      });
      [profile] = await input.db
        .select()
        .from(toolProfiles)
        .where(eq(toolProfiles.id, created.id))
        .limit(1);
    } catch (error) {
      [profile] = await input.db
        .select()
        .from(toolProfiles)
        .where(
          and(
            eq(toolProfiles.companyId, input.agent.companyId),
            eq(toolProfiles.profileKey, profileKey),
          ),
        )
        .limit(1);
      if (!profile) throw error;
    }
  }

  if (profile!.metadata?.source !== "paperclip_runner" || profile!.metadata?.agentId !== input.agent.id ||
      profile!.metadata?.assignmentDigest !== assignmentDigest) {
    throw new Error("Invalid native runtime profile provenance");
  }

  let [gateway] = (
    await input.db
      .select()
      .from(toolMcpGateways)
      .where(
        and(
          eq(toolMcpGateways.companyId, input.agent.companyId),
          eq(toolMcpGateways.status, "active"),
          isNull(toolMcpGateways.archivedAt),
        ),
      )
  ).filter(
    (candidate) =>
      candidate.metadata?.nativeRuntimeAssignmentDigest === assignmentDigest &&
      candidate.metadata?.agentId === input.agent.id &&
      candidate.profileId === profile!.id &&
      (!candidate.agentId || candidate.agentId === input.agent.id),
  );
  // Gateways created before the agent binding existed have a null agentId, and
  // named-gateway auth only rejects another agent's run token when it is set.
  // The assignment digest includes the agent id, so a reused gateway is this
  // agent's own: bind it here instead of waiting for the assignment to change.
  if (gateway && !gateway.agentId) {
    await input.db
      .update(toolMcpGateways)
      .set({ agentId: input.agent.id, contextScopeType: "agent", contextScopeId: input.agent.id, updatedAt: new Date() })
      .where(
        and(
          eq(toolMcpGateways.id, gateway.id),
          eq(toolMcpGateways.companyId, input.agent.companyId),
          isNull(toolMcpGateways.agentId),
        ),
      );
    [gateway] = await input.db
      .select()
      .from(toolMcpGateways)
      .where(eq(toolMcpGateways.id, gateway.id))
      .limit(1);
  }
  if (!gateway) {
    const slug = `native-${input.agent.id.replaceAll("-", "").slice(0, 12)}-${assignmentDigest.slice(0, 16)}`;
    try {
      const created = await service.createNamedGateway({
        companyId: input.agent.companyId,
        body: {
          name: `Native ${input.agent.name} ${assignmentDigest.slice(0, 8)}`,
          slug,
          description: "Run-scoped Paperclip Runner MCP gateway.",
          profileId: profile!.id,
          defaultProfileMode: "gateway_only",
          agentId: input.agent.id,
          contextScopeType: "agent",
          contextScopeId: input.agent.id,
          metadata: {
            nativeRuntimeAssignmentDigest: assignmentDigest,
            agentId: input.agent.id,
          },
        },
        actor: { agentId: input.agent.id },
      });
      [gateway] = await input.db
        .select()
        .from(toolMcpGateways)
        .where(eq(toolMcpGateways.id, created.id))
        .limit(1);
    } catch (error) {
      [gateway] = await input.db
        .select()
        .from(toolMcpGateways)
        .where(
          and(
            eq(toolMcpGateways.companyId, input.agent.companyId),
            eq(toolMcpGateways.slug, slug),
          ),
        )
        .limit(1);
      if (!gateway) throw error;
    }
  }

  if (gateway!.agentId !== input.agent.id || gateway!.profileId !== profile!.id ||
      gateway!.metadata?.agentId !== input.agent.id ||
      gateway!.metadata?.nativeRuntimeAssignmentDigest !== assignmentDigest) {
    throw new Error("Invalid native runtime gateway provenance");
  }

  const token = await service.createNamedGatewayToken({
    companyId: input.agent.companyId,
    gatewayId: gateway!.id,
    body: {
      name: `Run ${input.runId.slice(0, 8)}`,
      subjectType: "heartbeat_run",
      subjectId: input.runId,
      clientLabel: `${input.agent.name} heartbeat run`,
      ownerNote: `Short-lived runtime MCP token for heartbeat run ${input.runId}.`,
      allowedActions: ["tools/list", "tools/call"],
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    },
    actor: { agentId: input.agent.id },
  });

  return [
    {
      name: ASSIGNED_MCP_SERVER_NAME,
      url: `${paperclipApiBaseUrl()}/mcp/gateways/${gateway!.gatewayPublicId}`,
      token: token.token,
      connectionId: `assignment:${assignmentDigest}`,
    },
  ];
}

export function createAdapterRuntimeMcpAccess(
  servers: AdapterRuntimeMcpServer[],
): AdapterRuntimeMcpAccess | undefined {
  if (servers.length === 0) return undefined;
  const snapshot = servers.map((server) => Object.freeze({ ...server }));
  return Object.freeze({
    getServers: () => snapshot.map((server) => ({ ...server })),
  });
}

export function createAdapterRuntimeToolAccess(input: {
  agentId: string;
  companyId: string;
  runId: string;
  responsibleUserId: string | null;
}): AdapterRuntimeToolAccess | undefined {
  if (!input.responsibleUserId) return undefined;
  const minted = createRuntimeToolsToken({
    agentId: input.agentId,
    companyId: input.companyId,
    runId: input.runId,
    responsibleUserId: input.responsibleUserId,
  });
  if (!minted) return undefined;
  // The normal server bootstrap always exports PAPERCLIP_API_URL. Some service
  // tests invoke heartbeat execution without booting an HTTP server, however;
  // in that context there is no reachable endpoint to advertise and runtime
  // tools should simply remain unavailable instead of failing the run.
  const baseUrl = configuredPaperclipApiBaseUrl();
  if (!baseUrl) return undefined;
  return Object.freeze({
    version: 1,
    guidance: CONNECTION_INTENT_AGENT_GUIDANCE,
    mcpEndpoint: `${baseUrl}/mcp/runtime-tools`,
    rest: {
      connectionsSearch: `${baseUrl}/runtime-tools/connections/search`,
      connectionRequest: `${baseUrl}/runtime-tools/connections/request`,
    },
    bearerToken: minted.token,
    expiresAt: minted.expiresAt,
    tools: CONNECTION_RUNTIME_TOOL_NAMES,
  });
}

const MANAGED_MCP_LOCAL_ADAPTERS = new Set(["codex_local"]);

function adapterSupportsManagedMcpConfig(adapterType: string): boolean {
  return MANAGED_MCP_LOCAL_ADAPTERS.has(adapterType);
}

function gatewayAppliesToRun(input: {
  gateway: typeof toolMcpGateways.$inferSelect;
  agentId: string;
  projectId: string | null;
  issueId: string | null;
}): boolean {
  const { gateway, agentId, projectId, issueId } = input;
  if (gateway.agentId && gateway.agentId !== agentId) return false;
  if (gateway.projectId && gateway.projectId !== projectId) return false;
  if (gateway.issueId && gateway.issueId !== issueId) return false;
  if (
    gateway.contextScopeType === "agent" &&
    gateway.contextScopeId &&
    gateway.contextScopeId !== agentId
  )
    return false;
  if (
    gateway.contextScopeType === "project" &&
    gateway.contextScopeId &&
    gateway.contextScopeId !== projectId
  )
    return false;
  if (
    gateway.contextScopeType === "issue" &&
    gateway.contextScopeId &&
    gateway.contextScopeId !== issueId
  )
    return false;
  return true;
}

async function gatewayConnectionIds(input: {
  db: Db;
  companyId: string;
  gateway: typeof toolMcpGateways.$inferSelect;
}): Promise<Set<string>> {
  const managedRuntimeConnectionId = readNonEmptyString(
    input.gateway.metadata?.managedRuntimeConnectionId,
  );
  if (managedRuntimeConnectionId) return new Set([managedRuntimeConnectionId]);

  const [profile, entries, catalog, connections] = await Promise.all([
    input.db
      .select({ defaultAction: toolProfiles.defaultAction })
      .from(toolProfiles)
      .where(
        and(
          eq(toolProfiles.companyId, input.companyId),
          eq(toolProfiles.id, input.gateway.profileId),
        ),
      )
      .then((rows) => rows[0] ?? null),
    input.db
      .select()
      .from(toolProfileEntries)
      .where(
        and(
          eq(toolProfileEntries.companyId, input.companyId),
          eq(toolProfileEntries.profileId, input.gateway.profileId),
        ),
      ),
    input.db
      .select({
        id: toolCatalogEntries.id,
        connectionId: toolCatalogEntries.connectionId,
        applicationId: toolCatalogEntries.applicationId,
        toolName: toolCatalogEntries.toolName,
        riskLevel: toolCatalogEntries.riskLevel,
      })
      .from(toolCatalogEntries)
      .where(
        and(
          eq(toolCatalogEntries.companyId, input.companyId),
          eq(toolCatalogEntries.status, "active"),
        ),
      ),
    input.db
      .select({
        id: toolConnections.id,
        applicationId: toolConnections.applicationId,
      })
      .from(toolConnections)
      .where(eq(toolConnections.companyId, input.companyId)),
  ]);
  if (!profile) return new Set();
  if (profile.defaultAction === "allow")
    return new Set(catalog.map((entry) => entry.connectionId));

  const connectionIds = new Set<string>();
  for (const entry of entries) {
    if (entry.effect !== "include") continue;
    if (entry.connectionId) connectionIds.add(entry.connectionId);
    if (entry.applicationId) {
      for (const connection of connections) {
        if (connection.applicationId === entry.applicationId)
          connectionIds.add(connection.id);
      }
    }
    for (const catalogEntry of catalog) {
      if (
        (entry.catalogEntryId && entry.catalogEntryId === catalogEntry.id) ||
        (entry.toolName && entry.toolName === catalogEntry.toolName) ||
        (entry.riskLevel && entry.riskLevel === catalogEntry.riskLevel)
      ) {
        connectionIds.add(catalogEntry.connectionId);
      }
    }
  }
  return connectionIds;
}

export async function createManagedMcpRunConfig(input: {
  db: Db;
  agent: Pick<
    typeof agents.$inferSelect,
    "id" | "companyId" | "name" | "adapterType"
  >;
  runId: string;
  config: Record<string, unknown>;
  projectId: string | null;
  issueId: string | null;
}): Promise<ManagedMcpGatewayRunConfig | null> {
  if (!adapterSupportsManagedMcpConfig(input.agent.adapterType)) return null;
  if (input.config.managedMcpOnly === false) return null;

  const rows = await input.db
    .select()
    .from(toolMcpGateways)
    .where(
      and(
        eq(toolMcpGateways.companyId, input.agent.companyId),
        eq(toolMcpGateways.status, "active"),
        isNull(toolMcpGateways.archivedAt),
        // A native profile remains an immutable assignment even if gateway
        // metadata is cleared. Explicit shared gateways use ordinary profiles.
        sql`not exists (
          select 1 from ${toolProfiles}
          where ${toolProfiles.id} = ${toolMcpGateways.profileId}
            and ${toolProfiles.companyId} = ${toolMcpGateways.companyId}
            and (${toolProfiles.profileKey} like 'native:%'
              or ${toolProfiles.metadata}->>'source' = 'paperclip_runner')
        )`,
      ),
    )
    .orderBy(asc(toolMcpGateways.name));

  const installRows = await input.db
    .select({
      connectionId: toolConnectionInstalls.connectionId,
      enabled: toolConnections.enabled,
      status: toolConnections.status,
      healthStatus: toolConnections.healthStatus,
      config: toolConnections.config,
      transportConfig: toolConnections.transportConfig,
    })
    .from(toolConnectionInstalls)
    .innerJoin(
      toolConnections,
      and(
        eq(toolConnections.id, toolConnectionInstalls.connectionId),
        eq(toolConnections.companyId, toolConnectionInstalls.companyId),
      ),
    )
    .where(
      and(
        eq(toolConnectionInstalls.companyId, input.agent.companyId),
        sql`((${toolConnectionInstalls.targetType} = 'company' and ${toolConnectionInstalls.targetId} = ${input.agent.companyId}) or (${toolConnectionInstalls.targetType} = 'agent' and ${toolConnectionInstalls.targetId} = ${input.agent.id}))`,
      ),
    );
  const [runIdentity] = await input.db
    .select({
      responsibleUserId: heartbeatRuns.responsibleUserId,
      activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.agent.companyId),
        eq(heartbeatRuns.agentId, input.agent.id),
      ),
    )
    .limit(1);
  const resolvedAvailableInstalls = runIdentity?.activeIdentityContextId
    ? installRows
        .filter((install) => install.enabled && install.status === "active")
        .map((install) => ({ id: install.connectionId }))
    : await filterResolvedGitHubConnectionsForRun({
        db: input.db,
        companyId: input.agent.companyId,
        agentId: input.agent.id,
        responsibleUserId: runIdentity?.responsibleUserId ?? null,
        connections: installRows
          .filter(
            (install) =>
              install.enabled &&
              install.status === "active" &&
              !["degraded", "failed", "error", "missing_secret"].includes(
                install.healthStatus,
              ),
          )
          .map((install) => ({
            id: install.connectionId,
            config: install.config,
            transportConfig: install.transportConfig,
          })),
      });
  const availableInstalledConnectionIds = new Set(
    resolvedAvailableInstalls.map((install) => install.id),
  );

  const applicableGateways = rows.filter((gateway) =>
    // The immutable native assignment is delivered separately. Including any
    // historical native gateway here duplicates and broadens that assignment.
    !Object.hasOwn(gateway.metadata ?? {}, "nativeRuntimeAssignmentDigest") && gatewayAppliesToRun({
      gateway,
      agentId: input.agent.id,
      projectId: input.projectId,
      issueId: input.issueId,
    }),
  );
  const gateways = (
    await Promise.all(
      applicableGateways.map(async (gateway) => ({
        gateway,
        connectionIds: await gatewayConnectionIds({
          db: input.db,
          companyId: input.agent.companyId,
          gateway,
        }),
      })),
    )
  )
    .filter(
      ({ connectionIds }) =>
        connectionIds.size > 0 &&
        [...connectionIds].every((connectionId) =>
          availableInstalledConnectionIds.has(connectionId),
        ),
    )
    .map(({ gateway }) => gateway);
  if (gateways.length === 0) return null;

  const service = createToolGatewayService(input.db);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const managedGateways: ManagedMcpGatewayRunConfig["gateways"] = [];
  for (const gateway of gateways) {
    const token = await service.createNamedGatewayToken({
      companyId: input.agent.companyId,
      gatewayId: gateway.id,
      body: {
        name: `Managed ${input.agent.name} ${input.runId.slice(0, 8)}`,
        subjectType: "heartbeat_run",
        subjectId: input.runId,
        clientLabel: `${input.agent.name} managed local adapter`,
        ownerNote: `Short-lived Paperclip-managed MCP token for heartbeat run ${input.runId}.`,
        allowedActions: ["tools/list", "tools/call"],
        expiresAt,
      },
      actor: { agentId: input.agent.id },
    });
    managedGateways.push({
      id: gateway.id,
      name: gateway.name,
      // This path must bypass the normal /api agent-JWT middleware. The MCP
      // gateway performs its own bearer validation for the run-scoped token.
      endpointPath: `/mcp/gateways/${gateway.gatewayPublicId}`,
      bearerToken: token.token,
      tokenPrefix: token.tokenPrefix,
    });
  }

  return {
    version: 1,
    managedMcpOnly: true,
    gateways: managedGateways,
  };
}

export function deriveTaskKey(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.taskKey) ??
    readNonEmptyString(contextSnapshot?.taskId) ??
    readNonEmptyString(contextSnapshot?.issueId) ??
    readNonEmptyString(payload?.taskKey) ??
    readNonEmptyString(payload?.taskId) ??
    readNonEmptyString(payload?.issueId) ??
    null
  );
}

function mergeWakeCommentIds(...values: Array<unknown>): string[] {
  const merged: string[] = [];
  const append = (value: unknown) => {
    const normalized = readNonEmptyString(value);
    if (!normalized || merged.includes(normalized)) return;
    merged.push(normalized);
  };

  for (const value of values) {
    if (Array.isArray(value)) {
      for (const entry of value) append(entry);
      continue;
    }
    if (typeof value === "object" && value !== null) {
      const candidate = value as Record<string, unknown>;
      const batched = extractWakeCommentIds(candidate);
      if (batched.length > 0) {
        for (const entry of batched) append(entry);
        continue;
      }
      append(candidate.wakeCommentId);
      append(candidate.commentId);
      continue;
    }
    append(value);
  }

  return merged;
}

const EXTERNAL_ATTACHMENT_OMISSION_REASONS = new Set([
  "attachment_limit",
  "storage_unavailable",
  "declared_too_large",
  "download_unavailable",
  "unsupported_type",
  "empty_download",
  "downloaded_too_large",
  "processing_failed",
]);

type ExternalAttachmentOmission = {
  commentId: string;
  reasons: Record<string, number>;
};

function readExternalAttachmentOmissions(
  value: unknown,
): ExternalAttachmentOmission[] {
  if (!Array.isArray(value)) return [];
  const byCommentId = new Map<string, ExternalAttachmentOmission>();
  for (const candidate of value) {
    const record = parseObject(candidate);
    const commentId = readNonEmptyString(record.commentId);
    if (!commentId) continue;
    const reasons = Object.fromEntries(
      Object.entries(parseObject(record.reasons)).flatMap(([reason, count]) =>
        EXTERNAL_ATTACHMENT_OMISSION_REASONS.has(reason) &&
        typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count > 0
          ? [[reason, count]]
          : [],
      ),
    );
    if (Object.keys(reasons).length === 0) continue;
    byCommentId.set(commentId, { commentId, reasons });
  }
  return [...byCommentId.values()].slice(-50);
}

function mergeExternalAttachmentOmissions(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
) {
  return readExternalAttachmentOmissions([
    ...readExternalAttachmentOmissions(
      existing[EXTERNAL_ATTACHMENT_OMISSIONS_KEY],
    ),
    ...readExternalAttachmentOmissions(
      incoming[EXTERNAL_ATTACHMENT_OMISSIONS_KEY],
    ),
  ]);
}

function externalAttachmentOmissionNotice(
  omission: ExternalAttachmentOmission,
) {
  const entries = Object.entries(omission.reasons);
  const omitted = entries.reduce((total, [, count]) => total + count, 0);
  const reasons = entries
    .map(([reason, count]) => `${reason.replaceAll("_", " ")}: ${count}`)
    .join(", ");
  return `Paperclip could not import every attachment from this exact external message: ${omitted} attachment${omitted === 1 ? " was" : "s were"} omitted (${reasons}). Treat omitted attachments as unavailable; do not infer their contents or substitute an older workspace file.`;
}

export function enrichWakeContextSnapshot(input: {
  contextSnapshot: Record<string, unknown>;
  reason: string | null;
  source: WakeupOptions["source"];
  triggerDetail: WakeupOptions["triggerDetail"] | null;
  payload: Record<string, unknown> | null;
}) {
  const { contextSnapshot, reason, source, triggerDetail, payload } = input;
  const issueIdFromPayload =
    readNonEmptyString(payload?.["issueId"]) ??
    readNonEmptyString(payload?.["taskId"]);
  const commentIdFromPayload = readNonEmptyString(payload?.["commentId"]);
  const taskKey = deriveTaskKey(contextSnapshot, payload);
  const wakeCommentId = deriveCommentId(contextSnapshot, payload);
  const wakeCommentIds = mergeWakeCommentIds(
    contextSnapshot,
    commentIdFromPayload,
  );

  if (!readNonEmptyString(contextSnapshot["wakeReason"]) && reason) {
    contextSnapshot.wakeReason = reason;
  }
  if (!readNonEmptyString(contextSnapshot["issueId"]) && issueIdFromPayload) {
    contextSnapshot.issueId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskId"]) && issueIdFromPayload) {
    contextSnapshot.taskId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskKey"]) && taskKey) {
    contextSnapshot.taskKey = taskKey;
  }
  if (
    !readNonEmptyString(contextSnapshot["commentId"]) &&
    commentIdFromPayload
  ) {
    contextSnapshot.commentId = commentIdFromPayload;
  }
  if (wakeCommentIds.length > 0) {
    const latestCommentId = wakeCommentIds[wakeCommentIds.length - 1];
    contextSnapshot[WAKE_COMMENT_IDS_KEY] = wakeCommentIds;
    contextSnapshot.commentId = latestCommentId;
    contextSnapshot.wakeCommentId = latestCommentId;
    // Once comment ids are normalized into the snapshot, rebuild the structured
    // wake payload from those ids later instead of carrying forward stale data.
    delete contextSnapshot[PAPERCLIP_WAKE_PAYLOAD_KEY];
  } else if (
    !readNonEmptyString(contextSnapshot["wakeCommentId"]) &&
    wakeCommentId
  ) {
    contextSnapshot.wakeCommentId = wakeCommentId;
  }
  if (!readNonEmptyString(contextSnapshot["wakeSource"]) && source) {
    contextSnapshot.wakeSource = source;
  }
  if (
    !readNonEmptyString(contextSnapshot["wakeTriggerDetail"]) &&
    triggerDetail
  ) {
    contextSnapshot.wakeTriggerDetail = triggerDetail;
  }
  normalizeInteractionContinuationWakeContext(contextSnapshot, payload);

  return {
    contextSnapshot,
    issueIdFromPayload,
    commentIdFromPayload,
    taskKey,
    wakeCommentId,
  };
}

const INTERACTION_CONTINUATION_CONTEXT_KEYS = [
  "interactionId",
  "interactionKind",
  "interactionStatus",
  "continuationPolicy",
  "checkboxSelection",
  "itemVerdicts",
  "newlyResolvedItemIds",
] as const;

export function isInteractionResolutionWakePayload(
  payload: Record<string, unknown> | null | undefined,
) {
  return readNonEmptyString(payload?.mutation) === "interaction";
}

export function clearInteractionContinuationWakeContext(
  contextSnapshot: Record<string, unknown>,
) {
  for (const key of INTERACTION_CONTINUATION_CONTEXT_KEYS) {
    delete contextSnapshot[key];
  }
}

export function hasInteractionContinuationWakeContext(
  contextSnapshot: Record<string, unknown>,
) {
  return INTERACTION_CONTINUATION_CONTEXT_KEYS.some((key) =>
    readNonEmptyString(contextSnapshot[key]),
  );
}

function normalizeInteractionContinuationWakeContext(
  contextSnapshot: Record<string, unknown>,
  payload: Record<string, unknown> | null | undefined,
) {
  if (isInteractionResolutionWakePayload(payload)) return;
  clearInteractionContinuationWakeContext(contextSnapshot);
}

type AcceptedPlanWakeRoutingDecision = {
  otherActiveClaimIssueId: string;
  otherActiveClaimIdentifier: string | null;
  otherActiveClaimTitle: string;
  forceFreshSession: boolean;
  suppressAcceptedContinuation: boolean;
};

export async function resolveAcceptedPlanWakeRoutingDecision(args: {
  db: Db;
  companyId: string;
  agentId: string;
  issueId: string | null;
  acceptedPlanContinuationWake: boolean;
  contextSnapshot: Record<string, unknown>;
}): Promise<AcceptedPlanWakeRoutingDecision | null> {
  if (args.issueId === null) return null;
  if (!args.acceptedPlanContinuationWake) return null;

  const activeClaims = await args.db
    .select({
      sourceIssueId: issuePlanDecompositions.sourceIssueId,
      identifier: issues.identifier,
      title: issues.title,
    })
    .from(issuePlanDecompositions)
    .innerJoin(issues, eq(issues.id, issuePlanDecompositions.sourceIssueId))
    .where(
      and(
        eq(issuePlanDecompositions.companyId, args.companyId),
        eq(issuePlanDecompositions.ownerAgentId, args.agentId),
        eq(issuePlanDecompositions.status, "in_flight"),
      ),
    )
    .orderBy(
      desc(issuePlanDecompositions.updatedAt),
      asc(issuePlanDecompositions.createdAt),
    );

  if (activeClaims.length === 0) return null;
  if (activeClaims.some((claim) => claim.sourceIssueId === args.issueId))
    return null;

  const otherActiveClaim = activeClaims[0];
  if (!otherActiveClaim) return null;

  const hasAcceptedContinuationWake =
    readNonEmptyString(args.contextSnapshot.interactionKind) ===
      "request_confirmation" &&
    readNonEmptyString(args.contextSnapshot.interactionStatus) === "accepted";

  return {
    otherActiveClaimIssueId: otherActiveClaim.sourceIssueId,
    otherActiveClaimIdentifier: otherActiveClaim.identifier ?? null,
    otherActiveClaimTitle: otherActiveClaim.title,
    forceFreshSession: true,
    suppressAcceptedContinuation: hasAcceptedContinuationWake,
  };
}

export function mergeCoalescedContextSnapshot(
  existingRaw: unknown,
  incoming: Record<string, unknown>,
  options: { preserveExistingInteractionContinuation?: boolean } = {},
) {
  const existing = parseObject(existingRaw);
  const existingSource = readNonEmptyString(existing.source);
  const incomingSource = readNonEmptyString(incoming.source);
  const preservesExternalChatOrigin =
    existingSource?.startsWith("chat:") === true &&
    readNonEmptyString(existing.issueId) !== null &&
    existing.issueId === incoming.issueId &&
    incomingSource === "native_status_decision" &&
    readNonEmptyString(incoming.statusDecisionSource) ===
      "native_status_decision";
  const merged: Record<string, unknown> = {
    ...existing,
    ...incoming,
  };
  // Only executeRun can mint this proof. Coalescence may retain an unchanged
  // admitted proof, but must never accept a new marker from an incoming wake.
  delete merged[PAPERCLIP_EXTERNAL_CHAT_EXECUTION_BOUND_KEY];
  delete merged[EXTERNAL_CHAT_QUESTION_RESPONSE_KEY];
  const mergedAttachmentOmissions = mergeExternalAttachmentOmissions(
    existing,
    incoming,
  );
  if (mergedAttachmentOmissions.length > 0) {
    merged[EXTERNAL_ATTACHMENT_OMISSIONS_KEY] = mergedAttachmentOmissions;
  } else {
    delete merged[EXTERNAL_ATTACHMENT_OMISSIONS_KEY];
  }
  // A native status wake is control-flow metadata, not a new user-input
  // provenance. When it coalesces into the live run, retain the verified chat
  // source so the eventual terminal presentation can still prove its route.
  // Fresh status-decision runs keep their native_status_decision source.
  if (preservesExternalChatOrigin) {
    merged.source = existingSource;
  }
  if (
    existing.forceFreshSession === true ||
    incoming.forceFreshSession === true
  ) {
    merged.forceFreshSession = true;
  }
  if (existing.refreshTools === true || incoming.refreshTools === true) {
    merged.refreshTools = true;
  }
  const mergedCommentIds = mergeWakeCommentIds(existing, incoming);
  if (mergedCommentIds.length > 0) {
    const latestCommentId = mergedCommentIds[mergedCommentIds.length - 1];
    merged[WAKE_COMMENT_IDS_KEY] = mergedCommentIds;
    merged.commentId = latestCommentId;
    merged.wakeCommentId = latestCommentId;
    // The merged context should carry canonical comment ids; the next wake will
    // regenerate any structured payload from those ids.
    delete merged[PAPERCLIP_WAKE_PAYLOAD_KEY];
  }
  const existingWake = parseObject(existing[PAPERCLIP_WAKE_PAYLOAD_KEY]);
  const existingCommentIds = extractWakeCommentIds(existing);
  const payloadCommentIds = Array.isArray(existingWake.commentIds)
    ? existingWake.commentIds
    : [];
  const preservesAdmittedWake =
    preservesExternalChatOrigin &&
    parseObject(existingWake.issue).id === existing.issueId &&
    CHAT_PROVIDERS.some(
      (provider) =>
        existingWake.externalChatProvider === provider &&
        (existingSource === `chat:${provider}` ||
          existingSource === `chat:${provider}:recovery`),
    ) &&
    existingCommentIds.length > 0 &&
    mergedCommentIds.length === existingCommentIds.length &&
    mergedCommentIds.every((id, index) => id === existingCommentIds[index]) &&
    payloadCommentIds.length === existingCommentIds.length &&
    payloadCommentIds.every((id, index) => id === existingCommentIds[index]) &&
    ((existing[PAPERCLIP_HARNESS_CHECKOUT_KEY] === true &&
      existingWake.checkedOutByHarness === true) ||
      (existing[PAPERCLIP_EXTERNAL_CHAT_EXECUTION_BOUND_KEY] === true &&
        existingWake.externalChatExecutionBound === true));
  if (preservesAdmittedWake) {
    merged[PAPERCLIP_WAKE_PAYLOAD_KEY] = existingWake;
    merged.wakeReason = existing.wakeReason;
    if (existing[PAPERCLIP_EXTERNAL_CHAT_EXECUTION_BOUND_KEY] === true) {
      merged[PAPERCLIP_EXTERNAL_CHAT_EXECUTION_BOUND_KEY] = true;
    }
  }
  if (
    !hasInteractionContinuationWakeContext(incoming) &&
    !(
      options.preserveExistingInteractionContinuation === true &&
      hasInteractionContinuationWakeContext(existing)
    )
  ) {
    clearInteractionContinuationWakeContext(merged);
  }
  return merged;
}

// This is a prompt optimization, not an authorization grant. Verify the durable
// chat binding rather than trusting an arbitrary caller's source/context marker.
export async function resolveExternalChatWakeProvider(input: {
  db: Db;
  companyId: string;
  agentId?: string | null;
  runId?: string | null;
  issueId: string | null;
  contextSnapshot: Record<string, unknown>;
}): Promise<ChatProvider | null> {
  if (input.contextSnapshot.source === "issue.interaction.respond") {
    if (!input.runId || !input.agentId || !input.issueId) return null;
    const answer = await resolveExternalChatQuestionResponse(
      input.db,
      {
        companyId: input.companyId,
        agentId: input.agentId,
        issueId: input.issueId,
        runId: input.runId,
      },
      input.contextSnapshot,
      "read",
    );
    return answer?.provider ?? null;
  }
  const source = readNonEmptyString(input.contextSnapshot.source);
  const provider = CHAT_PROVIDERS.find(
    (candidate) =>
      source === `chat:${candidate}` || source === `chat:${candidate}:recovery`,
  );
  const commentIds = extractWakeCommentIds(input.contextSnapshot);
  if (
    !provider ||
    !input.agentId ||
    !input.issueId ||
    commentIds.length === 0 ||
    (input.contextSnapshot[PAPERCLIP_HARNESS_CHECKOUT_KEY] !== true &&
      input.contextSnapshot[PAPERCLIP_EXTERNAL_CHAT_EXECUTION_BOUND_KEY] !==
        true)
  ) {
    return null;
  }

  const links = await input.db
    .select({
      commentId: chatMessageLinks.commentId,
      conversationId: chatConversations.id,
    })
    .from(chatMessageLinks)
    .innerJoin(
      chatConversations,
      and(
        eq(chatConversations.companyId, chatMessageLinks.companyId),
        eq(chatConversations.id, chatMessageLinks.conversationId),
        eq(chatConversations.endpointId, chatMessageLinks.endpointId),
      ),
    )
    .innerJoin(
      chatEndpoints,
      and(
        eq(chatEndpoints.companyId, chatConversations.companyId),
        eq(chatEndpoints.id, chatConversations.endpointId),
      ),
    )
    .where(
      and(
        eq(chatMessageLinks.companyId, input.companyId),
        eq(chatMessageLinks.direction, "inbound"),
        inArray(chatMessageLinks.commentId, commentIds),
        eq(chatConversations.issueId, input.issueId),
        inArray(chatConversations.state, ["active", "waiting"]),
        eq(chatEndpoints.provider, provider),
        eq(chatEndpoints.assignedAgentId, input.agentId),
        inArray(chatEndpoints.status, ["active", "verifying"]),
      ),
    );
  const linkedCommentIds = new Set(links.map((link) => link.commentId));
  return new Set(links.map((link) => link.conversationId)).size === 1 &&
    commentIds.every((id) => linkedCommentIds.has(id))
    ? provider
    : null;
}

/** Bind an already-claimed chat/reply turn without checking out or approving it. */
export async function attestReviewedExternalChatRun(input: {
  db: Db;
  companyId: string;
  agentId: string;
  issueId: string;
  runId: string;
  contextSnapshot: Record<string, unknown>;
  /** Diagnostic-only value from the committed, authorized answer; never a wake field. */
  onQuestionResponseAttested?: (answeredAtMs: number) => void;
}): Promise<boolean> {
  const attempt = () =>
    input.db.transaction(
      async (
        transaction,
      ): Promise<boolean | "pending_delivery" | { answeredAtMs: number }> => {
        const tx = transaction as unknown as Db;
        const [issue] = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.id, input.issueId),
              eq(issues.companyId, input.companyId),
            ),
          )
          .for("update", { noWait: true })
          .limit(1);
        const [run] = await tx
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, input.runId),
              eq(heartbeatRuns.companyId, input.companyId),
              eq(heartbeatRuns.agentId, input.agentId),
            ),
          )
          .for("update", { noWait: true })
          .limit(1);
        const [actor] = await tx
          .select({ status: agents.status })
          .from(agents)
          .where(
            and(
              eq(agents.id, input.agentId),
              eq(agents.companyId, input.companyId),
            ),
          )
          .for("update", { noWait: true })
          .limit(1);
        if (
          !issue ||
          !run ||
          !actor ||
          !(
            issue.status === "in_review" ||
            (input.contextSnapshot.source === "issue.interaction.respond" &&
              issue.status === "in_progress")
          ) ||
          issue.assigneeAgentId !== input.agentId ||
          issue.executionRunId !== input.runId ||
          run.status !== "running" ||
          (run.nativeIssueId !== null && run.nativeIssueId !== input.issueId) ||
          // This attestation precedes execution-start's transition to running.
          // A prior run's error projection is invokable, unlike an operator
          // pause, termination, or pending approval; all binding checks remain.
          DIRECT_NON_INVOKABLE_STATUSES.has(actor.status)
        )
          return false;
        const admittedContext = parseObject(run.contextSnapshot);
        const admittedIds = extractWakeCommentIds(admittedContext);
        const suppliedIds = extractWakeCommentIds(input.contextSnapshot);
        if (
          admittedContext.issueId !== input.issueId ||
          input.contextSnapshot.issueId !== input.issueId ||
          admittedContext.source !== input.contextSnapshot.source ||
          admittedIds.length === 0 ||
          admittedIds.length !== suppliedIds.length ||
          admittedIds.some((id, index) => id !== suppliedIds[index])
        )
          return false;
        try {
          const answer =
            admittedContext.source === "issue.interaction.respond"
              ? await resolveExternalChatQuestionResponse(
                  tx,
                  input,
                  admittedContext,
                  "nonblocking",
                  true,
                )
              : null;
          if (admittedContext.source === "issue.interaction.respond" && !answer)
            return false;
          // The marker is built here only after proving the real execution owner.
          // The shared boundary then verifies current provider/resource/principal
          // access for every admitted message; no lifecycle state is mutated.
          await authorizeChatConversationForBoundRun(
            tx,
            input,
            {
              ...(answer?.authorizationContext ?? admittedContext),
              [PAPERCLIP_HARNESS_CHECKOUT_KEY]: false,
              [PAPERCLIP_EXTERNAL_CHAT_EXECUTION_BOUND_KEY]: true,
            },
            "nonblocking",
          );
          if (answer)
            input.contextSnapshot[EXTERNAL_CHAT_QUESTION_RESPONSE_KEY] =
              answer.marker;
          return answer ? { answeredAtMs: answer.answeredAtMs } : true;
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "paperclip_runner_chat_attachment_binding_denied"
          ) {
            // Inbound processing commits the message/link before dispatching its
            // wake, but completes subscription and marks delivery processed after
            // dispatch. Wait for that exact committed batch, never admit it early.
            const links = await tx
              .select({
                commentId: chatMessageLinks.commentId,
                state: chatDeliveries.state,
              })
              .from(chatMessageLinks)
              .innerJoin(
                chatDeliveries,
                and(
                  eq(chatDeliveries.id, chatMessageLinks.deliveryId),
                  eq(chatDeliveries.companyId, chatMessageLinks.companyId),
                  eq(chatDeliveries.endpointId, chatMessageLinks.endpointId),
                  eq(
                    chatDeliveries.conversationId,
                    chatMessageLinks.conversationId,
                  ),
                ),
              )
              .where(
                and(
                  eq(chatMessageLinks.companyId, input.companyId),
                  eq(chatMessageLinks.direction, "inbound"),
                  inArray(chatMessageLinks.commentId, admittedIds),
                ),
              );
            if (
              admittedIds.every((id) =>
                links.some((link) => link.commentId === id),
              ) &&
              links.some((link) => link.state === "processing") &&
              links.every(
                (link) =>
                  link.state === "processing" || link.state === "processed",
              )
            ) {
              return "pending_delivery";
            }
          }
          if (
            error instanceof Error &&
            [
              "paperclip_runner_chat_attachment_binding_denied",
              "paperclip_runner_chat_attachment_destination_denied",
              "paperclip_runner_chat_attachment_principal_denied",
            ].includes(error.message)
          )
            return false;
          throw error;
        }
      },
    );
  // Release every lock before retrying and re-prove the current execution
  // owner, admitted batch, and policy. Routine control-plane contention is not
  // evidence that the user lost access; neither is it permission to bypass it.
  for (let attemptNumber = 0; attemptNumber < 51; attemptNumber += 1) {
    try {
      const result = await attempt();
      if (typeof result === "object") {
        // The transaction (including COMMIT) must succeed before any attempt-
        // local timing is accepted. A retry/rollback cannot publish this value.
        input.onQuestionResponseAttested?.(result.answeredAtMs);
        return true;
      }
      if (result !== "pending_delivery") return result;
    } catch (error) {
      if (!isExternalChatWaitAuthorizationContention(error)) throw error;
    }
    if (attemptNumber < 50)
      await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("reviewed_chat_execution_binding_not_ready");
}

export async function buildPaperclipWakePayload(input: {
  db: Db;
  companyId: string;
  agentId?: string | null;
  runId?: string | null;
  contextSnapshot: Record<string, unknown>;
  continuationSummary?: {
    key: string;
    title: string | null;
    body: string;
    sourceTrust?: SourceTrustMetadata | null;
    updatedAt: Date;
  } | null;
  issueSummary?: {
    id: string;
    identifier: string | null;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    workMode: string;
    projectId?: string | null;
    executionPolicy?: unknown;
  } | null;
  exposeLowTrustRaw?: boolean;
  // Experimental: agents write user-interaction content in ASD-STE100
  // Simplified Technical English (rendered as a prompt directive downstream).
  simplifiedEnglishInteractions?: boolean;
}) {
  const executionStage = parseObject(input.contextSnapshot.executionStage);
  const commentIds = extractWakeCommentIds(input.contextSnapshot);
  const annotationCommentId = readNonEmptyString(
    input.contextSnapshot.annotationCommentId,
  );
  const issueId = readNonEmptyString(input.contextSnapshot.issueId);
  const conversationMode = input.contextSnapshot.conversationMode === true;
  const continuationSummary = conversationMode ? null : input.continuationSummary ?? null;
  const agentMessage = parseObject(
    input.contextSnapshot[PAPERCLIP_AGENT_MESSAGE_KEY],
  );
  const agentMessageText = sanitizeAgentSessionMessageText(agentMessage.text);
  const issueSummary =
    input.issueSummary ??
    (issueId
      ? await input.db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            description: issues.description,
            status: issues.status,
            priority: issues.priority,
            workMode: issues.workMode,
          })
          .from(issues)
          .where(
            and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)),
          )
          .then((rows) => rows[0] ?? null)
      : null);
  if (
    commentIds.length === 0 &&
    Object.keys(executionStage).length === 0 &&
    !issueSummary &&
    !agentMessageText
  )
    return null;

  const commentRows =
    commentIds.length === 0
      ? []
      : await input.db
          .select({
            id: issueComments.id,
            issueId: issueComments.issueId,
            body: issueComments.body,
            origin: issueComments.origin,
            authorType: issueComments.authorType,
            authorAgentId: issueComments.authorAgentId,
            authorUserId: issueComments.authorUserId,
            presentation: issueComments.presentation,
            metadata: issueComments.metadata,
            deletedAt: issueComments.deletedAt,
            deletedByType: issueComments.deletedByType,
            deletedByAgentId: issueComments.deletedByAgentId,
            deletedByUserId: issueComments.deletedByUserId,
            deletedByRunId: issueComments.deletedByRunId,
            sourceTrust: issueComments.sourceTrust,
            createdAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.companyId, input.companyId),
              issueId ? eq(issueComments.issueId, issueId) : undefined,
              inArray(issueComments.id, commentIds),
            ),
          );

  const commentsById = new Map(
    commentRows.map((comment) => [comment.id, comment]),
  );
  const issueDescription = conversationMode ? null : issueSummary?.description ?? null;
  const issueDescriptionTruncated =
    issueDescription !== null &&
    issueDescription.length > MAX_INLINE_WAKE_ISSUE_DESCRIPTION_CHARS;
  const inlineIssueDescription = issueDescriptionTruncated
    ? issueDescription.slice(0, MAX_INLINE_WAKE_ISSUE_DESCRIPTION_CHARS)
    : issueDescription;
  const comments: Array<Record<string, unknown>> = [];
  let remainingBodyChars = MAX_INLINE_WAKE_COMMENT_BODY_TOTAL_CHARS;
  let truncated = false;
  let missingCommentCount = 0;
  const safeContinuationSummary =
    continuationSummary && !input.exposeLowTrustRaw
      ? redactQuarantinedBodyForHigherTrust(continuationSummary)
      : continuationSummary;

  for (const commentId of commentIds) {
    const row = commentsById.get(commentId);
    if (!row) {
      truncated = true;
      missingCommentCount += 1;
      continue;
    }
    if (comments.length >= MAX_INLINE_WAKE_COMMENTS) {
      truncated = true;
      break;
    }

    const deletedAt = row.deletedAt ?? null;
    const safeRow =
      deletedAt || input.exposeLowTrustRaw
        ? row
        : sanitizeQuarantinedCommentForHigherTrust(row);
    const fullBody = deletedAt ? "" : row.origin === "fast_response" ? `[Paperclip acknowledgement; not agent work] ${safeRow.body}` : safeRow.body;
    const allowedBodyChars = Math.min(
      MAX_INLINE_WAKE_COMMENT_BODY_CHARS,
      remainingBodyChars,
    );
    if (allowedBodyChars <= 0) {
      truncated = true;
      break;
    }

    const body =
      fullBody.length > allowedBodyChars
        ? fullBody.slice(0, allowedBodyChars)
        : fullBody;
    const bodyTruncated = body.length < fullBody.length;
    if (bodyTruncated) truncated = true;
    remainingBodyChars -= body.length;

    comments.push({
      id: row.id,
      issueId: row.issueId,
      authorType:
        row.authorType ??
        (row.authorAgentId ? "agent" : row.authorUserId ? "user" : "system"),
      body,
      bodyTruncated,
      presentation: deletedAt ? null : (safeRow.presentation ?? null),
      metadata: deletedAt ? null : (safeRow.metadata ?? null),
      deletedAt: deletedAt ? deletedAt.toISOString() : null,
      deletedByType: deletedAt ? (row.deletedByType ?? null) : null,
      deletedByAgentId: deletedAt ? (row.deletedByAgentId ?? null) : null,
      deletedByUserId: deletedAt ? (row.deletedByUserId ?? null) : null,
      deletedByRunId: deletedAt ? (row.deletedByRunId ?? null) : null,
      sourceTrust: row.sourceTrust ?? null,
      createdAt: row.createdAt.toISOString(),
      author: row.authorAgentId
        ? { type: "agent", id: row.authorAgentId }
        : row.authorUserId
          ? { type: "user", id: row.authorUserId }
          : { type: "system", id: null },
    });
  }

  const attachmentCommentIds = comments.flatMap((comment) =>
    typeof comment.id === "string" &&
    comment.deletedAt === null &&
    (input.exposeLowTrustRaw ||
      !isLowTrustQuarantined(comment.sourceTrust as SourceTrustMetadata | null))
      ? [comment.id]
      : [],
  );
  const attachmentRows =
    !issueId || attachmentCommentIds.length === 0
      ? []
      : await input.db
          .select({
            id: issueAttachments.id,
            issueCommentId: issueAttachments.issueCommentId,
            filename: assets.originalFilename,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
          })
          .from(issueAttachments)
          .innerJoin(
            assets,
            and(
              eq(issueAttachments.assetId, assets.id),
              eq(assets.companyId, input.companyId),
            ),
          )
          .where(
            and(
              eq(issueAttachments.companyId, input.companyId),
              eq(issueAttachments.issueId, issueId),
              inArray(issueAttachments.issueCommentId, attachmentCommentIds),
            ),
          )
          .orderBy(asc(issueAttachments.createdAt), asc(issueAttachments.id))
          .limit(MAX_INLINE_WAKE_ATTACHMENTS + 1);
  if (attachmentRows.length > MAX_INLINE_WAKE_ATTACHMENTS) truncated = true;
  const attachmentsByCommentId = new Map<
    string,
    Array<{
      id: string;
      filename: string;
      contentType: string;
      byteSize: number;
      contentPath: string;
    }>
  >();
  for (const attachment of attachmentRows.slice(
    0,
    MAX_INLINE_WAKE_ATTACHMENTS,
  )) {
    if (!attachment.issueCommentId) continue;
    const descriptors =
      attachmentsByCommentId.get(attachment.issueCommentId) ?? [];
    descriptors.push({
      id: attachment.id,
      filename: attachment.filename?.trim() || "attachment",
      contentType: attachment.contentType,
      byteSize: attachment.byteSize,
      contentPath: `/api/attachments/${attachment.id}/content`,
    });
    attachmentsByCommentId.set(attachment.issueCommentId, descriptors);
  }
  for (const comment of comments) {
    if (typeof comment.id !== "string") continue;
    const attachments = attachmentsByCommentId.get(comment.id);
    if (attachments?.length) comment.attachments = attachments;
  }

  const annotationDeltas =
    annotationCommentId && issueId
      ? await input.db
          .select({
            id: documentAnnotationComments.id,
            issueId: documentAnnotationComments.issueId,
            threadId: documentAnnotationComments.threadId,
            body: documentAnnotationComments.body,
            authorType: documentAnnotationComments.authorType,
            authorAgentId: documentAnnotationComments.authorAgentId,
            authorUserId: documentAnnotationComments.authorUserId,
            createdAt: documentAnnotationComments.createdAt,
            documentKey: documentAnnotationThreads.documentKey,
            status: documentAnnotationThreads.status,
            anchorState: documentAnnotationThreads.anchorState,
            anchorConfidence: documentAnnotationThreads.anchorConfidence,
            currentRevisionNumber:
              documentAnnotationThreads.currentRevisionNumber,
            selectedText: documentAnnotationThreads.selectedText,
            prefixText: documentAnnotationThreads.prefixText,
            suffixText: documentAnnotationThreads.suffixText,
          })
          .from(documentAnnotationComments)
          .innerJoin(
            documentAnnotationThreads,
            eq(
              documentAnnotationComments.threadId,
              documentAnnotationThreads.id,
            ),
          )
          .where(
            and(
              eq(documentAnnotationComments.companyId, input.companyId),
              eq(documentAnnotationComments.issueId, issueId),
              eq(documentAnnotationComments.id, annotationCommentId),
              eq(documentAnnotationThreads.companyId, input.companyId),
              eq(documentAnnotationThreads.issueId, issueId),
            ),
          )
          .then((rows) =>
            rows.map((row) => ({
              id: row.id,
              issueId: row.issueId,
              threadId: row.threadId,
              documentKey: row.documentKey,
              revisionNumber: row.currentRevisionNumber,
              quote: row.selectedText,
              prefix: row.prefixText,
              suffix: row.suffixText,
              threadStatus: row.status,
              anchorState: row.anchorState,
              anchorConfidence: row.anchorConfidence,
              body:
                row.body.length > MAX_INLINE_WAKE_COMMENT_BODY_CHARS
                  ? row.body.slice(0, MAX_INLINE_WAKE_COMMENT_BODY_CHARS)
                  : row.body,
              bodyTruncated:
                row.body.length > MAX_INLINE_WAKE_COMMENT_BODY_CHARS,
              createdAt: row.createdAt.toISOString(),
              author: row.authorAgentId
                ? { type: "agent", id: row.authorAgentId }
                : row.authorUserId
                  ? { type: "user", id: row.authorUserId }
                  : { type: row.authorType, id: null },
            })),
          )
      : [];
  const interactionId = readNonEmptyString(input.contextSnapshot.interactionId);
  const interactionKind = readNonEmptyString(
    input.contextSnapshot.interactionKind,
  );
  const interactionStatus = readNonEmptyString(
    input.contextSnapshot.interactionStatus,
  );
  const interactionContinuationSource = readNonEmptyString(
    input.contextSnapshot.source,
  );
  const externalInteractionContinuation =
    (interactionStatus === "answered" || interactionStatus === "accepted") &&
    (input.contextSnapshot.externalChatContinuation === true ||
      interactionContinuationSource === "external_chat.interaction.resolve");
  const checkboxSelection = parseObject(
    input.contextSnapshot.checkboxSelection,
  );
  // A resolved plan review is new user input, including in chat. Ordinary chat
  // wakes must still exclude historical plan context across /new boundaries.
  const resolvedPlanInteraction = interactionId && interactionKind === "request_confirmation" &&
    (interactionStatus === "accepted" || interactionStatus === "rejected");
  const planReviewContext = issueId && (!conversationMode || resolvedPlanInteraction)
    ? await buildPlanReviewContext({
        db: input.db,
        companyId: input.companyId,
        issueId,
        issueWorkMode: conversationMode ? null : issueSummary?.workMode ?? null,
        includeForIssueComment: !conversationMode && commentIds.length > 0,
        includeForAnnotationDelta: !conversationMode && annotationDeltas.length > 0,
        interactionId,
      })
    : null;
  const documentReviewContext = issueId && !conversationMode
    ? await buildDocumentReviewContext({
        db: input.db,
        companyId: input.companyId,
        issueId,
        includeForIssueComment: commentIds.length > 0,
        includeForAnnotationDelta: annotationDeltas.length > 0,
      })
    : null;
  const payloadTruncated =
    truncated ||
    issueDescriptionTruncated ||
    planReviewContext?.truncated === true ||
    documentReviewContext?.truncated === true;
  const recoveryActionId = readNonEmptyString(
    input.contextSnapshot.recoveryActionId,
  );
  const recoveryCause = readNonEmptyString(input.contextSnapshot.recoveryCause);
  const recoveryAction = recoveryActionId
    ? await input.db
        .select()
        .from(issueRecoveryActions)
        .where(
          and(
            eq(issueRecoveryActions.id, recoveryActionId),
            eq(issueRecoveryActions.companyId, input.companyId),
          ),
        )
        .then((rows) => rows[0] ?? null)
    : null;
  const recoveryEvidence = parseObject(recoveryAction?.evidence);
  // A restored task resumes its deliverable, not the completed repair. A
  // referenced settled/missing action must not fall back to a stale cause.
  const recoveryStillActive = recoveryAction
    ? ["active", "escalated"].includes(recoveryAction.status)
    : !recoveryActionId && Boolean(recoveryCause);
  const originalAssigneeId =
    recoveryAction?.returnOwnerAgentId ??
    recoveryAction?.previousOwnerAgentId ??
    null;
  const originalAssignee = originalAssigneeId
    ? await input.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(
          and(
            eq(agents.id, originalAssigneeId),
            eq(agents.companyId, input.companyId),
          ),
        )
        .then((rows) => rows[0] ?? null)
    : null;

  const externalChatProvider = await resolveExternalChatWakeProvider({
    db: input.db,
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId,
    issueId: issueSummary?.id === issueId ? issueId : null,
    contextSnapshot: input.contextSnapshot,
  });
  const attachmentOmissions = externalChatProvider
    ? readExternalAttachmentOmissions(
        input.contextSnapshot[EXTERNAL_ATTACHMENT_OMISSIONS_KEY],
      )
        .filter((omission) => commentIds.includes(omission.commentId))
        .map((omission) => ({
          commentId: omission.commentId,
          reasons: omission.reasons,
          notice: externalAttachmentOmissionNotice(omission),
        }))
    : [];
  const payload = {
    reason: readNonEmptyString(input.contextSnapshot.wakeReason),
    executionContinuation: input.contextSnapshot.executionContinuation ?? null,
    chatCompletionUpdates: input.contextSnapshot.chatCompletionUpdates ?? null,
    attachmentOmissions,
    externalChatProvider,
    recovery:
      recoveryStillActive
        ? {
            cause: recoveryAction?.cause ?? recoveryCause,
            failureSummary: readNonEmptyString(recoveryEvidence.failureSummary),
            originalAssignee: originalAssignee
              ? { id: originalAssignee.id, name: originalAssignee.name }
              : originalAssigneeId
                ? { id: originalAssigneeId, name: null }
                : null,
            attemptCount: recoveryAction?.attemptCount ?? null,
            maxAttempts: recoveryAction?.maxAttempts ?? null,
            nextAction: recoveryAction?.nextAction ?? null,
            routingFallbackReason: readNonEmptyString(
              recoveryEvidence.routingFallbackReason,
            ),
          }
        : null,
    issue: issueSummary
      ? {
          id: issueSummary.id,
          identifier: issueSummary.identifier,
          title: issueSummary.title,
          description: inlineIssueDescription,
          descriptionTruncated: issueDescriptionTruncated,
          status: issueSummary.status,
          priority: issueSummary.priority,
          workMode: issueSummary.workMode,
        }
      : null,
    agentMessage: agentMessageText
      ? {
          text: agentMessageText,
          source: readNonEmptyString(agentMessage.source),
          pluginKey: readNonEmptyString(agentMessage.pluginKey),
          sessionId: readNonEmptyString(agentMessage.sessionId),
          ...(Array.isArray(agentMessage.untrustedToolResults)
            ? {
                untrustedToolResults: agentMessage.untrustedToolResults
                  .slice(0, 8)
                  .map((value) => {
                    const result = parseObject(value);
                    return {
                      actionRequestId:
                        sanitizeAgentSessionMessageText(
                          result.actionRequestId,
                        ) ?? "",
                      toolName:
                        sanitizeAgentSessionMessageText(result.toolName) ?? "",
                      resultSummary:
                        sanitizeAgentSessionMessageText(result.resultSummary) ??
                        "",
                      error: sanitizeAgentSessionMessageText(result.error),
                      declineReason: sanitizeAgentSessionMessageText(
                        result.declineReason,
                      ),
                    };
                  }),
              }
            : {}),
        }
      : null,
    childIssueSummaries: Array.isArray(
      input.contextSnapshot.childIssueSummaries,
    )
      ? input.contextSnapshot.childIssueSummaries
      : [],
    childIssueSummaryTruncated:
      input.contextSnapshot.childIssueSummaryTruncated === true,
    dispositionRepair: input.contextSnapshot.legacyDispositionEpisode ? {
      attempt: input.contextSnapshot.dispositionRepairAttempt,
      maxAttempts: input.contextSnapshot.dispositionRepairMaxAttempts,
      sourceRunId: input.contextSnapshot.retryOfRunId,
      instruction: input.contextSnapshot.dispositionRepairInstruction,
    } : null,
    livenessContinuation:
      readNonEmptyString(input.contextSnapshot.livenessContinuationState) ||
      readNonEmptyString(
        input.contextSnapshot.livenessContinuationInstruction,
      ) ||
      readNonEmptyString(
        input.contextSnapshot.livenessContinuationSourceRunId,
      ) ||
      typeof input.contextSnapshot.livenessContinuationAttempt === "number"
        ? {
            attempt: input.contextSnapshot.livenessContinuationAttempt,
            maxAttempts: input.contextSnapshot.livenessContinuationMaxAttempts,
            sourceRunId: readNonEmptyString(
              input.contextSnapshot.livenessContinuationSourceRunId,
            ),
            state: readNonEmptyString(
              input.contextSnapshot.livenessContinuationState,
            ),
            reason: readNonEmptyString(
              input.contextSnapshot.livenessContinuationReason,
            ),
            instruction: readNonEmptyString(
              input.contextSnapshot.livenessContinuationInstruction,
            ),
          }
        : null,
    interactionKind,
    interactionStatus,
    interactionId,
    sourceRunId: readNonEmptyString(input.contextSnapshot.sourceRunId),
    externalChatQuestionResponse: externalChatProvider
      ? (input.contextSnapshot[EXTERNAL_CHAT_QUESTION_RESPONSE_KEY] ?? null)
      : null,
    externalInteractionContinuation,
    checkboxSelection:
      Object.keys(checkboxSelection).length > 0 ? checkboxSelection : null,
    checkedOutByHarness:
      input.contextSnapshot[PAPERCLIP_HARNESS_CHECKOUT_KEY] === true,
    externalChatExecutionBound:
      input.contextSnapshot[PAPERCLIP_EXTERNAL_CHAT_EXECUTION_BOUND_KEY] ===
      true,
    simplifiedEnglishInteractions: input.simplifiedEnglishInteractions === true,
    dependencyBlockedInteraction:
      input.contextSnapshot.dependencyBlockedInteraction === true,
    treeHoldInteraction: input.contextSnapshot.treeHoldInteraction === true,
    activeTreeHold: parseObject(input.contextSnapshot.activeTreeHold),
    unresolvedBlockerIssueIds: Array.isArray(
      input.contextSnapshot.unresolvedBlockerIssueIds,
    )
      ? input.contextSnapshot.unresolvedBlockerIssueIds.filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        )
      : [],
    unresolvedBlockerSummaries: Array.isArray(
      input.contextSnapshot.unresolvedBlockerSummaries,
    )
      ? input.contextSnapshot.unresolvedBlockerSummaries
      : [],
    executionStage:
      Object.keys(executionStage).length > 0 ? executionStage : null,
    taskWatchdog: (input.contextSnapshot.taskWatchdog ?? null) as unknown,
    skillTest: (input.contextSnapshot.paperclipSkillTest ?? null) as unknown,
    continuationSummary: safeContinuationSummary
      ? {
          key: safeContinuationSummary.key,
          title: safeContinuationSummary.title,
          body:
            safeContinuationSummary.body.length > 4_000
              ? safeContinuationSummary.body.slice(0, 4_000)
              : safeContinuationSummary.body,
          bodyTruncated: safeContinuationSummary.body.length > 4_000,
          sourceTrust: safeContinuationSummary.sourceTrust ?? null,
          updatedAt: safeContinuationSummary.updatedAt.toISOString(),
        }
      : null,
    commentIds,
    latestCommentId: commentIds[commentIds.length - 1] ?? null,
    comments,
    annotationDeltas,
    planReviewContext,
    documentReviewContext,
    commentWindow: {
      requestedCount: commentIds.length,
      includedCount: comments.length,
      missingCount: missingCommentCount,
    },
    truncated: payloadTruncated,
    fallbackFetchNeeded: payloadTruncated || missingCommentCount > 0,
  };
  return issueId
    ? createRunSecretRedactionRegistry(input.db).redactForIssue(
        input.companyId,
        issueId,
        payload,
      )
    : payload;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Issue context and responsible-user resolution bound to one service database. */
export function createHeartbeatRunPreparation(db: Db) {
  function toAgentOrgRow(
    agent: Pick<
      typeof agents.$inferSelect,
      "id" | "companyId" | "name" | "reportsTo" | "status"
    >,
  ): AgentOrgRow {
    return {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name,
      reportsTo: agent.reportsTo,
      status: agent.status,
    };
  }

  async function listCompanyAgentOrgRows(
    companyId: string,
  ): Promise<AgentOrgRow[]> {
    return db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        reportsTo: agents.reportsTo,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));
  }

  function groupAgentOrgRowsByCompany(agentRows: AgentOrgRow[]) {
    const byCompany = new Map<string, AgentOrgRow[]>();
    for (const agent of agentRows) {
      const companyAgents = byCompany.get(agent.companyId);
      if (companyAgents) {
        companyAgents.push(agent);
      } else {
        byCompany.set(agent.companyId, [agent]);
      }
    }
    return byCompany;
  }

  async function getIssueExecutionContext(companyId: string, issueId: string) {
    return db
      .select({
        chatCommunicationGuidance: chatConversations.communicationGuidance,
        chatAssignedAgentId: chatEndpoints.assignedAgentId,
        chatProvider: chatEndpoints.provider,
        // Select only the public command, never the rest of setup state.
        chatSlackCommand: sql<string | null>`case when ${chatEndpoints.provider} = 'slack' and ${chatEndpoints.status} in ('active', 'verifying') then ${chatEndpoints.setup}->>'command' end`,
        externalConversationState: externalConversationStateSql(),
        conversationAgentId: issues.conversationAgentId,
        conversationUserId: issues.conversationUserId,
        conversationState: issues.conversationState,
        conversationSessionGeneration: issues.conversationSessionGeneration,
        conversationBoundaryCommentId: issues.conversationBoundaryCommentId,
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        titleNeedsGeneration: issues.titleNeedsGeneration,
        description: issues.description,
        status: issues.status,
        workMode: issues.workMode,
        reviewPolicy: issues.reviewPolicy,
        priority: issues.priority,
        projectId: issues.projectId,
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
        parentId: issues.parentId,
        createdByUserId: issues.createdByUserId,
        responsibleUserId: issues.responsibleUserId,
        originKind: issues.originKind,
        originId: issues.originId,
        originRunId: issues.originRunId,
        originIdentityContextId: issues.originIdentityContextId,
        continuationIdentityContextId: issues.continuationIdentityContextId,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .leftJoin(chatConversations, and(
        eq(chatConversations.companyId, issues.companyId),
        eq(chatConversations.issueId, issues.id),
      ))
      .leftJoin(chatEndpoints, and(
        eq(chatEndpoints.companyId, chatConversations.companyId),
        eq(chatEndpoints.id, chatConversations.endpointId),
      ))
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
  }

  async function getPinnedSkillTestContext(companyId: string, issueId: string) {
    const row = await db
      .select({
        testRunId: companySkillTestRuns.id,
        skillId: companySkillTestRuns.skillId,
        inputId: companySkillTestRuns.inputId,
        skillVersionId: companySkillTestRuns.skillVersionId,
        outputDocumentKey: companySkillTestRuns.outputDocumentKey,
        fileInventory: companySkillVersions.fileInventory,
        revisionNumber: companySkillVersions.revisionNumber,
        label: companySkillVersions.label,
      })
      .from(companySkillTestRuns)
      .innerJoin(
        companySkillVersions,
        and(
          eq(companySkillVersions.id, companySkillTestRuns.skillVersionId),
          eq(companySkillVersions.companyId, companySkillTestRuns.companyId),
        ),
      )
      .where(
        and(
          eq(companySkillTestRuns.companyId, companyId),
          eq(companySkillTestRuns.issueId, issueId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const fileInventory = Array.isArray(row.fileInventory)
      ? row.fileInventory.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry))
            return [];
          const record = entry as unknown as Record<string, unknown>;
          const path = typeof record.path === "string" ? record.path : "";
          if (!path) return [];
          return [
            {
              path,
              kind: typeof record.kind === "string" ? record.kind : "other",
              content: typeof record.content === "string" ? record.content : "",
            },
          ];
        })
      : [];
    return {
      testRunId: row.testRunId,
      skillId: row.skillId,
      inputId: row.inputId ?? null,
      skillVersionId: row.skillVersionId,
      revisionNumber: row.revisionNumber,
      label: row.label ?? null,
      outputDocumentKey: row.outputDocumentKey,
      fileInventory,
    };
  }

  async function getRoutineEnvForExecutionIssue(
    companyId: string,
    issueContext: { originKind: string | null; originId: string | null; originRunId: string | null } | null,
  ) {
    if (
      !issueContext ||
      issueContext.originKind !== "routine_execution" ||
      !issueContext.originId
    ) {
      return { routineId: null, env: null, responsibleUserId: null };
    }

    const routineRun = issueContext.originRunId
      ? await db
          .select({
            routineRevisionId: routineRuns.routineRevisionId,
            responsibleUserId: routineRuns.responsibleUserId,
          })
          .from(routineRuns)
          .where(
            and(
              eq(routineRuns.id, issueContext.originRunId),
              eq(routineRuns.companyId, companyId),
              eq(routineRuns.routineId, issueContext.originId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;

    if (routineRun?.routineRevisionId) {
      const revision = await db
        .select({
          snapshot: routineRevisions.snapshot,
          responsibleUserId: routineRevisions.responsibleUserId,
        })
        .from(routineRevisions)
        .where(
          and(
            eq(routineRevisions.id, routineRun.routineRevisionId),
            eq(routineRevisions.companyId, companyId),
            eq(routineRevisions.routineId, issueContext.originId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const snapshot = revision?.snapshot as
        RoutineRevisionSnapshotV1 | undefined;
      if (snapshot?.version === 1) {
        return {
          routineId: issueContext.originId,
          env: snapshot.routine.env ?? null,
          responsibleUserId:
            routineRun?.responsibleUserId ??
            revision?.responsibleUserId ??
            snapshot.routine.responsibleUserId ??
            null,
        };
      }
    }

    const routine = await db
      .select({
        env: routines.env,
        responsibleUserId: routines.responsibleUserId,
      })
      .from(routines)
      .where(
        and(
          eq(routines.id, issueContext.originId),
          eq(routines.companyId, companyId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return {
      routineId: issueContext.originId,
      env: routine?.env ?? null,
      responsibleUserId:
        routineRun?.responsibleUserId ?? routine?.responsibleUserId ?? null,
    };
  }

  async function resolveCompanyDefaultResponsibleUserId(companyId: string) {
    const company = await db
      .select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    const explicitDefault = readNonEmptyString(
      company?.defaultResponsibleUserId,
    );
    if (explicitDefault) return explicitDefault;

    const owner = await db
      .select({ userId: companyMemberships.principalId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
          eq(companyMemberships.membershipRole, "owner"),
        ),
      )
      .orderBy(asc(companyMemberships.createdAt), asc(companyMemberships.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (owner?.userId) return owner.userId;

    const firstUser = await db
      .select({ userId: companyMemberships.principalId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      )
      .orderBy(asc(companyMemberships.createdAt), asc(companyMemberships.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return firstUser?.userId ?? null;
  }

  async function resolveParentIssueResponsibleUserId(
    companyId: string,
    parentId: string | null | undefined,
  ) {
    if (!parentId) return null;
    const parent = await db
      .select({
        responsibleUserId: issues.responsibleUserId,
        createdByUserId: issues.createdByUserId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, parentId)))
      .then((rows) => rows[0] ?? null);
    return parent?.responsibleUserId ?? null;
  }

  function isManualUserRun(input: {
    contextSnapshot: Record<string, unknown>;
    requestedByActorType?: "user" | "agent" | "system" | null;
    source?: WakeupOptions["source"] | null;
    triggerDetail?: WakeupOptions["triggerDetail"] | null;
  }) {
    if (input.requestedByActorType !== "user") return false;
    const wakeReason = readNonEmptyString(input.contextSnapshot.wakeReason);
    if (wakeReason && ISSUE_RESPONSIBLE_USER_WAKE_REASONS.has(wakeReason))
      return false;
    return input.source === "on_demand" || input.triggerDetail === "manual";
  }

  async function resolveResponsibleUserIdForRunSeed(input: {
    companyId: string;
    contextSnapshot: Record<string, unknown>;
    issueContext: { id: string; responsibleUserId: string | null; parentId: string | null } | null;
    routineEnvContext: Awaited<
      ReturnType<typeof getRoutineEnvForExecutionIssue>
    >;
    requestedByActorType?: "user" | "agent" | "system" | null;
    requestedByActorId?: string | null;
    source?: WakeupOptions["source"] | null;
    triggerDetail?: WakeupOptions["triggerDetail"] | null;
    existingRunResponsibleUserId?: string | null;
  }) {
    const contextResponsibleUserId = readNonEmptyString(
      input.contextSnapshot.responsibleUserId,
    );
    const requestedUserId =
      input.requestedByActorType === "user"
        ? readNonEmptyString(input.requestedByActorId)
        : null;
    const messageIds = Array.isArray(input.contextSnapshot.wakeCommentIds)
      ? input.contextSnapshot.wakeCommentIds.filter(
          (id): id is string => typeof id === "string",
        )
      : readNonEmptyString(input.contextSnapshot.wakeCommentId)
        ? [String(input.contextSnapshot.wakeCommentId)]
        : [];
    if (
      input.issueContext &&
      messageIds.length &&
      !input.contextSnapshot.retryOfRunId
    ) {
      const messages = await db
        .select({
          id: issueComments.id,
          authorUserId: issueComments.authorUserId,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, input.companyId),
            eq(issueComments.issueId, input.issueContext.id),
            inArray(issueComments.id, messageIds),
          ),
        );
      for (const id of [...messageIds].reverse()) {
        const author = messages.find(
          (message) => message.id === id,
        )?.authorUserId;
        if (author) {
          delete input.contextSnapshot.executionIdentityCause;
          return author;
        }
      }
    }
    const retryOfRunId = readNonEmptyString(input.contextSnapshot.retryOfRunId);
    if (retryOfRunId) {
      const [origin] = await db
        .select({ responsibleUserId: heartbeatRuns.responsibleUserId })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, input.companyId),
            eq(heartbeatRuns.id, retryOfRunId),
          ),
        );
      if (origin?.responsibleUserId) return origin.responsibleUserId;
    }
    if (contextResponsibleUserId) return contextResponsibleUserId;
    if (input.existingRunResponsibleUserId)
      return input.existingRunResponsibleUserId;
    if (input.routineEnvContext.responsibleUserId)
      return input.routineEnvContext.responsibleUserId;
    if (isManualUserRun(input) && requestedUserId) return requestedUserId;
    if (input.issueContext?.responsibleUserId)
      return input.issueContext.responsibleUserId;
    const parentResponsibleUserId = await resolveParentIssueResponsibleUserId(
      input.companyId,
      input.issueContext?.parentId,
    );
    if (parentResponsibleUserId) return parentResponsibleUserId;
    if (!input.issueContext && requestedUserId) return requestedUserId;
    input.contextSnapshot.executionIdentityCause = "company_default";
    return resolveCompanyDefaultResponsibleUserId(input.companyId);
  }

  async function resolveResponsibleUserIdForRun(input: {
    run: typeof heartbeatRuns.$inferSelect;
    contextSnapshot: Record<string, unknown>;
    issueContext: Awaited<ReturnType<typeof getIssueExecutionContext>> | null;
    routineEnvContext: Awaited<
      ReturnType<typeof getRoutineEnvForExecutionIssue>
    >;
  }) {
    const operatorIdentity = await explicitOperatorRunIdentity(db, input.run);
    const responsibleUserId = operatorIdentity?.actorId ?? await resolveResponsibleUserIdForRunSeed({
      companyId: input.run.companyId,
      contextSnapshot: input.contextSnapshot,
      issueContext: input.issueContext,
      routineEnvContext: input.routineEnvContext,
      existingRunResponsibleUserId: input.run.responsibleUserId,
      source: input.run.invocationSource as WakeupOptions["source"],
      triggerDetail: input.run.triggerDetail as WakeupOptions["triggerDetail"],
    });
    if (!responsibleUserId) {
      throw new HttpError(
        422,
        "Unable to resolve responsible user for heartbeat run dispatch",
        {
          code: "responsible_user_unresolved",
          runId: input.run.id,
          agentId: input.run.agentId,
          companyId: input.run.companyId,
          issueId: input.issueContext?.id ?? null,
          invocationSource: input.run.invocationSource,
          triggerDetail: input.run.triggerDetail,
          wakeReason: readNonEmptyString(input.contextSnapshot.wakeReason),
        },
      );
    }
    return responsibleUserId;
  }

  async function resolveResponsibleUserIdForRunContext(
    run: typeof heartbeatRuns.$inferSelect,
    contextSnapshot: Record<string, unknown>,
  ) {
    const issueId =
      readNonEmptyString(contextSnapshot.issueId) ??
      readNonEmptyString(contextSnapshot.taskId);
    const issueContext = issueId
      ? await getIssueExecutionContext(run.companyId, issueId)
      : null;
    return resolveResponsibleUserIdForRun({
      run,
      contextSnapshot,
      issueContext,
      routineEnvContext: await getRoutineEnvForExecutionIssue(
        run.companyId,
        issueContext,
      ),
    });
  }

  return {
    toAgentOrgRow,
    listCompanyAgentOrgRows,
    groupAgentOrgRowsByCompany,
    getIssueExecutionContext,
    getPinnedSkillTestContext,
    getRoutineEnvForExecutionIssue,
    resolveResponsibleUserIdForRunSeed,
    resolveResponsibleUserIdForRun,
    resolveResponsibleUserIdForRunContext,
  };
}
