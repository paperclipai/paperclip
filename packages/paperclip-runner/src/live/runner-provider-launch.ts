import { createHash } from "node:crypto";
import { parseNativeRuntimeContext, retargetNativeSystemInstructions } from "../contracts/runtime-context.js";
import { resolve } from "node:path";
import { codexExecutableReadOnlyRoots } from "../drivers/codex/codex-security-config.js";
import { createIsolatedCodexAppServerArgs } from "../drivers/codex/codex-app-server-driver.js";
import { validatePreparedLaunchWorkingDirectory } from "../drivers/codex/codex-boundaries.js";
import { usesPreconfiguredHome } from "../drivers/preconfigured-home.js";
import { resolveQualifiedAcpxProfile } from "../drivers/acpx/qualified-profiles.js";
import { resolveAcpxProviderMode } from "../drivers/acpx/provider-mode.js";
import type { DurableRecoveryIdentity } from "../contracts/durable-recovery.js";
import type { NativeRuntimeContextSnapshot } from "../contracts/runtime-context.js";
import type { CapabilityRunnerdCodexTransportOptions } from "./runnerd-codex-transport.js";

// Environment plugins may advertise managed GitHub commands only with the
// matching Runner source that preserves helper selectors through Claude ACPX.
export const RUNNER_GITHUB_LAUNCHER_VERSION = 1;

/** Core's provider inputs. Executable paths and filesystem layout are supplied separately. */
export interface RunnerProviderLaunchRequirements {
  schema: "paperclip.runner.launch-requirements.v1";
  identity: DurableRecoveryIdentity;
  provider: NonNullable<CapabilityRunnerdCodexTransportOptions["provider"]>;
  model: string | null;
  approvalPolicy: "never" | "on-request" | "untrusted";
  readOnly: boolean;
  preparedConversation: boolean;
  includeCollaborationModeInstructions: boolean;
  settings: Pick<CapabilityRunnerdCodexTransportOptions,
    "acpxAgent" | "acpxMode" | "acpxPermissionMode" | "acpxPermissionModePinned" |
    "piThinkingLevel" | "claudeEffort" | "grokEffort" | "grokDisableWebSearch" | "managedProfile" | "agentCoreProfile" | "opencodePermissionMode" | "disableCodexWebSearch" | "disableCodexProjectInstructions">;
  instructions: string;
  runtimeContext: NativeRuntimeContextSnapshot | null;
}

/** A prepared descriptor belongs to one exact request and contains no launch secrets. */
export interface PreparedRunnerProviderLaunch {
  configurationId: string;
  requirementsDigest: string;
  provider: Record<string, unknown>;
}

export type RunnerLaunchPreparer = (
  requirements: RunnerProviderLaunchRequirements,
  recovery?: PreparedRunnerProviderLaunch,
) => Promise<PreparedRunnerProviderLaunch>;

export function runnerProviderLaunchRequirements(
  options: CapabilityRunnerdCodexTransportOptions,
  identity: DurableRecoveryIdentity,
  params: Record<string, unknown>,
  runtimeContext: NativeRuntimeContextSnapshot | null,
  instructions: string,
): RunnerProviderLaunchRequirements {
  const requirements: RunnerProviderLaunchRequirements = {
    schema: "paperclip.runner.launch-requirements.v1",
    identity, provider: options.provider ?? "codex",
    model: typeof params.model === "string" ? params.model : null,
    instructions, runtimeContext,
    settings: {
      acpxAgent: options.acpxAgent, acpxMode: options.acpxMode,
      acpxPermissionMode: options.acpxPermissionMode,
      acpxPermissionModePinned: options.acpxPermissionModePinned,
      piThinkingLevel: options.piThinkingLevel, claudeEffort: options.claudeEffort, grokEffort: options.grokEffort, grokDisableWebSearch: options.grokDisableWebSearch,
      managedProfile: options.managedProfile, agentCoreProfile: options.agentCoreProfile,
      opencodePermissionMode: options.opencodePermissionMode,
      ...(options.disableCodexWebSearch === true ? { disableCodexWebSearch: true } : {}),
      ...(options.disableCodexProjectInstructions === true ? { disableCodexProjectInstructions: true } : {}),
    },
    approvalPolicy: params.approvalPolicy === "on-request" || params.approvalPolicy === "untrusted"
      ? params.approvalPolicy : "never",
    readOnly: params.permissions === "paperclip-runner-workspace-read-only",
    preparedConversation: params.conversationMode === "prepared",
    includeCollaborationModeInstructions: (params.config as Record<string, unknown> | undefined)?.include_collaboration_mode_instructions !== false,
  };
  // PRP hashes strict JSON; absent settings must not remain undefined properties.
  return JSON.parse(JSON.stringify(requirements)) as RunnerProviderLaunchRequirements;
}

/** Resolve assigned resource locations without changing their policy or content identities. */
export function bindRunnerLaunchResources(
  requirements: RunnerProviderLaunchRequirements,
  context: NativeRuntimeContextSnapshot,
): RunnerProviderLaunchRequirements {
  const source = requirements.runtimeContext;
  const target = parseNativeRuntimeContext(context);
  if (!source || target.aggregateDigest !== source.aggregateDigest
    || target.mcp.bindingId !== source.mcp.bindingId) {
    throw new Error("runner_launch_resource_assignment_changed");
  }
  return { ...requirements,
    instructions: retargetNativeSystemInstructions(requirements.instructions, source, target),
    runtimeContext: target,
  };
}

export function runnerLaunchRequirementsDigest(requirements: RunnerProviderLaunchRequirements): string {
  const canonical = JSON.stringify(requirements, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** The environment may resolve paths, but it cannot change Core's selected policy. */
export function validatePreparedRunnerLaunch(
  requirements: RunnerProviderLaunchRequirements,
  prepared: PreparedRunnerProviderLaunch,
): void {
  const reject = () => { throw new Error("runner_prepared_launch_requirements_mismatch"); };
  if (!prepared || typeof prepared.configurationId !== "string" || !prepared.configurationId.trim()
    || prepared.configurationId.length > 1024
    || prepared.requirementsDigest !== runnerLaunchRequirementsDigest(requirements)
    || !prepared.provider || typeof prepared.provider !== "object") reject();
  const descriptor = prepared.provider;
  if (!requirements.runtimeContext && descriptor.runtimeContext != null) reject();
  if (descriptor.kind !== requirements.provider || descriptor.model !== requirements.model) reject();
  if (requirements.provider === "codex" && (descriptor.approvalPolicy !== requirements.approvalPolicy
    || Boolean(descriptor.readOnly) !== requirements.readOnly)) reject();
  if (requirements.provider === "codex" && (requirements.settings.disableCodexWebSearch === true
    || requirements.settings.disableCodexProjectInstructions === true)) {
    if (!Array.isArray(descriptor.args) || descriptor.args.some(arg => typeof arg !== "string")) reject();
    const args = descriptor.args as string[];
    const commandIndex = args.indexOf("app-server");
    const boundary = commandIndex < 0 ? args.length : commandIndex;
    const policy = [
      ...(requirements.settings.disableCodexProjectInstructions ? ["-c", "project_doc_max_bytes=0"] : []),
      ...(requirements.settings.disableCodexWebSearch ? ["-c", 'web_search="disabled"'] : []),
    ];
    if (args.some(arg => arg === "--" || (requirements.settings.disableCodexWebSearch
      && (arg === "--search" || arg.startsWith("--search=")))) || (commandIndex >= 0 && commandIndex !== args.length - 1)
      || JSON.stringify(args.slice(boundary - policy.length, boundary)) !== JSON.stringify(policy)) reject();
  }
  if (requirements.provider === "acpx") {
    const policy = descriptor.providerPolicy as Record<string, unknown> | undefined;
    if (descriptor.agent !== (requirements.settings.acpxAgent ?? "codex")
      || descriptor.grokDisableWebSearch !== requirements.settings.grokDisableWebSearch
      || descriptor.permissionMode !== resolveRunnerdAcpxPermissionMode(requirements.settings.acpxPermissionMode)
      || policy?.readOnly !== requirements.readOnly
      || descriptor.runId !== requirements.identity.runId
      || descriptor.normalizedSessionId !== requirements.identity.normalizedSessionId) reject();
  }
  const expected = createRunnerProviderLaunch(requirements, {
    options: { codexArgs: [] }, root: "/", cwd: "/", codexHome: "/",
    providerNodeCommand: "", opencodeProxyPath: "", acpxSidecarPath: "", codexCommand: "",
  });
  const hostFields = new Set(["command", "args", "sidecarCommand", "sidecarArgs", "runtimeDirectory", "cwd",
    "preconfiguredHome", "externallySandboxed", "runtimeContext", "instructions"]);
  for (const [key, value] of Object.entries(expected)) {
    if (!hostFields.has(key) && JSON.stringify(value) !== JSON.stringify(descriptor[key])) reject();
  }
  if ("cwd" in expected) {
    try { validatePreparedLaunchWorkingDirectory(descriptor.cwd); }
    catch { throw new Error("runner_prepared_launch_working_directory_invalid"); }
  }
  let requiredInstructions = requirements.instructions;
  if (requirements.runtimeContext) {
    const context = parseNativeRuntimeContext(descriptor.runtimeContext);
    if (context.aggregateDigest !== requirements.runtimeContext.aggregateDigest
      || context.mcp.bindingId !== requirements.runtimeContext.mcp.bindingId) reject();
    requiredInstructions = retargetNativeSystemInstructions(requiredInstructions, requirements.runtimeContext, context);
  }
  if (requiredInstructions.trim()
    && (typeof descriptor.instructions !== "string" || !descriptor.instructions.includes(requiredInstructions.trim()))) reject();
}

/**
 * The directory that the environment resolved for the provider. Core records
 * it for session metadata and recovery; runnerd checks it on its filesystem.
 * Providers without a filesystem working directory return null.
 */
export function preparedRunnerLaunchWorkingDirectory(
  prepared: Pick<PreparedRunnerProviderLaunch, "provider">,
): string | null {
  return prepared.provider.cwd === undefined
    ? null : validatePreparedLaunchWorkingDirectory(prepared.provider.cwd);
}

/** Locations and provider settings resolved by the built-in execution environment. */
export interface RunnerProviderLaunchEnvironment {
  options: Pick<CapabilityRunnerdCodexTransportOptions,
    "acpxRuntimeDirectory" | "homeMode" | "environment" | "codexArgs" |
    "runnerFilesystemRoot" | "disableCodexProjectInstructions" | "externallySandboxed">;
  root: string;
  cwd: string;
  codexHome: string;
  providerNodeCommand: string;
  codexCommand?: string;
  opencodeProxyPath: string;
  acpxSidecarPath: string;
}

export function createRunnerProviderLaunch(
  requirements: RunnerProviderLaunchRequirements,
  input: RunnerProviderLaunchEnvironment,
): Record<string, unknown> {
  const { identity, instructions: baseInstructions, runtimeContext, settings, provider } = requirements;
  const acpxAgent = provider === "acpx" ? settings.acpxAgent ?? "codex" : null;
  const requestedModel = requirements.model ?? "";
  const includeCodexCollaborationInstructions = provider === "codex" &&
    requirements.includeCollaborationModeInstructions;
  const { codexHome, providerNodeCommand, codexCommand: effectiveCodexCommand,
    opencodeProxyPath, acpxSidecarPath } = input;
  const acpxProfile =
    provider === "acpx"
      ? resolveQualifiedAcpxProfile(acpxAgent!, requestedModel)
      : null;
  const managedProfile = settings.managedProfile;
  const agentCoreProfile = settings.agentCoreProfile;
  if (provider === "claude_managed") {
    if (!managedProfile) {
      throw new Error(
        "Claude Managed runner transport requires a qualified managed profile",
      );
    }
    if (requestedModel !== managedProfile.model) {
      throw new Error(
        "Claude Managed requested model does not match its qualified profile",
      );
    }
  }
  if (provider === "aws_agentcore") {
    if (!agentCoreProfile) {
      throw new Error(
        "AWS AgentCore runner transport requires a qualified AgentCore profile",
      );
    }
    if (requestedModel !== agentCoreProfile.model) {
      throw new Error(
        "AWS AgentCore requested model does not match its qualified profile",
      );
    }
  }
  const selectedAcpxMode = provider === "acpx"
    ? resolveAcpxProviderMode(acpxProfile!.agent, settings.acpxMode) : undefined;
  return provider === "acpx"
          ? {
              kind: "acpx",
              provider: "acpx",
              driver: "acpx_runtime",
              providerVersion: acpxProfile!.acpxVersion,
              agent: acpxProfile!.agent,
              model: requestedModel,
              acpxVersion: acpxProfile!.acpxVersion,
              agentServerPackage: acpxProfile!.agentServerPackage,
              agentServerVersion: acpxProfile!.agentServerVersion,
              agentRuntimePackage: acpxProfile!.agentRuntimePackage,
              agentRuntimeVersion: acpxProfile!.agentRuntimeVersion,
              commandDigest: acpxProfile!.commandDigest,
              sidecarCommand: providerNodeCommand,
              sidecarArgs: [acpxSidecarPath],
              runtimeDirectory:
                input.options.acpxRuntimeDirectory ??
                resolve(input.root, "acpx"),
              normalizedSessionId: identity.normalizedSessionId,
              runId: identity.runId,
              cwd: input.cwd,
              instructions: baseInstructions,
              providerPolicy: { readOnly: requirements.readOnly },
              ...(selectedAcpxMode === undefined ? {} : { mode: selectedAcpxMode }),
              ...(acpxProfile!.agent === "pi" ? { piThinkingLevel: settings.piThinkingLevel } : {}),
              ...(acpxProfile!.agent === "claude" && settings.claudeEffort ? { claudeEffort: settings.claudeEffort } : {}),
              ...(acpxProfile!.agent === "grok" && settings.grokEffort ? { grokEffort: settings.grokEffort } : {}),
              ...(acpxProfile!.agent === "grok" && settings.grokDisableWebSearch !== undefined ? { grokDisableWebSearch: settings.grokDisableWebSearch } : {}),
              permissionMode: resolveRunnerdAcpxPermissionMode(
                settings.acpxPermissionMode,
              ),
              permissionModePinned:
                settings.acpxPermissionModePinned ?? true,
              runtimeContext,
            }
          : provider === "claude_managed"
            ? {
                kind: "claude_managed",
                model: managedProfile!.model,
                profileId: managedProfile!.profileId,
                anthropicAgentId: managedProfile!.anthropicAgentId,
                agentVersion: managedProfile!.agentVersion,
                environmentId: managedProfile!.environmentId,
                betaVersion: managedProfile!.betaVersion,
                maxSessionListCostUsd: managedProfile!.maxSessionListCostUsd,
                instructions: baseInstructions,
                runtimeContext,
              }
            : provider === "aws_agentcore"
              ? {
                  kind: "aws_agentcore",
                  model: agentCoreProfile!.model,
                  profileId: agentCoreProfile!.profileId,
                  region: agentCoreProfile!.region,
                  accountId: agentCoreProfile!.accountId,
                  harnessArn: agentCoreProfile!.harnessArn,
                  harnessVersion: agentCoreProfile!.harnessVersion,
                  endpointArn: agentCoreProfile!.endpointArn,
                  endpointQualifier: agentCoreProfile!.endpointQualifier,
                  agentRuntimeArn: agentCoreProfile!.agentRuntimeArn,
                  memoryArn: agentCoreProfile!.memoryArn,
                  memoryId: agentCoreProfile!.memoryId,
                  invocationRoleArn: agentCoreProfile!.invocationRoleArn,
                  contextBucket: agentCoreProfile!.contextBucket,
                  contextPrefix: agentCoreProfile!.contextPrefix,
                  contextKmsKeyArn: agentCoreProfile!.contextKmsKeyArn,
                  qualificationRevision:
                    agentCoreProfile!.qualificationRevision,
                  eventExpiryDays: agentCoreProfile!.eventExpiryDays,
                  maxEstimatedSessionCostUsd:
                    agentCoreProfile!.maxEstimatedSessionCostUsd,
                  maxIterations: agentCoreProfile!.maxIterations,
                  maxOutputTokens: agentCoreProfile!.maxOutputTokens,
                  timeoutSeconds: agentCoreProfile!.timeoutSeconds,
                  instructions: baseInstructions,
                  runtimeContext,
                }
              : {
                  kind: provider,
                  provider,
                  ...(input.options.homeMode === "preconfigured" ? { preconfiguredHome: { HOME: input.options.environment!.HOME, CODEX_HOME: codexHome } } : {}),
                  driver:
                    provider === "opencode"
                      ? "opencode_server"
                      : "codex_app_server",
                  providerVersion:
                    provider === "opencode" ? "1.18.34" : "codex-app-server-v1",
                  command:
                    provider === "opencode"
                      ? providerNodeCommand
                      : effectiveCodexCommand!,
                  args:
                    provider === "opencode"
                      ? [opencodeProxyPath]
                      : createRunnerdCodexAppServerArgs({
                          args: input.options.codexArgs,
                          disableWebSearch: settings.disableCodexWebSearch,
                          environment: input.options.environment,
                          codexHome,
                          workingDirectory: input.cwd,
                          runtimeStateRoot: input.options.runnerFilesystemRoot ?? input.root,
                          codexCommand: effectiveCodexCommand,
                          instructionWorkingCopyRoot: runtimeContext?.instructions.workingCopy?.rootPath,
                          disableProjectInstructions: settings.disableCodexProjectInstructions ?? input.options.disableCodexProjectInstructions,
                          readOnlyRoots: [
                            ...trustedRuntimeReadOnlyRoots(
                              input.options.environment,
                            ),
                            ...(runtimeContext
                              ? [
                                  resolve(codexHome, "skills"),
                                  runtimeContext.instructions.bundle.rootPath,
                                  ...runtimeContext.skills.map(
                                    (skill) => skill.bundle.rootPath,
                                  ),
                                ]
                              : []),
                          ],
                        }),
                  cwd: input.cwd,
                  model: requirements.model,
                  approvalPolicy:
                    requirements.approvalPolicy,
                  externallySandboxed:
                    provider === "codex" &&
                    input.options.externallySandboxed === true,
                  ...(provider === "codex" && requirements.readOnly ? { readOnly: true } : {}),
                  instructions:
                    provider === "codex"
                      ? withCodexCollaborationRuntimeInstructions(
                          baseInstructions,
                          includeCodexCollaborationInstructions,
                        )
                      : baseInstructions,
                  collaborationMode:
                    requirements.readOnly
                      ? "plan"
                      : "default",
                  ...(requirements.preparedConversation
                    ? { conversationMode: "prepared" }
                    : {}),
                  includeCollaborationModeInstructions:
                    includeCodexCollaborationInstructions,
                  ...(provider === "codex"
                    ? { includeSkillInstructions: runtimeContext !== null }
                    : {}),
                  runtimeContext,
                };
}

const CODEX_COLLABORATION_RUNTIME_INSTRUCTIONS = `## Codex-style collaboration

- Before the first tool call in a turn, send a brief commentary update describing the immediate work you are starting.
- During tool-driven work, send concise commentary updates at meaningful transitions so the user can follow progress without opening raw logs.
- Reserve \`report_progress\` for meaningful durable milestones on longer work. Do not call it merely to create a completion comment on a short run; Paperclip materializes the final assistant response as the durable completion comment.
- Invoke the semantic completion tool exactly once before the final assistant response. After it succeeds, send one self-contained final response with the outcome and verification, then do not call another tool. The completion tool records task disposition; Paperclip keeps receiving your answer until the provider turn ends.`;

export function withCodexCollaborationRuntimeInstructions(
  instructions: string,
  enabled = true,
): string {
  if (!enabled) return instructions;
  const base = instructions.trimEnd();
  return `${base}\n\n${CODEX_COLLABORATION_RUNTIME_INSTRUCTIONS}`;
}

export function resolveRunnerdAcpxPermissionMode(
  configured: CapabilityRunnerdCodexTransportOptions["acpxPermissionMode"],
): NonNullable<CapabilityRunnerdCodexTransportOptions["acpxPermissionMode"]> {
  return configured ?? "approve-all";
}

export function trustedRuntimeReadOnlyRoots(
  environment: NodeJS.ProcessEnv | undefined,
): string[] {
  const path = environment?.PATH ?? "";
  const roots = new Set<string>();
  for (const entry of path.split(process.platform === "win32" ? ";" : ":")) {
    if (entry === "/opt/homebrew" || entry.startsWith("/opt/homebrew/")) {
      roots.add("/opt/homebrew");
    } else if (entry === "/usr/local" || entry.startsWith("/usr/local/")) {
      roots.add("/usr/local");
    } else if (entry === "/opt/local" || entry.startsWith("/opt/local/")) {
      roots.add("/opt/local");
    } else if (entry === "/nix/store" || entry.startsWith("/nix/store/")) {
      roots.add("/nix/store");
    }
  }
  return [...roots];
}

export function createRunnerdCodexAppServerArgs(input: {
  environment: NodeJS.ProcessEnv | undefined;
  codexHome: string;
  codexCommand?: string;
  workingDirectory?: string;
  runtimeStateRoot?: string;
  readOnlyRoots?: string[];
  instructionWorkingCopyRoot?: string;
  disableProjectInstructions?: boolean;
  disableWebSearch?: boolean;
  args?: string[];
}): string[] {
  // The filesystem policy denies HOME and CODEX_HOME to keep credentials and
  // runner state outside provider reach. Always bind those names to the actual
  // isolated runner home; a stale controller environment must never cause the
  // execution workspace itself to become an explicit deny root.
  const args = input.args ? [...input.args] : [
    ...createIsolatedCodexAppServerArgs(
      {
        ...input.environment,
        HOME: usesPreconfiguredHome(input.environment) ? input.environment?.HOME : input.codexHome,
        CODEX_HOME: input.codexHome,
      },
      [...(input.readOnlyRoots ?? []), ...codexExecutableReadOnlyRoots(input.environment ?? {}, input.codexCommand)],
      input.instructionWorkingCopyRoot,
      usesPreconfiguredHome(input.environment) && input.runtimeStateRoot ? [input.runtimeStateRoot] : [],
    ),
  ];
  if (!input.args && usesPreconfiguredHome(input.environment) && input.workingDirectory) {
    args.unshift("-c", `projects={${JSON.stringify(input.workingDirectory)}={trust_level="trusted"}}`);
  }
  if (input.disableWebSearch || input.disableProjectInstructions) {
    // Apply Core's restriction after host overrides. Keep the override before
    // the Codex subcommand and after any earlier provider-home configuration.
    const commandIndex = args.indexOf("app-server");
    // Restricted launches use the owned app-server argument shape. Refuse
    // trailing subcommand flags and option terminators rather than guessing
    // whether another CLI spelling could override or neutralize this policy.
    if (args.some(arg => arg === "--" || (input.disableWebSearch && (arg === "--search" || arg.startsWith("--search=")))) || (commandIndex >= 0 && commandIndex !== args.length - 1)) {
      throw new Error(input.disableWebSearch ? "runner_codex_web_search_policy_override" : "runner_codex_project_instructions_policy_override");
    }
    args.splice(commandIndex < 0 ? args.length : commandIndex, 0,
      ...(input.disableProjectInstructions ? ["-c", "project_doc_max_bytes=0"] : []),
      ...(input.disableWebSearch ? ["-c", 'web_search="disabled"'] : []));
  }
  return args;
}
