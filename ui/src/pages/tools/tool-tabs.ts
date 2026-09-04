import {
  ClipboardPaste,
  FlaskConical,
  Layers,
  Network,
} from "lucide-react";

/**
 * The Advanced door is mounted under `/apps/advanced` (PAP-10862, plan D8).
 * `/tools` and `/tools/:tab` redirect here; every in-surface link is built off
 * this base so the developer door has a single canonical home.
 */
export const ADVANCED_TOOLS_BASE = "/apps/advanced";

/** Build a tab href off the Advanced base. */
export function advancedTabHref(tab: ToolTabKey): string {
  return `${ADVANCED_TOOLS_BASE}/${tab}`;
}

// M8a/M8b — the prosumer-facing Advanced setup tabs (PAP-10839 wires). The only
// screens where "MCP" vocabulary is permitted (PAP-10827).
export const ADVANCED_TABS = [
  { key: "paste-config", label: "Paste a config", icon: ClipboardPaste },
] as const;

// The pre-Apps developer surface, kept reachable behind the Advanced door.
// `smoke-lab` (PAP-13343 / S2) is experimental — hidden from the sidebar unless
// `experimental.enableSmokeLab` is on (see `isExperimentalToolTab` +
// `useSmokeLabEnabled`), and the route/tab itself gates on the same flag.
export const DEVELOPER_TABS = [
  { key: "gateways", label: "Gateways", icon: Network },
  { key: "profiles", label: "Profiles", icon: Layers },
  { key: "smoke-lab", label: "Smoke Lab", icon: FlaskConical },
] as const;

export const TOOL_TABS = [...ADVANCED_TABS, ...DEVELOPER_TABS] as const;

export type ToolTabKey = (typeof TOOL_TABS)[number]["key"];

export function isAdvancedSetupTab(tab: ToolTabKey): boolean {
  return ADVANCED_TABS.some((t) => t.key === tab);
}

/** Developer tabs hidden behind an experimental flag (gated in the sidebar). */
export function isExperimentalToolTab(tab: ToolTabKey): boolean {
  return tab === "smoke-lab";
}
