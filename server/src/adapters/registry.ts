import type { ServerAdapterModule } from "./types.js";
import {
  execute as claudeExecute,
  testEnvironment as claudeTestEnvironment,
  sessionCodec as claudeSessionCodec,
} from "@paperclipai/adapter-claude-local/server";
import { agentConfigurationDoc as claudeAgentConfigurationDoc, models as claudeModels } from "@paperclipai/adapter-claude-local";
import {
  execute as codexExecute,
  testEnvironment as codexTestEnvironment,
  sessionCodec as codexSessionCodec,
} from "@paperclipai/adapter-codex-local/server";
import { agentConfigurationDoc as codexAgentConfigurationDoc, models as codexModels } from "@paperclipai/adapter-codex-local";
import {
  execute as cursorExecute,
  testEnvironment as cursorTestEnvironment,
  sessionCodec as cursorSessionCodec,
} from "@paperclipai/adapter-cursor-local/server";
import { agentConfigurationDoc as cursorAgentConfigurationDoc, models as cursorModels } from "@paperclipai/adapter-cursor-local";
import {
  execute as openCodeExecute,
  testEnvironment as openCodeTestEnvironment,
  sessionCodec as openCodeSessionCodec,
  listOpenCodeModels,
} from "@paperclipai/adapter-opencode-local/server";
import {
  agentConfigurationDoc as openCodeAgentConfigurationDoc,
} from "@paperclipai/adapter-opencode-local";
import {
  execute as openclawGatewayExecute,
  testEnvironment as openclawGatewayTestEnvironment,
} from "@paperclipai/adapter-openclaw-gateway/server";
import {
  agentConfigurationDoc as openclawGatewayAgentConfigurationDoc,
  models as openclawGatewayModels,
} from "@paperclipai/adapter-openclaw-gateway";
import { listCodexModels } from "./codex-models.js";
import { listCursorModels } from "./cursor-models.js";
import {
  execute as piExecute,
  testEnvironment as piTestEnvironment,
  sessionCodec as piSessionCodec,
  listPiModels,
} from "@paperclipai/adapter-pi-local/server";
import {
  agentConfigurationDoc as piAgentConfigurationDoc,
} from "@paperclipai/adapter-pi-local";
import { processAdapter } from "./process/index.js";
import { httpAdapter } from "./http/index.js";

const claudeLocalAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute: claudeExecute,
  testEnvironment: claudeTestEnvironment,
  sessionCodec: claudeSessionCodec,
  models: claudeModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: claudeAgentConfigurationDoc,
};

const codexLocalAdapter: ServerAdapterModule = {
  type: "codex_local",
  execute: codexExecute,
  testEnvironment: codexTestEnvironment,
  sessionCodec: codexSessionCodec,
  models: codexModels,
  listModels: listCodexModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: codexAgentConfigurationDoc,
};

const cursorLocalAdapter: ServerAdapterModule = {
  type: "cursor",
  execute: cursorExecute,
  testEnvironment: cursorTestEnvironment,
  sessionCodec: cursorSessionCodec,
  models: cursorModels,
  listModels: listCursorModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: cursorAgentConfigurationDoc,
};

const openclawGatewayAdapter: ServerAdapterModule = {
  type: "openclaw_gateway",
  execute: openclawGatewayExecute,
  testEnvironment: openclawGatewayTestEnvironment,
  models: openclawGatewayModels,
  supportsLocalAgentJwt: false,
  agentConfigurationDoc: openclawGatewayAgentConfigurationDoc,
};

const openCodeLocalAdapter: ServerAdapterModule = {
  type: "opencode_local",
  execute: openCodeExecute,
  testEnvironment: openCodeTestEnvironment,
  sessionCodec: openCodeSessionCodec,
  models: [],
  listModels: listOpenCodeModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: openCodeAgentConfigurationDoc,
};

const piLocalAdapter: ServerAdapterModule = {
  type: "pi_local",
  execute: piExecute,
  testEnvironment: piTestEnvironment,
  sessionCodec: piSessionCodec,
  models: [],
  listModels: listPiModels,
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: piAgentConfigurationDoc,
};

const adaptersByType = new Map<string, ServerAdapterModule>(
  [
    claudeLocalAdapter,
    codexLocalAdapter,
    openCodeLocalAdapter,
    piLocalAdapter,
    cursorLocalAdapter,
    openclawGatewayAdapter,
    processAdapter,
    httpAdapter,
  ].map((a) => [a.type, a]),
);

export function getServerAdapter(type: string): ServerAdapterModule {
  const adapter = adaptersByType.get(type);
  if (!adapter) {
    // Fall back to process adapter for unknown types
    return processAdapter;
  }
  return adapter;
}

export async function listAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = adaptersByType.get(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export function listServerAdapters(): ServerAdapterModule[] {
  return Array.from(adaptersByType.values());
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}
