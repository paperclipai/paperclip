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
  Cpu,
} from "lucide-react";
import { OpenCodeLogoIcon } from "@/components/OpenCodeLogoIcon";
import { HermesIcon } from "@/components/HermesIcon";
import { ClaudeCodeLogoIcon } from "@/components/ClaudeCodeLogoIcon";
import { CodexLogoIcon } from "@/components/CodexLogoIcon";
import { GeminiCliLogoIcon } from "@/components/GeminiCliLogoIcon";
import { CursorLogoIcon } from "@/components/CursorLogoIcon";
import { PiLogoIcon } from "@/components/PiLogoIcon";

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
}

const adapterDisplayMap: Record<string, AdapterDisplayInfo> = {
  claude_local: {
    label: "Claude Code",
    description: "Local Claude agent",
    icon: ClaudeCodeLogoIcon,
    recommended: true,
  },
  codex_local: {
    label: "Codex",
    description: "Local Codex agent",
    icon: CodexLogoIcon,
    recommended: true,
  },
  gemini_local: {
    label: "Gemini CLI",
    description: "Local Gemini agent",
    icon: GeminiCliLogoIcon,
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
    icon: PiLogoIcon,
  },
  cursor: {
    label: "Cursor",
    description: "Local Cursor agent",
    icon: CursorLogoIcon,
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
  const base = adapterDisplayMap[type]?.label ?? humanizeType(type);
  return withSuffix(base, getTypeSuffix(type));
}

export function getAdapterLabels(): Record<string, string> {
  const suffixed: Record<string, string> = {};
  for (const [type, info] of Object.entries(adapterDisplayMap)) {
    suffixed[type] = withSuffix(info.label, getTypeSuffix(type));
  }
  return suffixed;
}

export function getAdapterDisplay(type: string): AdapterDisplayInfo {
  const known = adapterDisplayMap[type];
  if (known) return known;

  const suffix = getTypeSuffix(type);
  const label = withSuffix(humanizeType(type), suffix);
  return {
    label,
    description: suffix ? `External ${suffix} adapter` : "External adapter",
    icon: Cpu,
  };
}

export function isKnownAdapterType(type: string): boolean {
  return type in adapterDisplayMap;
}
