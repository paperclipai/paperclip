import { randomUUID } from "node:crypto";
import type { AdapterAgent, AdapterAuthResult, AdapterAuthStatus } from "@paperclipai/adapter-utils";
import type { ServerAdapterModule } from "./types.js";
import { getAdapterSessionManagement } from "@paperclipai/adapter-utils";
import {
  execute as aiderExecute,
  testEnvironment as aiderTestEnvironment,
  sessionCodec as aiderSessionCodec,
  readAiderAuthStatus,
} from "@paperclipai/adapter-aider-local/server";
import {
  agentConfigurationDoc as aiderAgentConfigurationDoc,
  models as aiderModels,
  DEFAULT_AIDER_LOCAL_OLLAMA_BASE_URL,
} from "@paperclipai/adapter-aider-local";
import {
  execute as ollamaExecute,
  testEnvironment as ollamaTestEnvironment,
  sessionCodec as ollamaSessionCodec,
  readOllamaAuthStatus,
} from "@paperclipai/adapter-ollama-local/server";
import {
  agentConfigurationDoc as ollamaAgentConfigurationDoc,
  models as ollamaModels,
  DEFAULT_OLLAMA_LOCAL_BASE_URL,
} from "@paperclipai/adapter-ollama-local";
import {
  execute as claudeExecute,
  listClaudeSkills,
  syncClaudeSkills,
  listClaudeModels,
  testEnvironment as claudeTestEnvironment,
  sessionCodec as claudeSessionCodec,
  getQuotaWindows as claudeGetQuotaWindows,
  readClaudeAuthStatus,
  runClaudeLogin,
} from "@paperclipai/adapter-claude-local/server";
import { agentConfigurationDoc as claudeAgentConfigurationDoc, models as claudeModels } from "@paperclipai/adapter-claude-local";
import {
  execute as codexExecute,
  listCodexSkills,
  syncCodexSkills,
  testEnvironment as codexTestEnvironment,
  sessionCodec as codexSessionCodec,
  getQuotaWindows as codexGetQuotaWindows,
  readCodexAuthInfo,
  runCodexLogin,
} from "@paperclipai/adapter-codex-local/server";
import { agentConfigurationDoc as codexAgentConfigurationDoc, models as codexModels } from "@paperclipai/adapter-codex-local";
import {
  execute as cursorExecute,
  listCursorSkills,
  syncCursorSkills,
  testEnvironment as cursorTestEnvironment,
  sessionCodec as cursorSessionCodec,
} from "@paperclipai/adapter-cursor-local/server";
import { agentConfigurationDoc as cursorAgentConfigurationDoc, models as cursorModels } from "@paperclipai/adapter-cursor-local";
import {
  execute as geminiExecute,
  listGeminiSkills,
  syncGeminiSkills,
  testEnvironment as geminiTestEnvironment,
  sessionCodec as geminiSessionCodec,
} from "@paperclipai/adapter-gemini-local/server";
import { agentConfigurationDoc as geminiAgentConfigurationDoc, models as geminiModels } from "@paperclipai/adapter-gemini-local";
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
} from "@paperclipai/adapter-pi-local";
import {
  execute as hermesExecute,
  testEnvironment as hermesTestEnvironment,
  sessionCodec as hermesSessionCodec,
  listSkills as hermesListSkills,
  syncSkills as hermesSyncSkills,
  detectModel as detectModelFromHermes,
} from "hermes-paperclip-adapter/server";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";
import { buildExternalAdapters } from "./plugin-loader.js";
import { getDisabledAdapterTypes } from "../services/adapter-plugin-store.js";
import { processAdapter } from "./process/index.js";
import { httpAdapter } from "./http/index.js";

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

// Synthetic adapter-instance agent context used when running an interactive
// login subprocess (`<cli> login`) from the Adapters page. The login flow
// doesn't depend on a real agent — it just needs a runtime config so the CLI
// binary can be located and spawned with the OS user's default config dir.
function instanceLoginAgent(adapterType: string): AdapterAgent {
  return {
    id: "instance-login",
    companyId: "",
    name: "Adapter login",
    adapterType,
    adapterConfig: {},
  };
}

function clipOutput(stdout: string, stderr: string): string {
  const combined = [stdout, stderr].filter((s) => s && s.length > 0).join("\n");
  if (combined.length <= 4000) return combined;
  return `${combined.slice(0, 2000)}\n…\n${combined.slice(-1500)}`;
}

async function claudeGetAuthStatus(): Promise<AdapterAuthStatus | null> {
  const status = await readClaudeAuthStatus();
  if (!status) return null;
  const method =
    status.authMethod === "claude.ai"
      ? status.subscriptionType
        ? `Claude (${status.subscriptionType})`
        : "Claude subscription"
      : status.authMethod === "apiKey"
        ? "API key"
        : status.authMethod ?? null;
  return {
    loggedIn: status.loggedIn,
    method,
    detail: status.subscriptionType ?? null,
  };
}

async function claudeAuthenticate(): Promise<AdapterAuthResult> {
  try {
    const result = await runClaudeLogin({
      runId: `adapter-login-claude-${randomUUID()}`,
      agent: instanceLoginAgent("claude_local"),
      config: {},
    });
    const ok = !result.timedOut && (result.exitCode ?? 0) === 0;
    return {
      ok,
      loginUrl: result.loginUrl ?? null,
      output: clipOutput(result.stdout, result.stderr),
      error: ok ? undefined : result.timedOut ? "claude login timed out" : `claude login exited with code ${result.exitCode}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const claudeLocalAdapter: ServerAdapterModule = {
  type: "claude_local",
  description: "Spawns the Claude Code CLI locally — Anthropic's coding agent on your machine using your Claude subscription or API key.",
  execute: claudeExecute,
  testEnvironment: claudeTestEnvironment,
  listSkills: listClaudeSkills,
  syncSkills: syncClaudeSkills,
  sessionCodec: claudeSessionCodec,
  sessionManagement: getAdapterSessionManagement("claude_local") ?? undefined,
  models: claudeModels,
  listModels: listClaudeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: claudeAgentConfigurationDoc,
  getQuotaWindows: claudeGetQuotaWindows,
  getAuthStatus: claudeGetAuthStatus,
  authenticate: claudeAuthenticate,
};

async function codexGetAuthStatus(): Promise<AdapterAuthStatus | null> {
  try {
    const info = await readCodexAuthInfo();
    if (!info) {
      return { loggedIn: false, method: null, detail: null };
    }
    const method = info.planType ? `ChatGPT (${info.planType})` : "ChatGPT";
    return {
      loggedIn: true,
      method,
      detail: info.email ?? null,
    };
  } catch {
    return null;
  }
}

async function codexAuthenticate(): Promise<AdapterAuthResult> {
  try {
    const result = await runCodexLogin({
      runId: `adapter-login-codex-${randomUUID()}`,
      agent: instanceLoginAgent("codex_local"),
      config: {},
    });
    const ok = !result.timedOut && (result.exitCode ?? 0) === 0;
    return {
      ok,
      loginUrl: result.loginUrl ?? null,
      output: clipOutput(result.stdout, result.stderr),
      error: ok ? undefined : result.timedOut ? "codex login timed out" : `codex login exited with code ${result.exitCode}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const codexLocalAdapter: ServerAdapterModule = {
  type: "codex_local",
  description: "Spawns the OpenAI Codex CLI locally — coding agent backed by ChatGPT subscription or OpenAI API key.",
  execute: codexExecute,
  testEnvironment: codexTestEnvironment,
  listSkills: listCodexSkills,
  syncSkills: syncCodexSkills,
  sessionCodec: codexSessionCodec,
  sessionManagement: getAdapterSessionManagement("codex_local") ?? undefined,
  models: codexModels,
  listModels: listCodexModels,
  refreshModels: refreshCodexModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: codexAgentConfigurationDoc,
  getQuotaWindows: codexGetQuotaWindows,
  getAuthStatus: codexGetAuthStatus,
  authenticate: codexAuthenticate,
};

const cursorLocalAdapter: ServerAdapterModule = {
  type: "cursor",
  description: "Runs Cursor in background-agent mode — Cursor's hosted coding agent triggered locally.",
  execute: cursorExecute,
  testEnvironment: cursorTestEnvironment,
  listSkills: listCursorSkills,
  syncSkills: syncCursorSkills,
  sessionCodec: cursorSessionCodec,
  sessionManagement: getAdapterSessionManagement("cursor") ?? undefined,
  models: cursorModels,
  listModels: listCursorModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: cursorAgentConfigurationDoc,
};

const geminiLocalAdapter: ServerAdapterModule = {
  type: "gemini_local",
  description: "Spawns the Gemini CLI locally — Google's coding agent driven by a Gemini API key.",
  execute: geminiExecute,
  testEnvironment: geminiTestEnvironment,
  listSkills: listGeminiSkills,
  syncSkills: syncGeminiSkills,
  sessionCodec: geminiSessionCodec,
  sessionManagement: getAdapterSessionManagement("gemini_local") ?? undefined,
  models: geminiModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: geminiAgentConfigurationDoc,
};

async function aiderGetAuthStatus(): Promise<AdapterAuthStatus | null> {
  const status = await readAiderAuthStatus(DEFAULT_AIDER_LOCAL_OLLAMA_BASE_URL);
  return {
    loggedIn: status.loggedIn,
    method: status.loggedIn
      ? `${status.authMethod} (${status.modelsCount} model${status.modelsCount === 1 ? "" : "s"})`
      : status.authMethod,
    detail: status.loggedIn
      ? `Reachable at ${status.baseUrl}`
      : `Not reachable at ${status.baseUrl}`,
  };
}

const aiderLocalAdapter: ServerAdapterModule = {
  type: "aider_local",
  description: "⚠️ Coding agent only. Wraps the Aider CLI to edit code with a local Ollama model. Aider treats every prompt as a file-edit task — DO NOT use for triage, scheduling, research, or any non-coding agent. For those use ollama_local.",
  execute: aiderExecute,
  testEnvironment: aiderTestEnvironment,
  sessionCodec: aiderSessionCodec,
  sessionManagement: getAdapterSessionManagement("aider_local") ?? undefined,
  models: aiderModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: aiderAgentConfigurationDoc,
  getAuthStatus: aiderGetAuthStatus,
  // No authenticate() — Ollama is unauthenticated. The Adapters page hides the
  // sign-in button when authenticate is undefined, leaving just the auth-status
  // badge so users still see whether the runtime is reachable.
};

async function ollamaGetAuthStatus(): Promise<AdapterAuthStatus | null> {
  const status = await readOllamaAuthStatus(DEFAULT_OLLAMA_LOCAL_BASE_URL);
  return {
    loggedIn: status.loggedIn,
    method: status.loggedIn
      ? `${status.authMethod} (${status.modelsCount} model${status.modelsCount === 1 ? "" : "s"})`
      : status.authMethod,
    detail: status.loggedIn ? `Reachable at ${status.baseUrl}` : `Not reachable at ${status.baseUrl}`,
  };
}

const ollamaLocalAdapter: ServerAdapterModule = {
  type: "ollama_local",
  description: "Talks to a local Ollama model directly. For thinking-class agents — research, triage, status updates, scheduling, decision-making. No code editing, no tools — just inference + reply. Auto-pulls the model on first run.",
  execute: ollamaExecute,
  testEnvironment: ollamaTestEnvironment,
  sessionCodec: ollamaSessionCodec,
  sessionManagement: getAdapterSessionManagement("ollama_local") ?? undefined,
  models: ollamaModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: ollamaAgentConfigurationDoc,
  getAuthStatus: ollamaGetAuthStatus,
};

const openclawGatewayAdapter: ServerAdapterModule = {
  type: "openclaw_gateway",
  description: "Bridges to an OpenClaw gateway endpoint — fan agent runs out to a remote OpenClaw cluster.",
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
  description: "Spawns the OpenCode CLI locally — multi-provider coding agent (`provider/model` selection covers Anthropic, OpenAI, Ollama, etc.).",
  execute: openCodeExecute,
  testEnvironment: openCodeTestEnvironment,
  listSkills: listOpenCodeSkills,
  syncSkills: syncOpenCodeSkills,
  sessionCodec: openCodeSessionCodec,
  models: openCodeModels,
  sessionManagement: getAdapterSessionManagement("opencode_local") ?? undefined,
  listModels: listOpenCodeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: openCodeAgentConfigurationDoc,
};

const piLocalAdapter: ServerAdapterModule = {
  type: "pi_local",
  description: "Runs an embedded Pi agent locally — Paperclip's reference agent runtime for testing and demos.",
  execute: piExecute,
  testEnvironment: piTestEnvironment,
  listSkills: listPiSkills,
  syncSkills: syncPiSkills,
  sessionCodec: piSessionCodec,
  sessionManagement: getAdapterSessionManagement("pi_local") ?? undefined,
  models: [],
  listModels: listPiModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  agentConfigurationDoc: piAgentConfigurationDoc,
};

// hermes-paperclip-adapter v0.2.0 predates the authToken field; cast is
// intentional until hermes ships a matching AdapterExecutionContext type.
const executeHermesLocal = hermesExecute as unknown as ServerAdapterModule["execute"];

const hermesLocalAdapter: ServerAdapterModule = {
  type: "hermes_local",
  description: "Spawns the Hermes CLI locally — third-party agent runtime (`hermes-paperclip-adapter` package) with its own auth and model selection.",
  execute: async (ctx) => {
    const normalizedCtx = normalizeHermesConfig(ctx);
    if (!normalizedCtx.authToken) return executeHermesLocal(normalizedCtx);

    const existingConfig = (normalizedCtx.agent.adapterConfig ?? {}) as Record<string, unknown>;
    const existingEnv =
      typeof existingConfig.env === "object" && existingConfig.env !== null && !Array.isArray(existingConfig.env)
        ? (existingConfig.env as Record<string, string>)
        : {};
    const explicitApiKey =
      typeof existingEnv.PAPERCLIP_API_KEY === "string" && existingEnv.PAPERCLIP_API_KEY.trim().length > 0;
    const promptTemplate =
      typeof existingConfig.promptTemplate === "string" && existingConfig.promptTemplate.trim().length > 0
        ? existingConfig.promptTemplate
        : "";
    const authGuardPrompt = [
      "Paperclip API safety rule:",
      "Use Authorization: Bearer $PAPERCLIP_API_KEY on every Paperclip API request.",
      "Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every Paperclip API request that writes or mutates data, including comments and issue updates.",
      "Never use a board, browser, or local-board session for Paperclip API writes.",
    ].join("\n");

    const patchedConfig: Record<string, unknown> = {
      ...existingConfig,
      env: {
        ...existingEnv,
        ...(!explicitApiKey ? { PAPERCLIP_API_KEY: normalizedCtx.authToken } : {}),
        PAPERCLIP_RUN_ID: normalizedCtx.runId,
      },
    };

    // Only inject the auth guard into promptTemplate when a custom template already exists.
    // When no custom template is set, Hermes uses its built-in default heartbeat/task prompt —
    // overwriting it with only the auth guard text would strip the assigned issue/workflow instructions.
    if (promptTemplate) {
      patchedConfig.promptTemplate = `${authGuardPrompt}\n\n${promptTemplate}`;
    }

    const patchedCtx = {
      ...normalizedCtx,
      agent: {
        ...normalizedCtx.agent,
        adapterConfig: patchedConfig,
      },
    };

    return executeHermesLocal(patchedCtx);
  },
  testEnvironment: (ctx) => hermesTestEnvironment(normalizeHermesConfig(ctx) as never),
  sessionCodec: hermesSessionCodec,
  listSkills: hermesListSkills,
  syncSkills: hermesSyncSkills,
  models: hermesModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: hermesAgentConfigurationDoc,
  detectModel: () => detectModelFromHermes(),
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
    aiderLocalAdapter,
    claudeLocalAdapter,
    codexLocalAdapter,
    ollamaLocalAdapter,
    openCodeLocalAdapter,
    piLocalAdapter,
    cursorLocalAdapter,
    geminiLocalAdapter,
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
  return {
    ...externalAdapter,
    sessionManagement:
      externalAdapter.sessionManagement
        ?? getAdapterSessionManagement(externalAdapter.type)
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
      const overriding = BUILTIN_ADAPTER_TYPES.has(externalAdapter.type);
      if (overriding) {
        console.log(
          `[paperclip] External adapter "${externalAdapter.type}" overrides built-in adapter`,
        );
        // Save the original builtin for later restoration.
        const existing = adaptersByType.get(externalAdapter.type);
        if (existing && !builtinFallbacks.has(externalAdapter.type)) {
          builtinFallbacks.set(externalAdapter.type, existing);
        }
      }
      adaptersByType.set(
        externalAdapter.type,
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
  if (BUILTIN_ADAPTER_TYPES.has(adapter.type) && !builtinFallbacks.has(adapter.type)) {
    const existing = adaptersByType.get(adapter.type);
    if (existing) {
      builtinFallbacks.set(adapter.type, existing);
    }
  }
  adaptersByType.set(adapter.type, adapter);
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
