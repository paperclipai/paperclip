import type { PermissionKey } from "@paperclipai/shared";
import { PERMISSION_KEYS } from "@paperclipai/shared";

export function formatDelegatedPermissions(values: string[]): string {
  return values.join(", ");
}

export function parseDelegatedPermissions(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

const LABELS: Record<string, string> = {
  "agents:create": "Create agents",
  "users:invite": "Invite users",
  "users:manage_permissions": "Manage permissions",
  "tasks:assign": "Assign tasks",
  "tasks:assign_scope": "Assign tasks in scope",
  "joins:approve": "Approve joins",
};

export const seatPermissionOptions = PERMISSION_KEYS.map((key) => ({
  key,
  label: LABELS[key] ?? key,
})) as Array<{ key: PermissionKey; label: string }>;
