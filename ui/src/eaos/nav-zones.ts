// Primary nav zones for the `/eaos` shell. Order tracks LET-164
// `command-center-shell-ia` rev 1 §4 and the LET-459 IA grouping rule —
// operator-visible path is the small "primary" tier (Command Center,
// Missions, Agents/Teams, Approvals/Risk, Knowledge/Playbooks); admin
// /build zones (Projects/Goals, Runs/Observability, Capabilities/MCP,
// Sandbox/Runtime, Admin/Security) remain accessible but demoted into a
// secondary tier so the default screen is not 10 equal links plus the
// Kernel escape hatch.

export type EaosNavTier = "primary" | "secondary";

export interface EaosNavZone {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly description: string;
  readonly stubCount: number;
  readonly tier: EaosNavTier;
}

// Primary operator path — LET-459 §"IA principle: two product modes".
const PRIMARY_ZONES: readonly EaosNavZone[] = [
  {
    id: "command-center",
    label: "Command Center",
    path: "/eaos",
    description: "Role-aware landing dashboard for the current scope.",
    stubCount: 0,
    tier: "primary",
  },
  {
    id: "missions",
    label: "Missions",
    path: "/eaos/missions",
    description: "Mission list, saved views, and active mission detail.",
    stubCount: 0,
    tier: "primary",
  },
  {
    id: "agents-teams",
    label: "Agents / Teams",
    path: "/eaos/agents",
    description: "Org chart, roster, agent detail, capability summary.",
    stubCount: 0,
    tier: "primary",
  },
  {
    id: "approvals-risk",
    label: "Approvals / Risk",
    path: "/eaos/approvals",
    description: "Pending approvals, risk queue, decision history.",
    stubCount: 0,
    tier: "primary",
  },
  {
    id: "knowledge-playbooks",
    label: "Knowledge / Playbooks",
    path: "/eaos/knowledge",
    description: "Design docs, validation contracts, playbooks.",
    stubCount: 0,
    tier: "primary",
  },
] as const;

// Build / admin tier — kept inside the shell so admins/builders can still
// reach Projects/Goals, Runs/Observability, Capabilities/MCP, Sandbox/
// Runtime, and Admin/Security without a routing detour, but rendered
// below a divider so the operator path stays calm.
const SECONDARY_ZONES: readonly EaosNavZone[] = [
  {
    id: "projects-goals",
    label: "Projects / Goals",
    path: "/eaos/projects",
    description: "Strategic outcomes, roadmaps, release candidates.",
    stubCount: 0,
    tier: "secondary",
  },
  {
    id: "runs-observability",
    label: "Runs / Observability",
    path: "/eaos/runs",
    description: "Runs, transcripts, tool calls, replay timelines.",
    stubCount: 0,
    tier: "secondary",
  },
  {
    id: "capabilities-mcp",
    label: "Capabilities / MCP",
    path: "/eaos/capabilities",
    description: "Capability packages, desired/effective config.",
    stubCount: 0,
    tier: "secondary",
  },
  {
    id: "sandbox-runtime",
    label: "Sandbox / Runtime",
    path: "/eaos/sandbox",
    description: "Runtime leases, environments, logs, artifacts.",
    stubCount: 0,
    tier: "secondary",
  },
  {
    id: "admin-security",
    label: "Admin / Security",
    path: "/eaos/admin",
    description: "Users, roles, audit, policies, integrations.",
    stubCount: 0,
    tier: "secondary",
  },
] as const;

export const EAOS_PRIMARY_NAV_ZONES: readonly EaosNavZone[] = PRIMARY_ZONES;
export const EAOS_SECONDARY_NAV_ZONES: readonly EaosNavZone[] = SECONDARY_ZONES;

// Combined zone list. Order is operator-first, builder/admin second — used
// by the router (App.tsx) and the shell tests as the canonical iteration
// source. Existing consumers can keep importing `EAOS_PRIMARY_NAV`; the
// rendering tier is encoded on each entry via `tier`.
export const EAOS_PRIMARY_NAV: readonly EaosNavZone[] = [
  ...PRIMARY_ZONES,
  ...SECONDARY_ZONES,
];

// Below-divider link to the kernel/admin/debug console (legacy Paperclip
// pages). LET-164 §4 keeps this visible to operator/engineer/admin roles
// with a chip indicating the surface posture.
export const EAOS_KERNEL_NAV = {
  id: "kernel-admin",
  label: "Kernel / Admin",
  path: "/dashboard",
  description: "Legacy Paperclip kernel/admin/debug console (current company scope).",
  stubCount: 0,
  tier: "secondary",
} as const satisfies EaosNavZone;

export const EAOS_ALL_NAV_PATHS: readonly string[] = [
  ...EAOS_PRIMARY_NAV.map((zone) => zone.path),
  EAOS_KERNEL_NAV.path,
];
