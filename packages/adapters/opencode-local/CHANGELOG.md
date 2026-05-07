# @paperclipai/adapter-opencode-local

## Unreleased

### Patch Changes

- Fix `external_directory` permission injection for OpenCode 1.x. The previous
  implementation set `external_directory: "allow"` (string), which is silently
  ignored by OpenCode 1.x — only the object form `{ "path": "allow" }` is
  recognised. When `dangerouslySkipPermissions` is `true` (the default), the
  adapter now injects `{ "/*": "allow" }` and merges it with any existing
  `external_directory` entries from the user's config rather than replacing them.
  Without this fix, agents that write to `/tmp` or any path outside the project
  root receive an auto-rejection and fail mid-run.



## 0.3.1

### Patch Changes

- Stable release preparation for 0.3.1
- Updated dependencies
  - @paperclipai/adapter-utils@0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

### Patch Changes

- Updated dependencies
  - @paperclipai/adapter-utils@0.3.0

## 0.2.7

### Patch Changes

- Add local OpenCode adapter package with server/UI/CLI modules.
