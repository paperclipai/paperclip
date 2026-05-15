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
  MousePointer2,
  Sparkles,
  Terminal,
  Cpu,
} from "lucide-react";
import { t } from "@/i18n";
import { OpenCodeLogoIcon } from "@/components/OpenCodeLogoIcon";
import { HermesIcon } from "@/components/HermesIcon";

// ---------------------------------------------------------------------------
// Type suffix parsing
// ---------------------------------------------------------------------------

const TYPE_SUFFIXES: Record<string, string> = {
  _local: "local",
  _gateway: "gateway",
};

function getTypeSuffix(type: string): string | null {
  for (const [suffix, mode] of Object.entries(TYPE_SUFFIXES)) {
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
    label: "ACPX",
    description: "Experimental local ACPX multi-agent adapter",
    icon: Bot,
    experimental: true,
    hideFromVisualSelection: true,
  },
  claude_local: {
    label: "Claude Code",
    description: "Local Claude agent",
    icon: Sparkles,
    recommended: true,
  },
  codex_local: {
    label: "Codex",
    description: "Local Codex agent",
    icon: Code,
    recommended: true,
  },
  gemini_local: {
    label: "Gemini CLI",
    description: "Local Gemini agent",
    icon: Gem,
  },
  kimi_local: {
    label: "Kimi",
    description: "Moonshot AI Kimi model via API",
    icon: Sparkles,
  },
  opencode_local: {
    label: "OpenCode",
    description: "Local multi-provider agent",
    icon: OpenCodeLogoIcon,
  },
  hermes_local: {
    label: "Hermes Agent",
    description: "Local Hermes CLI agent",
    icon: HermesIcon,
  },
  pi_local: {
    label: "Pi",
    description: "Local Pi agent",
    icon: Terminal,
  },
  cursor: {
    label: "Cursor",
    description: "Local Cursor agent",
    icon: MousePointer2,
  },
  openclaw_gateway: {
    label: "OpenClaw Gateway",
    description: "Invoke OpenClaw via gateway protocol",
    icon: Bot,
    comingSoon: true,
    disabledLabel: "Configure OpenClaw within the App",
  },
  process: {
    label: "Process",
    description: "Internal process adapter",
    icon: Cpu,
    comingSoon: true,
  },
  http: {
    label: "HTTP",
    description: "Internal HTTP adapter",
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
  for (const suffix of Object.keys(TYPE_SUFFIXES)) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  return base.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getAdapterLabel(type: string): string {
  const fallback = adapterDisplayMap[type]?.label ?? humanizeType(type);
  const key = `adapters.adapterDisplayRegistry.label.${type}`;
  const translated = t(key);
  const base = translated === key ? fallback : translated;
  return withSuffix(base, getTypeSuffix(type));
}

export function getAdapterLabels(): Record<string, string> {
  const suffixed: Record<string, string> = {};
  for (const type of Object.keys(adapterDisplayMap)) {
    suffixed[type] = getAdapterLabel(type);
  }
  return suffixed;
}

export function getAdapterDisplay(type: string): AdapterDisplayInfo {
  const known = adapterDisplayMap[type];
  if (known) {
    return {
      ...known,
      description: getAdapterDescription(type, known.description),
      disabledLabel: known.disabledLabel
        ? getAdapterDescription("adapters.adapterDisplayRegistry.disabledLabel." + type, known.disabledLabel)
        : undefined,
    };
  }

  const suffix = getTypeSuffix(type);
  const label = withSuffix(humanizeType(type), suffix);
  return {
    label,
    description: suffix
      ? t("adapters.adapterDisplayRegistry.externalSuffix", { suffix })
      : t("adapters.adapterDisplayRegistry.external"),
    icon: Cpu,
  };
}

function getAdapterDescription(_type: string, fallback: string): string {
  const key = `adapters.adapterDisplayRegistry.description.${_type}`;
  const translated = t(key);
  // i18next returns the key itself when missing; fall back to the static string.
  return translated === key ? fallback : translated;
}

export function isKnownAdapterType(type: string): boolean {
  return type in adapterDisplayMap;
}
