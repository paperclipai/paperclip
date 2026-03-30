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

export const seatPermissionOptions = PERMISSION_KEYS.map((key) => ({
  key,
  label: key,
})) as Array<{ key: string; label: string }>;
