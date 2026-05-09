# plugin-issue-linker-example

An example Paperclip plugin that adds a toolbar button to the issue detail view. When clicked, it opens an inline search modal that lets you find and link any issue as a blocker of the current issue.

## What it does

- Injects a **"Link related issue"** button into the issue detail toolbar via the `toolbarButton` slot.
- The button opens a dropdown with a debounced search field that queries all issues in the current company.
- Selecting an issue calls the `linkIssue` worker action, which adds the selected issue as a blocker of the currently viewed issue using `ctx.issues.relations.addBlockers`.
- Shows a toast notification on success or failure.

## Manifest slots

| Slot type       | ID                            | Export name                  | Entity types |
| --------------- | ----------------------------- | ---------------------------- | ------------ |
| `toolbarButton` | `issue-linker-toolbar-button` | `IssueLinkerToolbarButton`   | `issue`      |

The button only appears on issue detail pages (`entityTypes: ["issue"]`).

## Capabilities declared

```
"ui.action.register"
"issues.read"
"issue.relations.write"
```

## Build

```bash
pnpm --filter @paperclipai/plugin-issue-linker-example build
```

## Install

```bash
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-issue-linker-example
```

## Uninstall

Open the Paperclip web UI, navigate to **Settings → Plugins**, find **Issue Linker (Example)**, and click **Uninstall**.

## Development

```bash
pnpm install
pnpm --filter @paperclipai/plugin-issue-linker-example dev      # watch builds
pnpm --filter @paperclipai/plugin-issue-linker-example typecheck
pnpm --filter @paperclipai/plugin-issue-linker-example build
```
