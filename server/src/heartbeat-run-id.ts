import { isUuidLike } from "@paperclipai/shared";

export function normalizeHeartbeatRunId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return isUuidLike(trimmed) ? trimmed : null;
}
