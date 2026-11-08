import { t } from "@/i18n";
/**
 * Single source of truth for adapter display metadata.
 *
 * Built-in adapters have entries in `adapterDisplayMap`. External (plugin)
 * adapters get sensible defaults derived from their type string via
 * `getAdapterDisplay()`.
 */
import type { ComponentType } from "react";
import { agentHarnessType } from "@paperclipai/shared";
import {
  Bot,
  Code,
  Gem,
  Moon,
  MousePointer2,
  Sparkles,
  Terminal,
  Cpu,
} from "lucide-react";
import { OpenCodeLogoIcon } from "@/components/OpenCodeLogoIcon";
import { pendingAgentSetupDisplayAdapter } from "@/lib/agent-setup-choice";

// ---------------------------------------------------------------------------
// Type suffix parsing
// ---------------------------------------------------------------------------

// Suffixes stripped from type ids when deriving a human-readable label for
// unknown (plugin) adapter types. "_local" is a legacy qualifier from before
// first-class Environments and is never displayed; "_gateway" is re-appended
// as " (gateway)" to disambiguate gateway variants. Known adapters in
// `adapterDisplayMap` have final labels and never get a derived suffix.
const STRIPPED_TYPE_SUFFIXES = ["_local", "_gateway"] as const;

const DISPLAY_SUFFIXES: Record<string, string> = {
  _gateway: "gateway",
};

function getTypeSuffix(type: string): string | null {
  for (const [suffix, mode] of Object.entries(DISPLAY_SUFFIXES)) {
    if (type.endsWith(suffix)) return mode;
  }
  return null;
}

function withSuffix(label: string, suffix: string | null): string {
  return suffix ? `${label} (${suffix})` : label;
}

// ---------------------------------------------------------------------------
// Display metadata per adapter type
// ---------------------------------------------------------------------------

export interface AdapterDisplayInfo {
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  recommended?: boolean;
  comingSoon?: boolean;
  disabledLabel?: string;
  experimental?: boolean;
  hideFromVisualSelection?: boolean;
}

const adapterDisplayMap: Record<string, AdapterDisplayInfo> = {
  antigravity_runtime: { get label() { return t("agent-config:googleAntigravity_60e441d"); }, get description() { return t("agent-config:antigravityThroughPaperclipRunner_50f4e08"); }, icon: Gem, hideFromVisualSelection: true },
  copilot_runtime: { get label() { return t("agent-config:githubCopilot_56a0e61"); }, get description() { return t("agent-config:copilotThroughPaperclipRunner_7a47882"); }, icon: Code, hideFromVisualSelection: true },
  kimi_runtime: { get label() { return t("agent-config:kimiCodeRunner_491d9f7"); }, get description() { return t("agent-config:kimiCodeThroughPaperclipRunner_8443b8a"); }, icon: Moon, hideFromVisualSelection: true },
  acpx_local: {
    get label() { return t("agent-config:acpxRetired_ceea09f"); },
    get description() { return t("agent-config:retiredStandaloneAcpxAdapter_b59b6b3"); },
    icon: Bot,
    comingSoon: true,
    get disabledLabel() { return t("agent-config:useClaudeCodeOrCodexWithTheAcp_1f6c2ca"); },
    hideFromVisualSelection: true,
  },
  claude_local: {
    get label() { return t("agent-config:claudeCode_61f2de2"); },
    get description() { return t("agent-config:claudeCodeCliHarness_ea55c24"); },
    icon: Sparkles,
    recommended: true,
  },
  codex_local: {
    get label() { return t("agent-config:codex_2c5d5b8"); },
    get description() { return t("agent-config:codexCliHarness_23c5c36"); },
    icon: Code,
    recommended: true,
  },
  paperclip_runner: {
    get label() { return t("agent-config:paperclipRunner_f50f4c1"); },
    get description() { return t("agent-config:experimentalRustRunnerWithACodexProvider_c4defb8"); },
    icon: Cpu,
    experimental: true,
  },
  gemini_local: {
    get label() { return t("agent-config:geminiCli_4844115"); },
    get description() { return t("agent-config:geminiCliHarness_0a6de97"); },
    icon: Gem,
  },
  grok_local: {
    get label() { return t("agent-config:grokBuild_2b95684"); },
    get description() { return t("agent-config:grokBuildHarness_047d292"); },
    icon: Bot,
  },
  kimi_local: {
    get label() { return t("agent-config:kimiCode_e4e5d37"); },
    get description() { return t("agent-config:kimiCodeCliHarness_de55a17"); },
    icon: Moon,
  },
  hermes_gateway: {
    get label() { return t("agent-config:hermesGateway_127ca93"); },
    get description() { return t("agent-config:remoteHermesApiServer_e8a6874"); },
    icon: Bot,
    hideFromVisualSelection: true,
  },
  hermes_local: {
    get label() { return t("agent-config:hermes_3e06620"); },
    get description() { return t("agent-config:hermesHarness_e814cd4"); },
    icon: Bot,
  },
  opencode_local: {
    get label() { return t("agent-config:opencode_6e2b310"); },
    get description() { return t("agent-config:opencodeMultiProviderHarness_2c2fad8"); },
    icon: OpenCodeLogoIcon,
  },
  pi_local: {
    get label() { return t("agent-config:pi_a134388"); },
    get description() { return t("agent-config:piHarness_ed620ed"); },
    icon: Terminal,
  },
  cursor: {
    get label() { return t("agent-config:cursor_2239943"); },
    get description() { return t("agent-config:cursorCliHarness_8f15ab5"); },
    icon: MousePointer2,
  },
  // Display-only choice: persisted as paperclip_runner with provider openai_dot.
  grok_bot: { get label() { return t("agent-config:grokBot_c2ced68"); }, experimental: true, icon: Bot, get description() { return t("agent-config:anExistingExternalBotInGrok_353e95d"); } },
  openai_dot: {
    get label() { return t("agent-config:openaiDot_39b1d09"); },
    get description() { return t("agent-config:yourDotInChatgpt_80718a2"); },
    icon: Bot,
    experimental: true,
  },
  muse: {
    get label() { return t("agent-config:musePersonalAgent_9c8bd19"); },
    get description() { return t("agent-config:yourPersonalMuseAtMuseAi_5d38a14"); },
    icon: Bot,
    experimental: true,
  },
  cursor_cloud: {
    get label() { return t("agent-config:cursorCloud_48e09b3"); },
    get description() { return t("agent-config:managedRemoteCursorAgent_b0345fa"); },
    icon: MousePointer2,
  },
  openclaw_gateway: {
    get label() { return t("agent-config:openclawGateway_d79b54e"); },
    get description() { return t("agent-config:externalGatewayAdapter_64c62a0"); },
    icon: Bot,
    comingSoon: true,
    get disabledLabel() { return t("agent-config:inviteExternalAgentsFromTheAddAgentModal_5622891"); },
    hideFromVisualSelection: true,
  },
  process: {
    get label() { return t("agent-config:process_12f4c13"); },
    get description() { return t("agent-config:internalProcessAdapter_91a4195"); },
    icon: Cpu,
    comingSoon: true,
  },
  http: {
    get label() { return t("agent-config:http_f40b27d"); },
    get description() { return t("agent-config:internalHttpAdapter_b0b6fdb"); },
    icon: Cpu,
    comingSoon: true,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function humanizeType(type: string): string {
  // Strip known type suffixes so "droid_local" → "Droid", not "Droid Local"
  let base = type;
  for (const suffix of STRIPPED_TYPE_SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  return base.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getAdapterLabel(type: string): string {
  // Known labels are final — only unknown (plugin) types get a derived
  // suffix, so labels like "OpenClaw Gateway" don't become
  // "OpenClaw Gateway (gateway)".
  const known = adapterDisplayMap[type];
  if (known) return known.label;
  return withSuffix(humanizeType(type), getTypeSuffix(type));
}

export function getAdapterLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [type, info] of Object.entries(adapterDisplayMap)) {
    labels[type] = info.label;
  }
  return labels;
}

export function getAdapterDisplay(type: string): AdapterDisplayInfo {
  const known = adapterDisplayMap[type];
  if (known) return known;

  const suffix = getTypeSuffix(type);
  const label = withSuffix(humanizeType(type), suffix);
  return {
    label,
    description: suffix ? t("agent-config:externalValueAdapter_0257cac", { value1: suffix }) : t("agent-config:externalAdapter_f052dfc"),
    icon: Cpu,
  };
}

export function agentDisplayAdapterType(agent: { adapterType: string; adapterConfig: Record<string, unknown>; pauseReason?: unknown; metadata?: unknown }): string {
  const pendingSetup = pendingAgentSetupDisplayAdapter(agent);
  if (pendingSetup) return pendingSetup;
  if (agent.adapterType !== "paperclip_runner") return agent.adapterType;
  if (agent.adapterConfig.provider === "openai_dot" || agent.adapterConfig.provider === "grok_bot" || agent.adapterConfig.provider === "muse") {
    return agent.adapterConfig.provider;
  }
  const harness = agentHarnessType(agent.adapterType, agent.adapterConfig);
  return ["codex_local", "claude_local", "opencode_local", "pi_local", "antigravity_runtime"].includes(harness) ? harness : agent.adapterType;
}

export function isKnownAdapterType(type: string): boolean {
  return type in adapterDisplayMap;
}
