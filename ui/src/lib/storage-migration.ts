/**
 * One-time migration of localStorage keys from paperclip.* to raava.*.
 * Call during app initialization. Best-effort — never crashes the app.
 */
const MIGRATED_FLAG = "raava:storage-migrated";

export function migrateLocalStorageKeys(): void {
  if (typeof window === "undefined") return;

  let storage: Storage;
  try {
    storage = window.localStorage;
    if (storage.getItem(MIGRATED_FLAG)) return;
  } catch {
    // localStorage unavailable (e.g., private browsing, iframe sandbox)
    return;
  }

  try {
    const migrations: [string, string][] = [
      ["paperclip.theme", "raava.theme"],
      ["paperclip.selectedCompanyId", "raava.selectedCompanyId"],
      ["paperclip.companyOrder", "raava.companyOrder"],
      ["paperclip.companyPaths", "raava.companyPaths"],
      ["paperclip:panel-visible", "raava:panel-visible"],
      ["paperclip:inbox:dismissed", "raava:inbox:dismissed"],
      ["paperclip:inbox:read-items", "raava:inbox:read-items"],
      ["paperclip:inbox:last-tab", "raava:inbox:last-tab"],
      ["paperclip:recent-assignees", "raava:recent-assignees"],
    ];

    for (const [oldKey, newKey] of migrations) {
      const value = storage.getItem(oldKey);
      if (value !== null && storage.getItem(newKey) === null) {
        storage.setItem(newKey, value);
      }
      // Always remove stale legacy key
      if (value !== null) {
        storage.removeItem(oldKey);
      }
    }

    // Migrate prefixed keys (project-specific, issue-specific)
    const prefixMigrations: [string, string][] = [
      ["paperclip.projectOrder", "raava.projectOrder"],
      ["paperclip.agentOrder", "raava.agentOrder"],
      ["paperclip:project-view:", "raava:project-view:"],
      ["paperclip:issue-document-folds:", "raava:issue-document-folds:"],
    ];

    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key) continue;
      for (const [oldPrefix, newPrefix] of prefixMigrations) {
        if (key.startsWith(oldPrefix)) {
          const newKey = newPrefix + key.slice(oldPrefix.length);
          const value = storage.getItem(key);
          if (value !== null && storage.getItem(newKey) === null) {
            storage.setItem(newKey, value);
          }
          // Always remove stale legacy key
          if (value !== null) {
            storage.removeItem(key);
            i--; // adjust index since we removed an item
          }
        }
      }
    }
  } catch {
    // Best-effort — don't crash the app if storage quota is exceeded or other errors
  }

  try {
    storage!.setItem(MIGRATED_FLAG, "1");
  } catch {
    // Non-critical — migration may re-run on next load
  }
}
