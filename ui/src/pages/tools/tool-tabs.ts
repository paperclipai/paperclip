import {
  Activity,
  AppWindow,
  ClipboardPaste,
  Layers,
  ScrollText,
  Server,
  Shield,
  Sparkles,
  TerminalSquare,
} from "lucide-react";

/**
 * The Advanced door is mounted under `/apps/advanced` (PAP-10862, plan D8).
 * `/tools` and `/tools/:tab` redirect here; every in-surface link is built off
 * this base so the developer door has a single canonical home.
 */
export const ADVANCED_TOOLS_BASE = "/apps/advanced";

/** Build a tab href off the Advanced base. `overview` is the bare base path. */
export function advancedTabHref(tab: ToolTabKey): string {
  return tab === "overview" ? ADVANCED_TOOLS_BASE : `${ADVANCED_TOOLS_BASE}/${tab}`;
}

export const TOOL_TABS = [
  { key: "overview", label: "Overview", icon: Activity },
  { key: "applications", label: "Applications", icon: AppWindow },
  { key: "profiles", label: "Profiles", icon: Layers },
  { key: "policies", label: "Policies", icon: Shield },
  { key: "runtime", label: "Runtime", icon: Server },
  { key: "audit", label: "Audit", icon: ScrollText },
  { key: "examples", label: "Examples", icon: Sparkles },
  // M8a/M8b — the only screens where "MCP" vocabulary is permitted (PAP-10827).
  { key: "paste-config", label: "Paste a config", icon: ClipboardPaste },
  { key: "run-your-own", label: "Run your own", icon: TerminalSquare },
] as const;

export type ToolTabKey = (typeof TOOL_TABS)[number]["key"];
