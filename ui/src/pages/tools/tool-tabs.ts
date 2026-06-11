import {
  AppWindow,
  ClipboardPaste,
  Layers,
  ScrollText,
  Server,
  Shield,
  TerminalSquare,
} from "lucide-react";

/**
 * The Advanced door is mounted under `/apps/advanced` (PAP-10862, plan D8).
 * `/tools` and `/tools/:tab` redirect here; every in-surface link is built off
 * this base so the developer door has a single canonical home.
 */
export const ADVANCED_TOOLS_BASE = "/apps/advanced";

/** Build a tab href off the Advanced base. `run-your-own` is the bare base path (the door's default tab). */
export function advancedTabHref(tab: ToolTabKey): string {
  return tab === "run-your-own" ? ADVANCED_TOOLS_BASE : `${ADVANCED_TOOLS_BASE}/${tab}`;
}

// M8a/M8b — the prosumer-facing Advanced setup tabs (PAP-10839 wires). The only
// screens where "MCP" vocabulary is permitted (PAP-10827).
export const ADVANCED_TABS = [
  { key: "run-your-own", label: "Run your own", icon: TerminalSquare },
  { key: "paste-config", label: "Paste a config", icon: ClipboardPaste },
] as const;

// The pre-Apps developer surface, kept reachable behind the Advanced door.
export const DEVELOPER_TABS = [
  { key: "applications", label: "Applications", icon: AppWindow },
  { key: "profiles", label: "Profiles", icon: Layers },
  { key: "policies", label: "Policies", icon: Shield },
  { key: "runtime", label: "Runtime", icon: Server },
  { key: "audit", label: "Audit", icon: ScrollText },
] as const;

export const TOOL_TABS = [...ADVANCED_TABS, ...DEVELOPER_TABS] as const;

export type ToolTabKey = (typeof TOOL_TABS)[number]["key"];

export function isAdvancedSetupTab(tab: ToolTabKey): boolean {
  return ADVANCED_TABS.some((t) => t.key === tab);
}
