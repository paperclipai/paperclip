import type {
  AdapterModel,
  AdapterModelProfileDefinition,
  AdapterRuntimeCommandSpec,
  ServerAdapterModule,
} from "./types.js";
import {
  buildSandboxNpmInstallCommand,
  getAdapterSessionManagement,
} from "@paperclipai/adapter-utils";
import {
  execute as acpxExecute,
  testEnvironment as acpxTestEnvironment,
  sessionCodec as acpxSessionCodec,
  getConfigSchema as getAcpxConfigSchema,
  listAcpxSkills,
  syncAcpxSkills,
} from "@paperclipai/adapter-acpx-local/server";
import {
  agentConfigurationDoc as acpxAgentConfigurationDoc,
  models as acpxModels,
} from "@paperclipai/adapter-acpx-local";
import {
  execute as claudeExecute,
  listClaudeSkills,
  syncClaudeSkills,
  listClaudeModels,
  testEnvironment as claudeTestEnvironment,
  sessionCodec as claudeSessionCodec,
  getQuotaWindows as claudeGetQuotaWindows,
} from "@paperclipai/adapter-claude-local/server";
import {
  agentConfigurationDoc as claudeAgentConfigurationDoc,
  models as claudeModels,
  modelProfiles as claudeModelProfiles,
} from "@paperclipai/adapter-claude-local";
import {
  execute as codexExecute,
  listCodexSkills,
  syncCodexSkills,
  testEnvironment as codexTestEnvironment,
  sessionCodec as codexSessionCodec,
  getQuotaWindows as codexGetQuotaWindows,
} from "@paperclipai/adapter-codex-local/server";
import {
  agentConfigurationDoc as codexAgentConfigurationDoc,
  models as codexModels,
  modelProfiles as codexModelProfiles,
} from "@paperclipai/adapter-codex-local";
import {
  execute as cursorExecute,
  listCursorSkills,
  syncCursorSkills,
  testEnvironment as cursorTestEnvironment,
  sessionCodec as cursorSessionCodec,
} from "@paperclipai/adapter-cursor-local/server";
import {
  agentConfigurationDoc as cursorAgentConfigurationDoc,
  models as cursorModels,
  modelProfiles as cursorModelProfiles,
} from "@paperclipai/adapter-cursor-local";
import {
  execute as cursorCloudExecute,
  getConfigSchema as getCursorCloudConfigSchema,
  sessionCodec as cursorCloudSessionCodec,
  testEnvironment as cursorCloudTestEnvironment,
} from "@paperclipai/adapter-cursor-cloud/server";
import { agentConfigurationDoc as cursorCloudAgentConfigurationDoc } from "@paperclipai/adapter-cursor-cloud";
import {
  execute as geminiExecute,
  listGeminiSkills,
  syncGeminiSkills,
  testEnvironment as geminiTestEnvironment,
  sessionCodec as geminiSessionCodec,
} from "@paperclipai/adapter-gemini-local/server";
import {
  agentConfigurationDoc as geminiAgentConfigurationDoc,
  models as geminiModels,
  modelProfiles as geminiModelProfiles,
} from "@paperclipai/adapter-gemini-local";
import {
  execute as grokExecute,
  listGrokSkills,
  syncGrokSkills,
  testEnvironment as grokTestEnvironment,
  sessionCodec as grokSessionCodec,
} from "@paperclipai/adapter-grok-local/server";
import {
  agentConfigurationDoc as grokAgentConfigurationDoc,
  models as grokModels,
} from "@paperclipai/adapter-grok-local";
import {
  execute as openCodeExecute,
  listOpenCodeSkills,
  syncOpenCodeSkills,
  testEnvironment as openCodeTestEnvironment,
  sessionCodec as openCodeSessionCodec,
  listOpenCodeModels,
} from "@paperclipai/adapter-opencode-local/server";
import {
  agentConfigurationDoc as openCodeAgentConfigurationDoc,
  models as openCodeModels,
  modelProfiles as openCodeModelProfiles,
} from "@paperclipai/adapter-opencode-local";
import {
  execute as openclawGatewayExecute,
  testEnvironment as openclawGatewayTestEnvironment,
} from "@paperclipai/adapter-openclaw-gateway/server";
import {
  agentConfigurationDoc as openclawGatewayAgentConfigurationDoc,
  models as openclawGatewayModels,
} from "@paperclipai/adapter-openclaw-gateway";
import { listCodexModels, refreshCodexModels } from "./codex-models.js";
import { listCursorModels } from "./cursor-models.js";
import {
  execute as piExecute,
  listPiSkills,
  syncPiSkills,
  testEnvironment as piTestEnvironment,
  sessionCodec as piSessionCodec,
  listPiModels,
} from "@paperclipai/adapter-pi-local/server";
import {
  agentConfigurationDoc as piAgentConfigurationDoc,
  modelProfiles as piModelProfiles,
} from "@paperclipai/adapter-pi-local";
import {
  executeHermesWrapper,
  testEnvironmentHermesWrapper,
  hermesSessionCodec,
  hermesListSkills,
  hermesSyncSkills,
  detectModelFromHermes,
  MCP_FIRST_PROMPT,
  type HermesWrapperContext,
} from "./hermes-wrapper.js";
import { resolveHermesRuntimeConfig } from "./hermes-runtime-config.js";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";
import { buildExternalAdapters } from "./plugin-loader.js";
import { getDisabledAdapterTypes } from "../services/adapter-plugin-store.js";
import { processAdapter } from "./process/index.js";
import { httpAdapter } from "./http/index.js";
import { getHermesAgentConfigVersion } from "../services/hermes-config-sync.js";
import { parseObject, renderTemplate, asString } from "./utils.js";

function readConfiguredCommand(config: Record<string, unknown>, fallback: string): string {
  const value = typeof config.command === "string" ? config.command.trim() : "";
  return value.length > 0 ? value : fallback;
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildNpmRuntimeCommandSpec(
  config: Record<string, unknown>,
  fallbackCommand: string,
  packageName: string,
): AdapterRuntimeCommandSpec {
  const command = readConfiguredCommand(config, fallbackCommand);
  const canSelfInstall = !hasPathSeparator(command) && command === fallbackCommand;
  const installLine = buildSandboxNpmInstallCommand(packageName);
  return {
    command,
    detectCommand: command,
    installCommand: canSelfInstall
      ? `if ! command -v ${shellQuote(command)} >/dev/null 2>&1; then ${installLine}; fi`
      : null,
  };
}

function buildCursorRuntimeCommandSpec(config: Record<string, unknown>): AdapterRuntimeCommandSpec {
  const command = readConfiguredCommand(config, "agent");
  return {
    command,
    detectCommand: command,
    installCommand: null,
  };
}



function normalizeHermesContextTask(ctx: {
  agent?: { adapterConfig?: unknown };
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
}): {
  taskId: string | null;
  taskTitle: string | null;
  taskBody: string | null;
  commentId: string | null;
  wakeReason: string | null;
  workspaceDir: string | null;
} {
  const context = parseObject(ctx.context);
  const paperclipIssue = parseObject(context.paperclipIssue);
  const taskId =
    asString(paperclipIssue.id, "") ||
    asString(context.taskId, "") ||
    asString(context.issueId, "") ||
    null;
  const taskTitle = asString(paperclipIssue.title, "") || null;
  const taskBody = asString(paperclipIssue.description, "") || null;
  const commentId =
    asString(context.wakeCommentId, "") ||
    asString(context.commentId, "") ||
    null;
  const wakeReason = asString(context.wakeReason, "") || null;
  const paperclipWorkspace = parseObject(context.paperclipWorkspace);
  const workspaceDir = asString(paperclipWorkspace.cwd, "") || null;
  return { taskId, taskTitle, taskBody, commentId, wakeReason, workspaceDir };
}



function normalizeHermesConfig<T extends { config?: unknown; agent?: unknown }>(ctx: T): T {
  const config =
    ctx && typeof ctx === "object" && "config" in ctx && ctx.config && typeof ctx.config === "object"
      ? (ctx.config as Record<string, unknown>)
      : null;
  const agent =
    ctx && typeof ctx === "object" && "agent" in ctx && ctx.agent && typeof ctx.agent === "object"
      ? (ctx.agent as Record<string, unknown>)
      : null;
  const agentAdapterConfig =
    agent?.adapterConfig && typeof agent.adapterConfig === "object"
      ? (agent.adapterConfig as Record<string, unknown>)
      : null;

  const configCommand =
    typeof config?.command === "string" && config.command.length > 0 ? config.command : undefined;
  const agentCommand =
    typeof agentAdapterConfig?.command === "string" && agentAdapterConfig.command.length > 0
      ? agentAdapterConfig.command
      : undefined;

  if (config && !config.hermesCommand && configCommand) {
    config.hermesCommand = configCommand;
  }
  if (agentAdapterConfig && !agentAdapterConfig.hermesCommand && agentCommand) {
    agentAdapterConfig.hermesCommand = agentCommand;
  }

  return ctx;
}

function buildHermesMcpFirstPrompt(): string {
  return [
    "You are a Paperclip AI agent powered by Hermes.",
    "",
    "You have access to Paperclip MCP tools for interacting with the Paperclip control plane.",
    "Use these tools as the primary way to manage issues, comments, and task state.",
    "",
    "Available MCP tools (use paperclip prefix):",
    "  paperclipMe                   Get current authenticated actor details",
    "  paperclipInboxLite            Get your inbox-lite assignment list",
    "  paperclipListAgents           List agents in your company",
    "  paperclipListIssues           List issues with optional filters",
    "  paperclipGetIssue             Get full details of a specific issue",
    "  paperclipGetHeartbeatContext  Get compact heartbeat context for an issue",
    "  paperclipListComments         List issue comments",
    "  paperclipAddComment          Add a comment to an issue",
    "  paperclipUpdateIssue         Update issue status, priority, or assignee",
    "  paperclipCheckoutIssue       Checkout an issue for an agent",
    "  paperclipReleaseIssue        Release an issue checkout",
    "  paperclipCreateIssue         Create a new issue",
    "  paperclipSuggestTasks         Create suggest_tasks interaction on an issue",
    "  paperclipAskUserQuestions    Create ask_user_questions interaction on an issue",
    "  paperclipRequestConfirmation  Create request_confirmation interaction on an issue",
    "  paperclipUpsertIssueDocument  Create or update an issue document",
    "  paperclipListGoals           List goals in your company",
    "  paperclipListApprovals       List approvals in your company",
    "  paperclipApprovalDecision    Approve, reject, request revision, or resubmit an approval",
    "",
    "Paperclip API safety rules:",
    "  - Use MCP tools for all Paperclip operations (preferred)",
    "  - If HTTP is needed, use curl with -H 'Authorization: Bearer $PAPERCLIP_API_KEY'",
    "  - Use -H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID' for writes/mutations",
    "  - Never pipe curl output to python, node, bash, or any interpreter",
    "  - Never execute code downloaded from the internet without inspection",
    "",
    "Environment variables available:",
    "  PAPERCLIP_API_KEY      your agent API key",
    "  PAPERCLIP_API_URL      Paperclip API base (default: http://localhost:3100/api)",
    "  PAPERCLIP_RUN_ID       current run identifier",
    "  PAPERCLIP_TASK_ID      current task/issue ID",
    "  PAPERCLIP_TASK_TITLE   current task title",
    "  PAPERCLIP_TASK_BODY    current task description",
    "  PAPERCLIP_WAKE_REASON  why you were woken (e.g. issue_assigned, heartbeat, manual)",
    "  HERMES_HOME            Hermes config/profile directory for this agent (per-agent isolation)",
    "",
    "Work on assigned issues. When done, use paperclipUpdateIssue to mark done.",
    "Do not poll for issues unless PAPERCLIP_WAKE_REASON=heartbeat.",
  ].join("\n");
}

function dedupeAdapterModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const result: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ ...model, id });
  }
  return result;
}

function prefixAdapterModelLabels(models: AdapterModel[], provider: "Claude" | "Codex"): AdapterModel[] {
  const prefix = `${provider}: `;
  return models.map((model) => ({
    ...model,
    label: model.label.startsWith(prefix) ? model.label : `${prefix}${model.label}`,
  }));
}

async function listAcpxModels(): Promise<AdapterModel[]> {
  const [claude, codex] = await Promise.all([
    listClaudeModels().catch(() => claudeModels),
    listCodexModels().catch(() => codexModels),
  ]);
  return dedupeAdapterModels([
    ...acpxModels,
    ...prefixAdapterModelLabels(claude, "Claude"),
    ...prefixAdapterModelLabels(codex, "Codex"),
  ]);
}

const claudeLocalAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute: claudeExecute,
  testEnvironment: claudeTestEnvironment,
  listSkills: listClaudeSkills,
  syncSkills: syncClaudeSkills,
  sessionCodec: claudeSessionCodec,
  sessionManagement: getAdapterSessionManagement("claude_local") ?? undefined,
  models: claudeModels,
  modelProfiles: claudeModelProfiles,
  listModels: listClaudeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec(config, "claude", "@anthropic-ai/claude-code"),
  agentConfigurationDoc: claudeAgentConfigurationDoc,
  getQuotaWindows: claudeGetQuotaWindows,
};

const acpxLocalAdapter: ServerAdapterModule = {
  type: "acpx_local",
  execute: acpxExecute,
  testEnvironment: acpxTestEnvironment,
  listSkills: listAcpxSkills,
  syncSkills: syncAcpxSkills,
  sessionCodec: acpxSessionCodec,
  sessionManagement: getAdapterSessionManagement("acpx_local") ?? undefined,
  models: dedupeAdapterModels([
    ...prefixAdapterModelLabels(claudeModels, "Claude"),
    ...prefixAdapterModelLabels(codexModels, "Codex"),
  ]),
  listModels: listAcpxModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: acpxAgentConfigurationDoc,
  getConfigSchema: getAcpxConfigSchema,
};

const codexLocalAdapter: ServerAdapterModule = {
  type: "codex_local",
  execute: codexExecute,
  testEnvironment: codexTestEnvironment,
  listSkills: listCodexSkills,
  syncSkills: syncCodexSkills,
  sessionCodec: codexSessionCodec,
  sessionManagement: getAdapterSessionManagement("codex_local") ?? undefined,
  models: codexModels,
  modelProfiles: codexModelProfiles,
  listModels: listCodexModels,
  refreshModels: refreshCodexModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  getRuntimeCommandSpec: (config) => buildNpmRuntimeCommandSpec(config, "codex", "@openai/codex"),
  agentConfigurationDoc: codexAgentConfigurationDoc,
  getQuotaWindows: codexGetQuotaWindows,
};

const cursorLocalAdapter: ServerAdapterModule = {
  type: "cursor",
  execute: cursorExecute,
  testEnvironment: cursorTestEnvironment,
  listSkills: listCursorSkills,
  syncSkills: syncCursorSkills,
  sessionCodec: cursorSessionCodec,
  sessionManagement: getAdapterSessionManagement("cursor") ?? undefined,
  models: cursorModels,
  modelProfiles: cursorModelProfiles,
  listModels: listCursorModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: buildCursorRuntimeCommandSpec,
  agentConfigurationDoc: cursorAgentConfigurationDoc,
};

const cursorCloudAdapter: ServerAdapterModule = {
  type: "cursor_cloud",
  execute: cursorCloudExecute,
  testEnvironment: cursorCloudTestEnvironment,
  sessionCodec: cursorCloudSessionCodec,
  sessionManagement: getAdapterSessionManagement("cursor_cloud") ?? undefined,
  models: [],
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: cursorCloudAgentConfigurationDoc,
  getConfigSchema: getCursorCloudConfigSchema,
};

const geminiLocalAdapter: ServerAdapterModule = {
  type: "gemini_local",
  execute: geminiExecute,
  testEnvironment: geminiTestEnvironment,
  listSkills: listGeminiSkills,
  syncSkills: syncGeminiSkills,
  sessionCodec: geminiSessionCodec,
  sessionManagement: getAdapterSessionManagement("gemini_local") ?? undefined,
  models: geminiModels,
  modelProfiles: geminiModelProfiles,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec(config, "gemini", "@google/gemini-cli"),
  agentConfigurationDoc: geminiAgentConfigurationDoc,
};

const grokLocalAdapter: ServerAdapterModule = {
  type: "grok_local",
  execute: grokExecute,
  testEnvironment: grokTestEnvironment,
  listSkills: listGrokSkills,
  syncSkills: syncGrokSkills,
  sessionCodec: grokSessionCodec,
  sessionManagement: getAdapterSessionManagement("grok_local") ?? undefined,
  models: grokModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) => ({
    command: readConfiguredCommand(config, "grok"),
    detectCommand: readConfiguredCommand(config, "grok"),
    installCommand: null,
  }),
  agentConfigurationDoc: grokAgentConfigurationDoc,
};

const openclawGatewayAdapter: ServerAdapterModule = {
  type: "openclaw_gateway",
  execute: openclawGatewayExecute,
  testEnvironment: openclawGatewayTestEnvironment,
  models: openclawGatewayModels,
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: openclawGatewayAgentConfigurationDoc,
};

const openCodeLocalAdapter: ServerAdapterModule = {
  type: "opencode_local",
  execute: openCodeExecute,
  testEnvironment: openCodeTestEnvironment,
  listSkills: listOpenCodeSkills,
  syncSkills: syncOpenCodeSkills,
  sessionCodec: openCodeSessionCodec,
  models: openCodeModels,
  modelProfiles: openCodeModelProfiles,
  sessionManagement: getAdapterSessionManagement("opencode_local") ?? undefined,
  listModels: listOpenCodeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) => buildNpmRuntimeCommandSpec(config, "opencode", "opencode-ai"),
  agentConfigurationDoc: openCodeAgentConfigurationDoc,
};

const piLocalAdapter: ServerAdapterModule = {
  type: "pi_local",
  execute: piExecute,
  testEnvironment: piTestEnvironment,
  listSkills: listPiSkills,
  syncSkills: syncPiSkills,
  sessionCodec: piSessionCodec,
  sessionManagement: getAdapterSessionManagement("pi_local") ?? undefined,
  models: [],
  modelProfiles: piModelProfiles,
  listModels: listPiModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec(config, "pi", "@mariozechner/pi-coding-agent"),
  agentConfigurationDoc: piAgentConfigurationDoc,
};

// hermes-paperclip-adapter v0.3.0 delegates to the wrapper for config/env wiring.
const hermesLocalAdapter: ServerAdapterModule = {
  type: "hermes_local",
  execute: async (ctx) => {
    const normalizedCtx = normalizeHermesConfig(ctx);

    const companyId = normalizedCtx.agent?.companyId ?? "";
    const agentId = normalizedCtx.agent?.id ?? "";
    const agentHermesHome = `/paperclip/hermes/agents/${companyId}/${agentId}`;

    const existingConfig = (normalizedCtx.agent?.adapterConfig ?? {}) as Record<string, unknown>;
    const configSource = (normalizedCtx.config ?? {}) as Record<string, unknown>;
    const existingEnv = (existingConfig.env as Record<string, string>) ?? {};

    const explicitApiKey =
      typeof existingEnv.PAPERCLIP_API_KEY === "string" && existingEnv.PAPERCLIP_API_KEY.trim().length > 0;
    const hasCustomPrompt =
      typeof configSource.promptTemplate === "string" && configSource.promptTemplate.trim().length > 0;

    const taskCtx = normalizeHermesContextTask({
      agent: normalizedCtx.agent,
      config: normalizedCtx.config,
      context: normalizedCtx.context,
    });

    const paperclipApiUrl =
      typeof configSource.paperclipApiUrl === "string" && configSource.paperclipApiUrl.trim().length > 0
        ? configSource.paperclipApiUrl.trim()
        : typeof existingConfig.paperclipApiUrl === "string" && existingConfig.paperclipApiUrl.trim().length > 0
          ? existingConfig.paperclipApiUrl.trim()
          : "http://localhost:3100/api";

    const pushedConfigVersion = getHermesAgentConfigVersion(normalizedCtx.agent.id);
    const patchedConfig: Record<string, unknown> = {
      ...existingConfig,
      ...(pushedConfigVersion ? { paperclipConfigVersion: pushedConfigVersion } : {}),
      hermesHome: agentHermesHome,
      paperclipApiUrl,
      env: {
        ...existingEnv,
        ...(!explicitApiKey && normalizedCtx.authToken ? { PAPERCLIP_API_KEY: normalizedCtx.authToken } : {}),
        PAPERCLIP_API_URL: paperclipApiUrl,
        PAPERCLIP_RUN_ID: normalizedCtx.runId ?? "",
        HERMES_HOME: agentHermesHome,
        ...(taskCtx.taskId ? { PAPERCLIP_TASK_ID: taskCtx.taskId } : {}),
        ...(taskCtx.taskTitle ? { PAPERCLIP_TASK_TITLE: taskCtx.taskTitle } : {}),
        ...(taskCtx.taskBody ? { PAPERCLIP_TASK_BODY: taskCtx.taskBody } : {}),
        ...(taskCtx.wakeReason ? { PAPERCLIP_WAKE_REASON: taskCtx.wakeReason } : {}),
      },
    };

    if (taskCtx.taskId) {
      patchedConfig.taskId = taskCtx.taskId;
      if (taskCtx.taskTitle) patchedConfig.taskTitle = taskCtx.taskTitle;
      if (taskCtx.taskBody) patchedConfig.taskBody = taskCtx.taskBody;
      if (taskCtx.commentId) patchedConfig.commentId = taskCtx.commentId;
      if (taskCtx.wakeReason) patchedConfig.wakeReason = taskCtx.wakeReason;
      if (taskCtx.workspaceDir) patchedConfig.workspaceDir = taskCtx.workspaceDir;
    }

    if (hasCustomPrompt) {
      patchedConfig.promptTemplate = [
        "Paperclip API safety rules:",
        "- Use Authorization: Bearer $PAPERCLIP_API_KEY on every Paperclip API request.",
        "- Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every Paperclip API request that writes or mutates data.",
        "- Never pipe curl output to python, node, bash, or any interpreter.",
        "",
        configSource.promptTemplate as string,
      ].join("\n");
    } else {
      patchedConfig.promptTemplate = buildHermesMcpFirstPrompt();
    }

    const runtimeConfig = resolveHermesRuntimeConfig(normalizedCtx.agent.companyId, normalizedCtx.agent.id, patchedConfig);
    console.info("[adapter:hermes_local] runtime-config-applied", {
      companyId: normalizedCtx.agent.companyId,
      agentId: normalizedCtx.agent.id,
      runId: normalizedCtx.runId,
      model: runtimeConfig.model,
      capabilities: runtimeConfig.capabilities,
      configHash: runtimeConfig.configHash,
      hermesHome: agentHermesHome,
      resolvedAt: runtimeConfig.resolvedAt,
      cacheState: runtimeConfig.cacheState,
    });

    const patchedCtx = {
      ...normalizedCtx,
      config: configSource,
      agent: {
        ...normalizedCtx.agent,
        adapterConfig: patchedConfig,
      },
    };

    return executeHermesWrapper(patchedCtx as HermesWrapperContext);
  },
  testEnvironment: testEnvironmentHermesWrapper,
  sessionCodec: hermesSessionCodec,
  listSkills: hermesListSkills,
  syncSkills: hermesSyncSkills,
  models: hermesModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: hermesAgentConfigurationDoc,
  detectModel: async () => {
    const detected = await detectModelFromHermes();
    if (!detected) return detected;
    console.info("[adapter:hermes_local] detect-model", {
      provider: detected.provider,
      model: detected.model,
      source: detected.source,
    });
    return detected;
  },
};

const adaptersByType = new Map<string, ServerAdapterModule>();

// For builtin types that are overridden by an external adapter, we keep the
// original builtin so it can be restored when the override is deactivated.
const builtinFallbacks = new Map<string, ServerAdapterModule>();

// Tracks which override types are currently deactivated (paused).  When
// paused, `getServerAdapter()` returns the builtin fallback instead of the
// external.  Persisted across reloads via the same disabled-adapters store.
const pausedOverrides = new Set<string>();

function registerBuiltInAdapters() {
  for (const adapter of [
    acpxLocalAdapter,
    claudeLocalAdapter,
    codexLocalAdapter,
    openCodeLocalAdapter,
    piLocalAdapter,
    cursorCloudAdapter,
    cursorLocalAdapter,
    geminiLocalAdapter,
    grokLocalAdapter,
    openclawGatewayAdapter,
    hermesLocalAdapter,
    processAdapter,
    httpAdapter,
  ]) {
    adaptersByType.set(adapter.type, adapter);
  }
}

registerBuiltInAdapters();

// ---------------------------------------------------------------------------
// Load external adapter plugins (e.g. droid_local)
//
// External adapter packages export createServerAdapter() which returns a
// ServerAdapterModule. When the module provides its own sessionManagement
// it is preserved; otherwise the host falls back to the built-in registry
// lookup (so externals that override a built-in type inherit the builtin's
// policy). This brings init-time registration to at-least-as-good behavior
// as the hot-install path (routes/adapters.ts:179 -> registerServerAdapter):
// both preserve module-provided sessionManagement, and init-time additionally
// applies the registry fallback for externals overriding a built-in type.
// ---------------------------------------------------------------------------

/** Cached sync wrapper — the store is a simple JSON file read, safe to call frequently. */
function getDisabledAdapterTypesFromStore(): string[] {
  return getDisabledAdapterTypes();
}

/**
 * Merge an external adapter module with host-provided session management.
 *
 * Module-provided `sessionManagement` takes precedence. When absent, fall
 * back to the hardcoded registry keyed by adapter type (so externals that
 * override a built-in — same `type` — inherit the builtin's policy). If
 * neither is available, `sessionManagement` remains `undefined`.
 *
 * Used by both the init-time IIFE below (external-adapter load pass on
 * server start) and the hot-install path in `routes/adapters.ts`
 * (`registerWithSessionManagement`), so the two load paths resolve
 * `sessionManagement` identically.
 */
export function resolveExternalAdapterRegistration(
  externalAdapter: ServerAdapterModule,
): ServerAdapterModule {
  const adapterType = externalAdapter.type;
  return {
    ...externalAdapter,
    sessionManagement:
      adapterType
        ? (externalAdapter.sessionManagement
          ?? getAdapterSessionManagement(adapterType)
          ?? undefined)
        : externalAdapter.sessionManagement
          ?? undefined,
  };
}

/**
 * Load external adapters from the plugin store and hardcoded sources.
 * Called once at module initialization. The promise is exported so that
 * callers (e.g. assertKnownAdapterType, app startup) can await completion
 * and avoid racing against the loading window.
 */
const externalAdaptersReady: Promise<void> = (async () => {
  try {
    const externalAdapters = await buildExternalAdapters();
    for (const externalAdapter of externalAdapters) {
      const adapterType = externalAdapter.type;
      if (!adapterType) {
        console.warn("[paperclip] Skipping external adapter with missing type:", externalAdapter);
        continue;
      }
      const overriding = BUILTIN_ADAPTER_TYPES.has(adapterType);
      if (overriding) {
        console.log(
          `[paperclip] External adapter "${adapterType}" overrides built-in adapter`,
        );
        // Save the original builtin for later restoration.
        const existing = adaptersByType.get(adapterType);
        if (existing && !builtinFallbacks.has(adapterType)) {
          builtinFallbacks.set(adapterType, existing);
        }
      }
      adaptersByType.set(
        adapterType,
        resolveExternalAdapterRegistration(externalAdapter),
      );
    }
  } catch (err) {
    console.error("[paperclip] Failed to load external adapters:", err);
  }
})();

/**
 * Await this before validating adapter types to avoid race conditions
 * during server startup. External adapters are loaded asynchronously;
 * calling assertKnownAdapterType before this resolves will reject
 * valid external adapter types.
 */
export function waitForExternalAdapters(): Promise<void> {
  return externalAdaptersReady;
}

export function registerServerAdapter(adapter: ServerAdapterModule): void {
  const adapterType = adapter.type;
  if (!adapterType) {
    console.warn("[paperclip] registerServerAdapter called with missing type:", adapter);
    return;
  }
  if (BUILTIN_ADAPTER_TYPES.has(adapterType) && !builtinFallbacks.has(adapterType)) {
    const existing = adaptersByType.get(adapterType);
    if (existing) {
      builtinFallbacks.set(adapterType, existing);
    }
  }
  adaptersByType.set(adapterType, adapter);
}

export function unregisterServerAdapter(type: string): void {
  if (type === processAdapter.type || type === httpAdapter.type) return;
  if (builtinFallbacks.has(type)) {
    pausedOverrides.delete(type);
    const fallback = builtinFallbacks.get(type);
    if (fallback) {
      adaptersByType.set(type, fallback);
    }
    return;
  }
  if (BUILTIN_ADAPTER_TYPES.has(type)) {
    return;
  }
  adaptersByType.delete(type);
}

export function requireServerAdapter(type: string): ServerAdapterModule {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) {
    throw new Error(`Unknown adapter type: ${type}`);
  }
  return adapter;
}

export function getServerAdapter(type: string): ServerAdapterModule {
  return findActiveServerAdapter(type) ?? processAdapter;
}

export async function listAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export async function refreshAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.refreshModels) {
    const refreshed = await adapter.refreshModels();
    if (refreshed.length > 0) return refreshed;
  }
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export async function listAdapterModelProfiles(type: string): Promise<AdapterModelProfileDefinition[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModelProfiles) {
    const discovered = await adapter.listModelProfiles();
    if (discovered.length > 0) return discovered;
  }
  return adapter.modelProfiles ?? [];
}

export function listServerAdapters(): ServerAdapterModule[] {
  return Array.from(adaptersByType.values());
}

/**
 * List adapters excluding those that are disabled in settings.
 * Used for menus and agent creation flows — disabled adapters remain
 * functional for existing agents but hidden from selection.
 */
export function listEnabledServerAdapters(): ServerAdapterModule[] {
  const disabled = getDisabledAdapterTypesFromStore();
  const disabledSet = disabled.length > 0 ? new Set(disabled) : null;
  return disabledSet
    ? Array.from(adaptersByType.values()).filter((a) => !disabledSet.has(a.type))
    : Array.from(adaptersByType.values());
}

export async function detectAdapterModel(
  type: string,
): Promise<{ model: string; provider: string; source: string; candidates?: string[] } | null> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter?.detectModel) return null;
  const detected = await adapter.detectModel();
  if (!detected) return null;
  return {
    model: detected.model,
    provider: detected.provider,
    source: detected.source,
    ...(detected.candidates?.length ? { candidates: detected.candidates } : {}),
  };
}

// ---------------------------------------------------------------------------
// Override pause / resume
// ---------------------------------------------------------------------------

/**
 * Pause or resume an external override for a builtin adapter type.
 *
 * - `paused = true`  → subsequent calls to `getServerAdapter(type)` return
 *   the builtin fallback instead of the external adapter.  Already-running
 *   agent sessions are unaffected (they hold a reference to the module they
 *   started with).
 *
 * - `paused = false` → the external adapter is active again.
 *
 * Returns `true` if the state actually changed, `false` if the type is not
 * an override or was already in the requested state.
 */
export function setOverridePaused(type: string, paused: boolean): boolean {
  if (!builtinFallbacks.has(type)) return false;
  const wasPaused = pausedOverrides.has(type);
  if (paused && !wasPaused) {
    pausedOverrides.add(type);
    console.log(`[paperclip] Override paused for "${type}" — builtin adapter restored`);
    return true;
  }
  if (!paused && wasPaused) {
    pausedOverrides.delete(type);
    console.log(`[paperclip] Override resumed for "${type}" — external adapter active`);
    return true;
  }
  return false;
}

/** Check whether the external override for a builtin type is currently paused. */
export function isOverridePaused(type: string): boolean {
  return pausedOverrides.has(type);
}

/** Get the set of types whose overrides are currently paused. */
export function getPausedOverrides(): Set<string> {
  return pausedOverrides;
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

export function findActiveServerAdapter(type: string): ServerAdapterModule | null {
  if (pausedOverrides.has(type)) {
    const fallback = builtinFallbacks.get(type);
    if (fallback) return fallback;
  }
  return adaptersByType.get(type) ?? null;
}
