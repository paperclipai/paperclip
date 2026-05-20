// Primary nav zones for the `/eaos` shell.
//
// LET-513 (customer/operator gating, contract §4) — the rail surfaces only
// what an ordinary user should see:
//
//   - Customer-visible zones (always): Dashboard, Missions, Projects,
//     Agents, Runs, Knowledge.
//   - Operator-only zones (filtered out of the rail for customer-member
//     viewers AND blocked at the route level by `RequireOperator`): Org,
//     Approvals, Capabilities, Blueprints (Agent Builder), Admin.
//
// LET-506 (Multica reference adaptation) keeps the rail grouped:
//
//   - Top section (no group label): Dashboard.
//   - "Workspace" group: customer-visible workspace surfaces + operator
//     additions (Org, Approvals).
//   - "Configure" group: Agent Builder + Admin (operator-only).
//
// LET-503 still owns:
//   - Single-noun labels (no slash labels).
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
  // LET-513 §4 — when true, the rail filters this zone out for
  // customer-member viewers and the route is wrapped in `RequireOperator`
  // so direct-URL access also fails closed.
  readonly operatorOnly?: boolean;
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
    operatorOnly: true,
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
    operatorOnly: true,
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
    operatorOnly: true,
  },
  {
    id: "admin",
    label: "Admin",
    path: "/eaos/admin",
    description: "Users, roles, integrations, audit, and legacy kernel link.",
    tier: "primary",
    group: "configure",
    icon: Settings,
    operatorOnly: true,
  },
] as const;

export const EAOS_PRIMARY_NAV_ZONES: readonly EaosNavZone[] = PRIMARY_ZONES;

// LET-513 §4 — single source of truth for which zones are operator-only.
// The rail filters against this set, and the route guard in App.tsx
// (`RequireOperator`) cross-checks the path against this same list so a
// direct URL hit also fails closed for customer-member viewers.
export const EAOS_OPERATOR_ONLY_ZONE_IDS: ReadonlySet<string> = new Set(
  PRIMARY_ZONES.filter((zone) => zone.operatorOnly === true).map((zone) => zone.id),
);
export const EAOS_OPERATOR_ONLY_PATHS: ReadonlySet<string> = new Set(
  PRIMARY_ZONES.filter((zone) => zone.operatorOnly === true).map((zone) => zone.path),
);

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
