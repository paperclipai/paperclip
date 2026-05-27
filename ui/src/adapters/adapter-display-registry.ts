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
  koreanLabel?: string;
  koreanDescription?: string;
  icon: ComponentType<{ className?: string }>;
  recommended?: boolean;
  comingSoon?: boolean;
  disabledLabel?: string;
  koreanDisabledLabel?: string;
  experimental?: boolean;
  hideFromVisualSelection?: boolean;
}

type AdapterDisplayCopy = (key: string, english: string, korean: string) => string;

const adapterDisplayMap: Record<string, AdapterDisplayInfo> = {
  acpx_local: {
    label: "ACPX",
    description: "Experimental local ACPX multi-agent adapter",
    koreanDescription: "실험적 로컬 ACPX 다중 직원 어댑터",
    icon: Bot,
    experimental: true,
    hideFromVisualSelection: true,
  },
  claude_local: {
    label: "Claude Code",
    description: "Local Claude agent",
    koreanDescription: "로컬 Claude 직원",
    icon: Sparkles,
    recommended: true,
  },
  codex_local: {
    label: "Codex",
    description: "Local Codex agent",
    koreanDescription: "로컬 Codex 직원",
    icon: Code,
    recommended: true,
  },
  gemini_local: {
    label: "Gemini CLI",
    description: "Local Gemini agent",
    koreanDescription: "로컬 Gemini 직원",
    icon: Gem,
  },
  grok_local: {
    label: "Grok Build",
    description: "Local Grok Build agent",
    koreanDescription: "로컬 Grok Build 직원",
    icon: Bot,
  },
  opencode_local: {
    label: "OpenCode",
    description: "Local multi-provider agent",
    koreanDescription: "로컬 다중 제공자 직원",
    icon: OpenCodeLogoIcon,
  },
  hermes_local: {
    label: "Hermes Agent",
    description: "Local Hermes CLI agent",
    koreanLabel: "Hermes 직원",
    koreanDescription: "로컬 Hermes CLI 직원",
    icon: HermesIcon,
  },
  pi_local: {
    label: "Pi",
    description: "Local Pi agent",
    koreanDescription: "로컬 Pi 직원",
    icon: Terminal,
  },
  cursor: {
    label: "Cursor",
    description: "Local Cursor agent",
    koreanDescription: "로컬 Cursor 직원",
    icon: MousePointer2,
  },
  cursor_cloud: {
    label: "Cursor Cloud",
    description: "Managed remote Cursor agent",
    koreanDescription: "관리형 원격 Cursor 직원",
    icon: MousePointer2,
  },
  openclaw_gateway: {
    label: "OpenClaw Gateway",
    description: "External gateway adapter",
    koreanDescription: "외부 게이트웨이 어댑터",
    icon: Bot,
    comingSoon: true,
    disabledLabel: "Invite external agents from the add-agent modal",
    koreanDisabledLabel: "직원 추가 창에서 외부 직원을 초대하세요",
    hideFromVisualSelection: true,
  },
  process: {
    label: "Process",
    description: "Internal process adapter",
    koreanDescription: "내부 프로세스 어댑터",
    icon: Cpu,
    comingSoon: true,
  },
  http: {
    label: "HTTP",
    description: "Internal HTTP adapter",
    koreanDescription: "내부 HTTP 어댑터",
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

export function getLocalizedAdapterDisplay(type: string, copy: AdapterDisplayCopy): AdapterDisplayInfo {
  const display = getAdapterDisplay(type);
  const known = adapterDisplayMap[type];
  const suffix = getTypeSuffix(type);
  const fallbackKoreanDescription = suffix ? `외부 ${suffix} 어댑터` : "외부 어댑터";

  return {
    ...display,
    label: copy(
      `adapters.${type}.label`,
      display.label,
      known?.koreanLabel ?? display.label,
    ),
    description: copy(
      `adapters.${type}.description`,
      display.description,
      known?.koreanDescription ?? fallbackKoreanDescription,
    ),
    disabledLabel: display.disabledLabel
      ? copy(
        `adapters.${type}.disabledLabel`,
        display.disabledLabel,
        known?.koreanDisabledLabel ?? display.disabledLabel,
      )
      : undefined,
  };
}

export function isKnownAdapterType(type: string): boolean {
  return type in adapterDisplayMap;
}
