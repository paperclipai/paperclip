// Primary nav zones for the `/eaos` shell.
//
// LET-503 design correction (LET-502 contract §2): single-noun labels only,
// no slash labels, `Org` is a first-class route, and `Kernel / Admin` is
// demoted out of the primary rail (it now lives under Admin → Legacy
// kernel link). The two-tier system from LET-459 is collapsed into one
// list so the default left rail looks single-level per contract §2.

export type EaosNavTier = "primary";

export interface EaosNavZone {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly description: string;
  readonly tier: EaosNavTier;
}

// Single, calm operator path. Order matches contract §2 "Required labels".
const PRIMARY_ZONES: readonly EaosNavZone[] = [
  {
    id: "command-center",
    label: "Dashboard",
    path: "/eaos",
    description: "Operational summary for the current company scope.",
    tier: "primary",
  },
  {
    id: "missions",
    label: "Missions",
    path: "/eaos/missions",
    description: "Mission board and list across the current scope.",
    tier: "primary",
  },
  {
    id: "agents",
    label: "Agents",
    path: "/eaos/agents",
    description: "Agent roster with status, runtime, and recent activity.",
    tier: "primary",
  },
  {
    id: "org",
    label: "Org",
    path: "/eaos/org",
    description: "Company, teams, and agent structure.",
    tier: "primary",
  },
  {
    id: "projects",
    label: "Projects",
    path: "/eaos/projects",
    description: "Strategic work, projects, and goals.",
    tier: "primary",
  },
  {
    id: "runs",
    label: "Runs",
    path: "/eaos/runs",
    description: "Execution history and failure triage.",
    tier: "primary",
  },
  {
    id: "approvals",
    label: "Approvals",
    path: "/eaos/approvals",
    description: "Decisions and risk queue.",
    tier: "primary",
  },
  {
    id: "knowledge",
    label: "Knowledge",
    path: "/eaos/knowledge",
    description: "Playbooks, docs, citations, and evidence.",
    tier: "primary",
  },
  {
    id: "blueprints",
    label: "Agent Builder",
    path: "/eaos/blueprints",
    description: "Blueprints catalog and detail workbench.",
    tier: "primary",
  },
  {
    id: "admin",
    label: "Admin",
    path: "/eaos/admin",
    description: "Users, roles, integrations, audit, and legacy kernel link.",
    tier: "primary",
  },
] as const;

export const EAOS_PRIMARY_NAV_ZONES: readonly EaosNavZone[] = PRIMARY_ZONES;

// Combined zone list used by the router (App.tsx) and shell tests as the
// canonical iteration source. Kept for downstream import compatibility.
export const EAOS_PRIMARY_NAV: readonly EaosNavZone[] = PRIMARY_ZONES;

// Legacy nav entry kept so secret-sweep tests and the `Admin → Legacy kernel`
// link can still reach the kernel/admin console. NOT rendered in the primary
// rail anymore — Admin owns the link per LET-502 §2.
export const EAOS_KERNEL_NAV = {
  id: "kernel-admin",
  label: "Legacy kernel",
  path: "/dashboard",
  description: "Legacy Paperclip kernel/admin/debug console (current company scope).",
  tier: "primary",
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
