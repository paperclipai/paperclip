# Issue Links Plugin — Design Spec

**Date:** 2026-04-16
**Status:** Approved

## Overview

A Paperclip plugin that adds two link fields to every issue: a local filesystem path and a GitHub PR URL. Both appear inline in the issue detail view alongside existing property rows. Agents can read and set both fields via registered tools.

---

## Architecture

Plugin location: `packages/plugins/issue-links/`

Structure mirrors the existing example plugins:

```
packages/plugins/issue-links/
  src/
    manifest.ts
    constants.ts
    index.ts          # worker entrypoint
    worker.ts         # data, action, tool handlers
    ui/
      index.tsx       # UI slot exports
      IssueLinksView.tsx
  package.json
  tsconfig.json
  scripts/build-ui.mjs
```

Three moving parts:
- **manifest** — declares capabilities, instance config schema, agent tools, and one `taskDetailView` UI slot scoped to `entityTypes: ["issue"]`
- **worker** — handles data reads, action writes, and two agent tools
- **UI** — renders two inline property rows inside the issue detail body via the `taskDetailView` slot

The `taskDetailView` slot is used (not `detailTab`) because it renders inline within the issue detail body, closest to the existing properties panel.

---

## Data & Storage

Two plugin state keys per issue, stored with `ctx.state` at scope `"issue"`:

| State key       | Type            | Description                        |
|-----------------|-----------------|------------------------------------|
| `localPath`     | string \| null  | Absolute local filesystem path     |
| `githubPrUrl`   | string \| null  | Full GitHub PR URL                 |

### Worker: data handler

```
ctx.data.register("issue-links")
```

Params: `{ issueId: string, companyId: string }`
Returns: `{ localPath: string | null, githubPrUrl: string | null }`

Reads both state keys in parallel and returns them together.

### Worker: action handlers

**`set-local-path`**
- Params: `{ issueId: string, companyId: string, value: string | null }`
- Writes `localPath` state key for the issue. Passing `null` clears it.

**`set-github-pr-url`**
- Params: `{ issueId: string, companyId: string, value: string | null }`
- Writes `githubPrUrl` state key for the issue. Passing `null` clears it.

### Agent tools

Two tools registered via `ctx.tools.register`, callable by agents during issue execution:

**`issue-links.set-local-path`**
- Description: "Set the local filesystem path for an issue."
- Parameters schema: `{ issueId: string, value: string }` (both required)
- Resolves `companyId` from `runCtx`

**`issue-links.set-github-pr-url`**
- Description: "Set the GitHub PR URL for an issue."
- Parameters schema: `{ issueId: string, value: string }` (both required)
- Resolves `companyId` from `runCtx`

---

## Instance Configuration

One instance-level config setting, declared in `instanceConfigSchema`:

| Key        | Type                    | Default    | Description                              |
|------------|-------------------------|------------|------------------------------------------|
| `openWith` | `"vscode" \| "finder"`  | `"vscode"` | Controls how local path clicks are handled |

When `openWith = "vscode"`: clicking the path fires `vscode://file/<path>`
When `openWith = "finder"`: clicking the path fires `file://<path>` which macOS opens in Finder

The UI reads this via `usePluginData("plugin-config")` and applies it to the click handler.

---

## UI

### Slot

```ts
{
  type: "taskDetailView",
  id: "issue-links-view",
  displayName: "Issue Links",
  exportName: "IssueLinksView",
  entityTypes: ["issue"]
}
```

### Component: `IssueLinksView`

Rendered via `useHostContext()` to get `entityId` (issue ID) and `companyId`. Fetches data with `usePluginData("issue-links", { issueId, companyId })` and config with `usePluginData("plugin-config")`.

Renders two rows styled to match `IssueProperties.tsx` property rows (label left, value right, consistent font size and spacing).

**Loading state:** a skeleton placeholder matching property row height while data fetches.

---

### Local Path row

- **Label:** "Local Path"
- **Value (set):** Clickable path text. On click, navigates to `vscode://file/<path>` or `file://<path>` based on `openWith` config. Includes a small icon (folder or VS Code) as a visual hint.
- **Value (empty):** Muted "Add path…" placeholder text.
- **Edit trigger:** Clicking the value or placeholder opens an inline `<input>`.
- **Save:** On blur or Enter key — calls `usePluginAction("set-local-path")` with the new value.
- **Clear:** Saving an empty string calls `set-local-path` with `null`.
- **Cancel:** Escape key restores the previous value without saving.

---

### GitHub PR row

- **Label:** "GitHub PR"
- **Value (set):** Clickable display showing extracted PR reference (e.g. `org/repo#123` parsed from the URL). Opens the full URL in a new browser tab (`target="_blank" rel="noopener noreferrer"`).
- **Value (empty):** Muted "Add PR…" placeholder text.
- **Edit trigger:** Clicking the value or placeholder opens an inline `<input>`.
- **Save:** On blur or Enter key — calls `usePluginAction("set-github-pr-url")` with the new URL.
- **Clear:** Saving an empty string calls `set-github-pr-url` with `null`.
- **Cancel:** Escape key restores the previous value.
- **Display parsing:** URL `https://github.com/org/repo/pull/123` → displays as `org/repo#123`. Falls back to displaying the raw URL if parsing fails.

---

## Capabilities Required

```ts
[
  "issues.read",
  "plugin.state.read",
  "plugin.state.write",
  "instance.settings.register",
  "agent.tools.register",
  "ui.action.register",
]
```

---

## Out of Scope

- Multiple paths or PR URLs per issue (by design — one of each, narrowly scoped)
- Fetching GitHub PR metadata (title, status, author) — future enhancement
- Cross-issue querying of links
- Per-issue override of `openWith` setting
