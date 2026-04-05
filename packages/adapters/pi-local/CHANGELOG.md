# @paperclipai/adapter-pi-local

## Unreleased

### Patch Changes

- When `timeoutSec` is 0 or omitted, use the shared **3600s** default child-process cap (`@paperclipai/adapter-utils`).
- Emit stable `errorCode` values on failure (`timeout`, `pi_auth_required`, `pi_exit_nonzero`) for heartbeat aggregation and operator triage.
- Expand `$AGENT_HOME` in the system prompt extension and user prompt segments.

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
