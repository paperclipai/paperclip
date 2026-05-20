// Primary nav zones for the `/eaos` shell.
//
// LET-506 (Multica reference adaptation, mapping doc revision 1) — the rail
// is now grouped Multica-style:
//
//   - Top section (no group label): Dashboard. Multica places Inbox + My
//     Issues at the top with no group label; the EAOS equivalent for round-1
//     is a single "Dashboard" entry covering the personal landing surface.
//   - "Workspace" group: Missions, Projects, Agents, Org, Runs, Approvals,
//     Knowledge.
//   - "Configure" group: Agent Builder, Admin (operator-gated; the rail
//     entry stays hidden for customer-member viewers per LET-503 review).
//
// LET-503 still owns:
//   - Single-noun labels (no slash labels).
//   - `Org` is a first-class route.
//   - `Kernel / Admin` is demoted out of the primary rail (it lives under
//     Admin → Legacy kernel link).
//
// Icons are sourced from `lucide-react` and are referenced by name so the
// component file can import them lazily without binding the registry to
// every consumer.

import type { LucideIcon } from "lucide-react";
import {
  BookOpenText,
  CircleCheck,
  Compass,
  FolderKanban,
  Hammer,
  Home,
  ListTodo,
  Network,
  PlayCircle,
  Settings,
  Users,
} from "lucide-react";

export type EaosNavTier = "primary";
export type EaosNavGroup = "personal" | "workspace" | "configure";

export interface EaosNavZone {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly description: string;
  readonly tier: EaosNavTier;
  readonly group: EaosNavGroup;
  readonly icon: LucideIcon;
}

const PRIMARY_ZONES: readonly EaosNavZone[] = [
  {
    id: "command-center",
    label: "Dashboard",
    path: "/eaos",
    description: "Operational summary for the current company scope.",
    tier: "primary",
    group: "personal",
    icon: Home,
  },
  {
    id: "missions",
    label: "Missions",
    path: "/eaos/missions",
    description: "Mission board and list across the current scope.",
    tier: "primary",
    group: "workspace",
    icon: ListTodo,
  },
  {
    id: "projects",
    label: "Projects",
    path: "/eaos/projects",
    description: "Strategic work, projects, and goals.",
    tier: "primary",
    group: "workspace",
    icon: FolderKanban,
  },
  {
    id: "agents",
    label: "Agents",
    path: "/eaos/agents",
    description: "Agent roster with status, runtime, and recent activity.",
    tier: "primary",
    group: "workspace",
    icon: Users,
  },
  {
    id: "org",
    label: "Org",
    path: "/eaos/org",
    description: "Company, teams, and agent structure.",
    tier: "primary",
    group: "workspace",
    icon: Network,
  },
  {
    id: "runs",
    label: "Runs",
    path: "/eaos/runs",
    description: "Execution history and failure triage.",
    tier: "primary",
    group: "workspace",
    icon: PlayCircle,
  },
  {
    id: "approvals",
    label: "Approvals",
    path: "/eaos/approvals",
    description: "Decisions and risk queue.",
    tier: "primary",
    group: "workspace",
    icon: CircleCheck,
  },
  {
    id: "knowledge",
    label: "Knowledge",
    path: "/eaos/knowledge",
    description: "Playbooks, docs, citations, and evidence.",
    tier: "primary",
    group: "workspace",
    icon: BookOpenText,
  },
  {
    id: "blueprints",
    label: "Agent Builder",
    path: "/eaos/blueprints",
    description: "Blueprints catalog and detail workbench.",
    tier: "primary",
    group: "configure",
    icon: Hammer,
  },
  {
    id: "admin",
    label: "Admin",
    path: "/eaos/admin",
    description: "Users, roles, integrations, audit, and legacy kernel link.",
    tier: "primary",
    group: "configure",
    icon: Settings,
  },
] as const;

export const EAOS_PRIMARY_NAV_ZONES: readonly EaosNavZone[] = PRIMARY_ZONES;

// Combined zone list used by the router (App.tsx) and shell tests as the
// canonical iteration source. Kept for downstream import compatibility.
export const EAOS_PRIMARY_NAV: readonly EaosNavZone[] = PRIMARY_ZONES;

// Group metadata + ordering for the sidebar. The `personal` group renders
// without a heading label (matching Multica) so the Dashboard sits flush at
// the top under the search/new-mission header.
export const EAOS_NAV_GROUPS: ReadonlyArray<{
  id: EaosNavGroup;
  label: string | null;
}> = [
  { id: "personal", label: null },
  { id: "workspace", label: "Workspace" },
  { id: "configure", label: "Configure" },
];

// Legacy nav entry kept so secret-sweep tests and the `Admin → Legacy kernel`
// link can still reach the kernel/admin console. NOT rendered in the primary
// rail anymore — Admin owns the link per LET-502 §2.
export const EAOS_KERNEL_NAV = {
  id: "kernel-admin",
  label: "Legacy kernel",
  path: "/dashboard",
  description: "Legacy Paperclip kernel/admin/debug console (current company scope).",
  tier: "primary",
  group: "configure",
  icon: Compass,
} as const satisfies EaosNavZone;

export const EAOS_ALL_NAV_PATHS: readonly string[] = [
  ...EAOS_PRIMARY_NAV.map((zone) => zone.path),
  EAOS_KERNEL_NAV.path,
];

// Capabilities / Sandbox previously had primary-rail entries. They remain
// reachable surfaces (capabilities/MCP wiring, sandbox/runtime config) but
// are now accessed from Admin or Agent Builder rather than the primary rail
// per LET-502 §2 (single-level nav, no marketing-style zone duplication).
export const EAOS_LEGACY_SECONDARY_PATHS = [
  "/eaos/capabilities",
  "/eaos/sandbox",
] as const;
