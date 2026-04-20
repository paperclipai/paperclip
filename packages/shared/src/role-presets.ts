import type { ProjectPermissionKey } from "./constants.js";

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
    permissions: ["project:view"],
  },
];
