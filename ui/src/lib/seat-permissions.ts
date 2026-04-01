import type { PermissionKey } from "@paperclipai/shared";
import { PERMISSION_KEYS } from "@paperclipai/shared";
import { formatMessage } from "../i18n";
import { getRuntimeLocale } from "../i18n/runtime";

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

const LABEL_KEYS: Record<string, string> = {
  "agents:create": "seatPermissions.createAgents",
  "users:invite": "seatPermissions.inviteUsers",
  "users:manage_permissions": "seatPermissions.managePermissions",
  "tasks:assign": "seatPermissions.assignTasks",
  "tasks:assign_scope": "seatPermissions.assignTasksInScope",
  "joins:approve": "seatPermissions.approveJoins",
};

export function getSeatPermissionOptions() {
  const locale = getRuntimeLocale();
  return PERMISSION_KEYS.map((key) => ({
    key,
    label: formatMessage(locale, LABEL_KEYS[key] ?? key),
  })) as Array<{ key: PermissionKey; label: string }>;
}
