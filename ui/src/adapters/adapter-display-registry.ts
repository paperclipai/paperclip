/**
 * Single source of truth for adapter display metadata.
 *
 * Built-in adapters have entries in `adapterDisplayMap`. External (plugin)
 * adapters get sensible defaults derived from their type string via
 * `getAdapterDisplay()`.
 */
import type { ComponentType } from "react";
import { t } from "@/i18n";
import {
  Bot,
  Code,
  Gem,
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

interface AdapterDisplayEntry {
  label: string;
  descriptionKey: string;
  icon: ComponentType<{ className?: string }>;
  recommended?: boolean;
  comingSoon?: boolean;
  disabledLabelKey?: string;
  experimental?: boolean;
  hideFromVisualSelection?: boolean;
}

const adapterDisplayMap: Record<string, AdapterDisplayEntry> = {
  acpx_local: {
    label: "ACPX (retired)",
    descriptionKey: "adapterDisplay.acpxRetired",
    icon: Bot,
    comingSoon: true,
    disabledLabelKey: "adapterDisplay.acpxDisabledLabel",
    hideFromVisualSelection: true,
  },
  claude_local: {
    label: "Claude Code",
    descriptionKey: "adapterDisplay.claudeCodeHarness",
    icon: Sparkles,
    recommended: true,
  },
  codex_local: {
    label: "Codex",
    descriptionKey: "adapterDisplay.codexHarness",
    icon: Code,
    recommended: true,
  },
  gemini_local: {
    label: "Gemini CLI",
    descriptionKey: "adapterDisplay.geminiHarness",
    icon: Gem,
  },
  grok_local: {
    label: "Grok Build",
    descriptionKey: "adapterDisplay.grokHarness",
    icon: Bot,
  },
  hermes_gateway: {
    label: "Hermes Gateway",
    descriptionKey: "adapterDisplay.hermesGatewayServer",
    icon: Bot,
    hideFromVisualSelection: true,
  },
  hermes_local: {
    label: "Hermes",
    descriptionKey: "adapterDisplay.hermesHarness",
    icon: Bot,
  },
  opencode_local: {
    label: "OpenCode",
    descriptionKey: "adapterDisplay.opencodeHarness",
    icon: OpenCodeLogoIcon,
  },
  pi_local: {
    label: "Pi",
    descriptionKey: "adapterDisplay.piHarness",
    icon: Terminal,
  },
  cursor: {
    label: "Cursor",
    descriptionKey: "adapterDisplay.cursorHarness",
    icon: MousePointer2,
  },
  cursor_cloud: {
    label: "Cursor Cloud",
    descriptionKey: "adapterDisplay.cursorCloudAgent",
    icon: MousePointer2,
  },
  openclaw_gateway: {
    label: "OpenClaw Gateway",
    descriptionKey: "adapterDisplay.externalGateway",
    icon: Bot,
    comingSoon: true,
    disabledLabelKey: "adapterDisplay.gatewayDisabledLabel",
    hideFromVisualSelection: true,
  },
  process: {
    label: "Process",
    descriptionKey: "adapterDisplay.internalProcess",
    icon: Cpu,
    comingSoon: true,
  },
  http: {
    label: "HTTP",
    descriptionKey: "adapterDisplay.internalHttp",
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
  if (known) {
    return {
      label: known.label,
      description: t(known.descriptionKey),
      icon: known.icon,
      recommended: known.recommended,
      comingSoon: known.comingSoon,
      experimental: known.experimental,
      hideFromVisualSelection: known.hideFromVisualSelection,
      ...(known.disabledLabelKey ? { disabledLabel: t(known.disabledLabelKey) } : {}),
    };
  }

  const suffix = getTypeSuffix(type);
  const label = withSuffix(humanizeType(type), suffix);
  return {
    label,
    description: suffix ? t("adapterDisplay.externalSuffix", { suffix }) : t("adapterDisplay.external"),
    icon: Cpu,
  };
}

export function isKnownAdapterType(type: string): boolean {
  return type in adapterDisplayMap;
}
