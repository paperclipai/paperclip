import {
  Activity,
  AppWindow,
  Layers,
  ScrollText,
  Server,
  Shield,
  Sparkles,
} from "lucide-react";

export const TOOL_TABS = [
  { key: "overview", label: "Overview", icon: Activity },
  { key: "applications", label: "Applications", icon: AppWindow },
  { key: "profiles", label: "Profiles", icon: Layers },
  { key: "policies", label: "Policies", icon: Shield },
  { key: "runtime", label: "Runtime", icon: Server },
  { key: "audit", label: "Audit", icon: ScrollText },
  { key: "examples", label: "Examples", icon: Sparkles },
] as const;

export type ToolTabKey = (typeof TOOL_TABS)[number]["key"];
