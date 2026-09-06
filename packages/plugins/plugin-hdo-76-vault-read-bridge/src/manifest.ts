import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Stable plugin ID. Used by host registration and event namespacing.
 */
export const PLUGIN_ID = "paperclip.hdo-76-vault-read-bridge";

/**
 * The vault folder key. The bridge declares `access: "read"` for this
 * folder; it never requests `writeTextAtomic` or `deleteFile` against
 * it. The host's local-folders subsystem enforces the read-only
 * surface; the bridge's own code additionally never imports or calls
 * the write APIs.
 */
export const VAULT_ROOT_FOLDER_KEY = "vault-root";

const VAULT_TAB_SLOT_ID = "vault-tab";
const VAULT_SIDEBAR_SLOT_ID = "vault-link";
const VAULT_TAB_EXPORT_NAME = "VaultTab";
const VAULT_SIDEBAR_EXPORT_NAME = "VaultLink";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "HDO-76 Vault Read Bridge (Prototype)",
  description:
    "One-way read-only bridge from a local Obsidian vault into a project-detail Vault tab. The vault is the Owner's human-controlled truth; Paperclip never edits it. No write-back, no auto-issue-creation, no outbound HTTP.",
  author: "HuiDots CTO (HDO-76)",
  categories: ["ui"],
  // Read-only capability surface. The plugin never requests any
  // `*.create`, `*.update`, `*.write`, or `*.delete` capability.
  capabilities: [
    "companies.read",
    "projects.read",
    "issues.read",
    "local.folders",
    "plugin.state.read",
    "plugin.state.write",
    "ui.detailTab.register",
    "ui.projectSidebarItem.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  // The vault is declared read-only at the host's local-folders
  // subsystem. The bridge additionally never calls
  // `writeTextAtomic` / `deleteFile` against the vault folder key;
  // see `src/worker.ts` for the runtime guarantee.
  localFolders: [
    {
      folderKey: VAULT_ROOT_FOLDER_KEY,
      displayName: "Obsidian Vault",
      description: "Local Obsidian vault root. The bridge is read-only.",
      access: "read",
      requiredDirectories: [],
      requiredFiles: ["VAULT-MANIFEST.md"],
    },
  ],
  ui: {
    slots: [
      {
        type: "detailTab",
        id: VAULT_TAB_SLOT_ID,
        displayName: "Vault",
        exportName: VAULT_TAB_EXPORT_NAME,
        entityTypes: ["project"],
        order: 30,
      },
      {
        type: "projectSidebarItem",
        id: VAULT_SIDEBAR_SLOT_ID,
        displayName: "Vault",
        exportName: VAULT_SIDEBAR_EXPORT_NAME,
        entityTypes: ["project"],
        order: 30,
      },
    ],
  },
};

export default manifest;
