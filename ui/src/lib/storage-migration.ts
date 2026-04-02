/**
 * One-time migration of localStorage keys from paperclip.* to raava.*.
 * Call during app initialization.
 */
const MIGRATED_FLAG = "raava:storage-migrated";

export function migrateLocalStorageKeys(): void {
  if (typeof window === "undefined") return;
  if (localStorage.getItem(MIGRATED_FLAG)) return;

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
    const value = localStorage.getItem(oldKey);
    if (value !== null && localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, value);
      localStorage.removeItem(oldKey);
    }
  }

  // Migrate prefixed keys (project-specific, issue-specific)
  const prefixMigrations: [string, string][] = [
    ["paperclip.projectOrder", "raava.projectOrder"],
    ["paperclip.agentOrder", "raava.agentOrder"],
    ["paperclip:project-view:", "raava:project-view:"],
    ["paperclip:issue-document-folds:", "raava:issue-document-folds:"],
  ];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    for (const [oldPrefix, newPrefix] of prefixMigrations) {
      if (key.startsWith(oldPrefix)) {
        const newKey = newPrefix + key.slice(oldPrefix.length);
        const value = localStorage.getItem(key);
        if (value !== null && localStorage.getItem(newKey) === null) {
          localStorage.setItem(newKey, value);
          localStorage.removeItem(key);
          i--; // adjust index since we removed an item
        }
      }
    }
  }

  localStorage.setItem(MIGRATED_FLAG, "1");
}
