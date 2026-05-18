// Primary nav zones for the `/eaos` shell. Order and labels track LET-164
// `command-center-shell-ia` rev 1 §4.

export interface EaosNavZone {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly description: string;
  readonly stubCount: number;
}

export const EAOS_PRIMARY_NAV = [
  {
    id: "command-center",
    label: "Command Center",
    path: "/eaos",
    description: "Role-aware landing dashboard for the current scope.",
    stubCount: 0,
  },
  {
    id: "projects-goals",
    label: "Projects / Goals",
    path: "/eaos/projects",
    description: "Strategic outcomes, roadmaps, release candidates.",
    stubCount: 0,
  },
  {
    id: "missions",
    label: "Missions",
    path: "/eaos/missions",
    description: "Mission-control list, tree, and saved views.",
    stubCount: 0,
  },
  {
    id: "agents-teams",
    label: "Agents / Teams",
    path: "/eaos/agents",
    description: "Org chart, roster, agent detail, capability summary.",
    stubCount: 0,
  },
  {
    id: "runs-observability",
    label: "Runs / Observability",
    path: "/eaos/runs",
    description: "Runs, transcripts, tool calls, replay timelines.",
    stubCount: 0,
  },
  {
    id: "approvals-risk",
    label: "Approvals / Risk",
    path: "/eaos/approvals",
    description: "Pending approvals, risk queue, decision history.",
    stubCount: 0,
  },
  {
    id: "capabilities-mcp",
    label: "Capabilities / MCP",
    path: "/eaos/capabilities",
    description: "Capability packages, desired/effective config.",
    stubCount: 0,
  },
  {
    id: "sandbox-runtime",
    label: "Sandbox / Runtime",
    path: "/eaos/sandbox",
    description: "Runtime leases, environments, logs, artifacts.",
    stubCount: 0,
  },
  {
    id: "knowledge-playbooks",
    label: "Knowledge / Playbooks",
    path: "/eaos/knowledge",
    description: "Design docs, validation contracts, playbooks.",
    stubCount: 0,
  },
  {
    id: "admin-security",
    label: "Admin / Security",
    path: "/eaos/admin",
    description: "Users, roles, audit, policies, integrations.",
    stubCount: 0,
  },
] as const satisfies readonly EaosNavZone[];

// Below-divider link to the kernel/admin/debug console (legacy Paperclip
// pages). LET-164 §4 keeps this visible to operator/engineer/admin roles
// with a chip indicating the surface posture. We point at the existing
// `/dashboard` board route (the Paperclip kernel landing) rather than a
// dedicated `/k/*` namespace — the unprefixed redirect/company prefix in
// App.tsx routes operators to the legacy console under the current scope.
export const EAOS_KERNEL_NAV = {
  id: "kernel-admin",
  label: "Kernel / Admin",
  path: "/dashboard",
  description: "Legacy Paperclip kernel/admin/debug console (current company scope).",
  stubCount: 0,
} as const satisfies EaosNavZone;

export const EAOS_ALL_NAV_PATHS: readonly string[] = [
  ...EAOS_PRIMARY_NAV.map((zone) => zone.path),
  EAOS_KERNEL_NAV.path,
];
