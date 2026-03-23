import type { PermissionKey, ProjectPermissionKey } from "./constants.js";

export interface RolePreset {
  id: string;
  label: string;
  description: string;
  permissions: PermissionKey[];
}

export const ROLE_PRESETS: RolePreset[] = [
  {
    id: "owner",
    label: "Owner",
    description: "Full access to all company features",
    permissions: [
      "agents:create",
      "users:invite",
      "users:manage_permissions",
      "tasks:assign",
      "tasks:assign_scope",
      "joins:approve",
      "projects:manage",
      "goals:manage",
      "secrets:manage",
      "credentials:manage",
      "company:settings",
      "company:export",
      "approvals:review",
      "issues:manage",
    ],
  },
  {
    id: "admin",
    label: "Admin",
    description: "Manage agents, issues, projects, and team members",
    permissions: [
      "agents:create",
      "users:invite",
      "users:manage_permissions",
      "tasks:assign",
      "joins:approve",
      "projects:manage",
      "goals:manage",
      "approvals:review",
      "issues:manage",
    ],
  },
  {
    id: "member",
    label: "Member",
    description: "Create and manage issues, assign tasks",
    permissions: [
      "tasks:assign",
      "projects:manage",
      "goals:manage",
      "approvals:review",
      "issues:manage",
    ],
  },
  {
    id: "viewer",
    label: "Viewer",
    description: "Read-only access to company data",
    permissions: [],
  },
];

/** Map agent roles to default permission grants */
export const AGENT_ROLE_DEFAULT_PERMISSIONS: Record<string, PermissionKey[]> = {
  ceo: [
    "agents:create",
    "tasks:assign",
    "tasks:assign_scope",
    "projects:manage",
    "goals:manage",
    "approvals:review",
    "issues:manage",
  ],
  cto: [
    "agents:create",
    "tasks:assign",
    "projects:manage",
    "goals:manage",
    "issues:manage",
  ],
  cmo: [
    "tasks:assign",
    "projects:manage",
    "goals:manage",
    "issues:manage",
  ],
  cfo: [
    "tasks:assign",
    "projects:manage",
    "goals:manage",
    "issues:manage",
  ],
  pm: [
    "tasks:assign",
    "projects:manage",
    "goals:manage",
    "issues:manage",
  ],
  engineer: [
    "tasks:assign",
    "issues:manage",
  ],
  qa: [
    "tasks:assign",
    "issues:manage",
  ],
  devops: [
    "tasks:assign",
    "issues:manage",
  ],
  designer: [
    "issues:manage",
  ],
  researcher: [
    "issues:manage",
  ],
  general: [
    "issues:manage",
  ],
};

export interface ProjectRolePreset {
  id: string;
  label: string;
  description: string;
  permissions: ProjectPermissionKey[];
}

export const PROJECT_ROLE_PRESETS: ProjectRolePreset[] = [
  {
    id: "super_admin",
    label: "Super Admin",
    description: "Full project control including member management",
    permissions: [
      "project:view",
      "project:issues:create",
      "project:issues:edit",
      "project:issues:delete",
      "project:issues:assign",
      "project:agents:use",
      "project:settings",
      "project:members:manage",
    ],
  },
  {
    id: "admin",
    label: "Admin",
    description: "Full project access except member management",
    permissions: [
      "project:view",
      "project:issues:create",
      "project:issues:edit",
      "project:issues:delete",
      "project:issues:assign",
      "project:agents:use",
      "project:settings",
    ],
  },
  {
    id: "editor",
    label: "Editor",
    description: "Create, edit, and assign issues; use agents",
    permissions: [
      "project:view",
      "project:issues:create",
      "project:issues:edit",
      "project:issues:assign",
      "project:agents:use",
    ],
  },
  {
    id: "viewer",
    label: "Viewer",
    description: "Read-only access to project",
    permissions: [
      "project:view",
    ],
  },
];
