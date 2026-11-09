import { announcementIdSchema } from "@paperclipai/shared";

const memory = new Map<string, boolean>();
export function announcementStoragePrefix(userId: string) {
  return `paperclip.announcement-dismissals.v1:${encodeURIComponent(userId)}:`;
}

export function readAnnouncementDismissals(userId: string): Map<string, boolean> {
  const prefix = announcementStoragePrefix(userId);
  const entries = new Map<string, boolean>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      const value = localStorage.getItem(key);
      if (announcementIdSchema.safeParse(id).success && (value === "pending" || value === "synced")) {
        memory.set(key, value === "pending");
      }
    }
  } catch { /* Private browsing/storage limits: retain this visit's state. */ }
  for (const [key, pending] of memory) {
    if (key.startsWith(prefix)) entries.set(key.slice(prefix.length), pending);
  }
  return entries;
}

export function saveAnnouncementDismissal(userId: string, id: string, pending: boolean): boolean {
  const key = `${announcementStoragePrefix(userId)}${id}`;
  memory.set(key, pending);
  try {
    localStorage.setItem(key, pending ? "pending" : "synced");
    return true;
  } catch { return false; }
}
