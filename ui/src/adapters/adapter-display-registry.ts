import { t } from "@/i18n";
/**
 * Single source of truth for adapter display metadata.
 *
 * Built-in adapters have entries in `adapterDisplayMap`. External (plugin)
 * adapters get sensible defaults derived from their type string via
 * `getAdapterDisplay()`.
 */
import type { ComponentType } from "react";
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
  get _gateway() { return t("localizationAgents.gatewaySuffix"); },
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
  acpx_local: {
    get label() { return t("localizationAgents.retiredAcpx"); },
    get description() { return t("localizationAgents.retiredAcpxDescription"); },
    icon: Bot,
    comingSoon: true,
    get disabledLabel() { return t("localizationAgents.useAcpEngine"); },
    hideFromVisualSelection: true,
  },
  claude_local: {
    label: "Claude Code",
    get description() { return t("localizationAgents.claudeHarness"); },
    icon: Sparkles,
    recommended: true,
  },
  codex_local: {
    label: "Codex",
    get description() { return t("localizationAgents.codexHarness"); },
    icon: Code,
    recommended: true,
  },
  paperclip_runner: {
    label: "Paperclip Runner",
    get description() { return t("localizationAgents.rustRunner"); },
    icon: Cpu,
    experimental: true,
  },
  gemini_local: {
    label: "Gemini CLI",
    get description() { return t("localizationAgents.geminiHarness"); },
    icon: Gem,
  },
  grok_local: {
    label: "Grok Build",
    get description() { return t("localizationAgents.grokHarness"); },
    icon: Bot,
  },
  kimi_local: {
    label: "Kimi Code",
    get description() { return t("localizationAgents.kimiHarness"); },
    icon: Moon,
  },
  hermes_gateway: {
    label: "Hermes Gateway",
    get description() { return t("localizationAgents.hermesApi"); },
    icon: Bot,
    hideFromVisualSelection: true,
  },
  hermes_local: {
    label: "Hermes",
    get description() { return t("localizationAgents.hermesHarness"); },
    icon: Bot,
  },
  opencode_local: {
    label: "OpenCode",
    get description() { return t("localizationAgents.opencodeHarness"); },
    icon: OpenCodeLogoIcon,
  },
  pi_local: {
    label: "Pi",
    get description() { return t("localizationAgents.piHarness"); },
    icon: Terminal,
  },
  cursor: {
    label: "Cursor",
    get description() { return t("localizationAgents.cursorHarness"); },
    icon: MousePointer2,
  },
  cursor_cloud: {
    label: "Cursor Cloud",
    get description() { return t("localizationAgents.cursorCloud"); },
    icon: MousePointer2,
  },
  openclaw_gateway: {
    label: "OpenClaw Gateway",
    get description() { return t("localizationAgents.externalGateway"); },
    icon: Bot,
    comingSoon: true,
    get disabledLabel() { return t("localizationAgents.inviteExternalAgents"); },
    hideFromVisualSelection: true,
  },
  process: {
    get label() { return t("localizationAgents.processAdapter"); },
    get description() { return t("localizationAgents.internalProcess"); },
    icon: Cpu,
    comingSoon: true,
  },
  http: {
    label: "HTTP",
    get description() { return t("localizationAgents.internalHttp"); },
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
    Object.defineProperty(labels, type, { enumerable: true, get: () => info.label });
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
    description: suffix ? t("localizationAgents.externalAdapterType", { suffix }) : t("localizationAgents.externalAdapter"),
    icon: Cpu,
  };
}

export function isKnownAdapterType(type: string): boolean {
  return type in adapterDisplayMap;
}
