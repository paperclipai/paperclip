# @paperclipai/plugin-hdo-76-vault-read-bridge

HDO-76 Phase 2 prototype. One-way **read-only** bridge from a local
Obsidian vault into a project-detail **Vault** tab on the live Paperclip
UI. No write-back, no auto-issue-creation, no outbound HTTP.

## Why this plugin exists

The Owner originally framed the dashboard work as "like obsidian lib and
etc". The most concrete existing "obsidian lib" surface in the HuiDots
tree is the live Obsidian vault at
`HuiDots/Knowledge/ramsey-ai-portfolio-brain/` — the Owner's
human-controlled truth. HDO-76 Phase 1 produced a research note ([Note
B](../HDO-76-note-b-obsidian-vault-read-bridge.md)) and Phase 2 builds
this prototype as a one-way bridge inside the existing Paperclip plugin
system (no schema change).

The bridge treats the vault as **read-only**. The vault is the
Owner's human-controlled truth; Paperclip never edits it.

## What it does

- Adds a `Vault` tab on the project detail page.
- Adds an optional `Vault` sidebar item under each project.
- Renders a per-project vault view: notes under the matching product
  subfolder (`30-Products/<Product>/`), notes that reference the
  project from `70-Reviews-and-Scorecards/` or `60-Portfolio-Decisions/`,
  and the `10-Portfolio/Sensitive Information Rules.md` redaction
  surface.
- Resolves `[[wikilinks]]` against the vault only (never against
  Paperclip issues).
- Honours a `[redacted]` placeholder for notes flagged by the
  redaction rules.

## What it explicitly does NOT do

- **No write-back to the vault.** The bridge declares `access: "read"`
  for the vault root and never invokes `writeTextAtomic` or
  `deleteFile` against the vault folder key.
- **No auto-issue-creation.** Reading a note does not create a
  Paperclip issue, comment, work product, or activity log entry.
- **No mirroring of vault content into Paperclip documents.**
- **No cross-tenant export.** The bridge only reads the locally
  configured vault root.
- **No outbound HTTP.** The bridge does not call any external
  service.

## Capabilities

The manifest declares only the read-side capabilities the prototype
needs. It does not request `issues.create`, `issue.comments.create`,
`issue.documents.write`, `activity.log.write`, or the `local.folders`
write surface.

```
companies.read
projects.read
issues.read
local.folders             # declared as access: "read" only at configure time
plugin.state.read
plugin.state.write
ui.detailTab.register
ui.projectSidebarItem.register
```

The plugin's only writes are to its own `plugin.state` cursor store —
never to Paperclip issues / comments / docs / activity, never to the
vault.

## Vault folder declaration

```ts
localFolders: [
  {
    folderKey: "vault-root",
    displayName: "Obsidian Vault",
    description: "Local Obsidian vault root; declared access: read-only.",
    access: "read",
    requiredDirectories: [],
    requiredFiles: ["VAULT-MANIFEST.md"],
  },
],
```

## Verification approach

- `pnpm --filter @paperclipai/plugin-hdo-76-vault-read-bridge typecheck`
  passes.
- `pnpm --filter @paperclipai/plugin-hdo-76-vault-read-bridge test`
  passes and covers vault relevance scoring, redaction detection, and
  wikilink resolution against the vault only.
- `pnpm --filter @paperclipai/plugin-hdo-76-vault-read-bridge build`
  produces the manifest, worker, and UI bundles under `dist/`.

## References

- HDO-76 — `Improvement and movement from paperclips` (parent issue).
- HDO-76 plan rev 2 — owner-gated, four-phase plan.
- Phase 1 research note B — `note-b-obsidian-vault-read-bridge`
  document on the parent issue.
- Live Obsidian vault — `HuiDots/Knowledge/ramsey-ai-portfolio-brain/`
  (`VAULT-MANIFEST.md`,
  `10-Portfolio/Sensitive Information Rules.md`).
- Live Paperclip plugin SDK local folders —
  `HuiDots/Shared/paperclip-pi-local-backport/packages/plugins/sdk/src/types.ts`
  (`PluginLocalFoldersClient`, `PluginLocalFolderStatus`,
  `PluginLocalFolderProblem`).
- Live Paperclip plugin examples — `plugin-llm-wiki`,
  `plugin-file-browser-example`.
- Live Paperclip UI tokens — `HuiDots/Shared/paperclip-pi-local-backport/ui/src/index.css`,
  `pnpm check:token-gates`.
