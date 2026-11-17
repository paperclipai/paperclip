import type {
  MemoryAgentCapabilities,
  MemoryAgentGuidanceContext,
  MemoryHardeningFlags,
} from "@paperclipai/adapter-utils/server-utils";
import { readDefaultMcpState } from "../default-mcp-spec.js";
import { BRAIN_BINDING_ARCANA_ENTRY_KEY } from "../arcana-brain-binding.js";
import { HERMES_ADAPTER_TYPE } from "./run-state.js";

/** Env key that holds the per-agent memory token for Claude and Codex agents (see default-mcp-agent-memory). */
const EXTERNAL_MEMORY_TOKEN_ENV_KEY = "RH_MEMORY_TOKEN";
/** The memory tools default-MCP entry (TECH-8832); the key is spelled out so this module does not import the hook. */
const MEMORY_TOOLS_ENTRY_KEY = "agent-memory-tools";
/** Env switch the Claude/Codex hook reads; the hook's own off values are mirrored here. */
const CAPTURE_SWITCH_ENV_KEY = "RH_MEMORY_CAPTURE";
const CAPTURE_OFF_VALUES = new Set(["off", "false", "0", "no"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** True when an env entry holds a token: a non-empty string, or a plain or secret-reference binding. The value is never returned or logged. */
function envEntryPresent(entry: unknown): boolean {
  if (typeof entry === "string") return entry.trim() !== "";
  if (!isRecord(entry)) return false;
  if (entry.type === "secret_ref") return typeof entry.secretId === "string" && entry.secretId !== "";
  if (entry.type === "plain") return typeof entry.value === "string" && entry.value.trim() !== "";
  return false;
}

/**
 * Whether the agent uses the external memory service, which is separate from Paperclip runtime memory (TECH-8409).
 * Hermes selects it with `adapterConfig.memoryProvider: "mem0"`. Claude and Codex agents carry `RH_MEMORY_TOKEN`.
 * Presence only: the token value is never returned or logged.
 */
export function agentUsesExternalMemory(
  adapterType: string | null | undefined,
  adapterConfig: unknown,
): boolean {
  if (!isRecord(adapterConfig)) return false;
  if (adapterType === HERMES_ADAPTER_TYPE) {
    return typeof adapterConfig.memoryProvider === "string" && adapterConfig.memoryProvider.trim() === "mem0";
  }
  if (adapterType === "claude_local" || adapterType === "codex_local") {
    return isRecord(adapterConfig.env) && envEntryPresent(adapterConfig.env[EXTERNAL_MEMORY_TOKEN_ENV_KEY]);
  }
  return false;
}

/**
 * Whether the end-of-turn capture hook is on for a Claude or Codex agent. It is on unless `RH_MEMORY_CAPTURE` holds an
 * off value; a value that is not a plain string (for example a secret reference) is treated as on, the hook's default.
 */
function captureHookOn(adapterConfig: unknown): boolean {
  if (!isRecord(adapterConfig) || !isRecord(adapterConfig.env)) return true;
  const entry = adapterConfig.env[CAPTURE_SWITCH_ENV_KEY];
  const value = typeof entry === "string" ? entry : isRecord(entry) && entry.type === "plain" && typeof entry.value === "string" ? entry.value : "";
  return !CAPTURE_OFF_VALUES.has(value.trim().toLowerCase());
}

export interface ComputeMemoryAgentCapabilitiesInput {
  agentMetadata: unknown;
  runtimeMemory: unknown;
  /**
   * The agent's adapterConfig, used to detect the external memory service. An agent that opted out of
   * `runtimeMemory` but uses the external service still has mem0 available. Absent means no external memory.
   */
  adapterConfig?: unknown;
  flags: Pick<MemoryHardeningFlags, "hermesMemoryConfig">;
  /**
   * Adapter type for the executing agent. When specified, hermesBuiltInStores
   * is only enabled for Hermes adapters (HERMES_ADAPTER_TYPE / "hermes_local").
   * Non-Hermes adapters must not emit Hermes-specific store guidance.
   */
  adapterType: string | null | undefined;
}

export function computeMemoryAgentCapabilities(
  input: ComputeMemoryAgentCapabilitiesInput,
): MemoryAgentCapabilities {
  const mcpState = readDefaultMcpState(input.agentMetadata);
  const arcanaReady =
    mcpState?.entries[BRAIN_BINDING_ARCANA_ENTRY_KEY]?.setup?.state === "ready";
  const memoryToolsEntry = mcpState?.entries[MEMORY_TOOLS_ENTRY_KEY];
  const isHermes = input.adapterType === HERMES_ADAPTER_TYPE;
  const hasRuntimeMemory = Boolean(input.runtimeMemory);
  // The Hermes adapter drops `memoryProvider` while runtime memory is active, so runtime memory wins.
  const externalMemory = !hasRuntimeMemory && agentUsesExternalMemory(input.adapterType, input.adapterConfig);
  const mem0Available = hasRuntimeMemory || externalMemory;

  return {
    mem0: mem0Available,
    ...(externalMemory ? { externalMemory: true } : {}),
    ...(externalMemory && !isHermes
      ? {
          // Claude and Codex: the explicit tools exist only once the agent's own connection is ready and installed.
          memoryTools: memoryToolsEntry?.setup?.state === "ready" && memoryToolsEntry.enabled === true,
          captureOn: captureHookOn(input.adapterConfig),
        }
      : {}),
    arcana: arcanaReady,
    hermesBuiltInStores: Boolean(
      isHermes && !mem0Available && !input.flags.hermesMemoryConfig,
    ),
  };
}

export function buildHeartbeatMemoryGuidanceContext(input: {
  agentMetadata: unknown;
  runtimeMemory: unknown;
  adapterConfig?: unknown;
  flags: MemoryHardeningFlags;
  adapterType: string | null | undefined;
}): MemoryAgentGuidanceContext | undefined {
  if (!input.flags.capabilityMemoryGuidance) {
    return undefined;
  }
  return {
    capabilities: computeMemoryAgentCapabilities(input),
    variant: "write-rules",
  };
}
