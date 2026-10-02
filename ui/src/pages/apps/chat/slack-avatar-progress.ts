import { useState } from "react";

export type SlackAvatarProgress = "uploaded" | "skipped";
function storageKey(companyId: string, endpointId: string) {
  return `paperclip:slack-avatar:v1:${companyId}:${endpointId}`;
}
function read(key: string): SlackAvatarProgress | null {
  try {
    const value = localStorage.getItem(key);
    return value === "uploaded" || value === "skipped" ? value : null;
  } catch {
    return null;
  }
}

/** A browser-local convenience, never proof of provider configuration. */
export function useSlackAvatarProgress(
  companyId: string | null,
  endpointId: string | undefined,
) {
  const key =
    companyId && endpointId ? storageKey(companyId, endpointId) : null;
  const [current, setCurrent] = useState<{
    key: string;
    value: SlackAvatarProgress;
  } | null>(null);
  const progress = key
    ? current?.key === key
      ? current.value
      : read(key)
    : null;
  const save = (value: SlackAvatarProgress) => {
    if (!key) return;
    setCurrent({ key, value });
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Optional step still works without browser storage. */
    }
  };
  return { progress, save };
}
