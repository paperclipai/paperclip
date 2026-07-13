# @paperclipai/adapter-pi-local

## Unreleased

### Patch Changes

- Coalesce concurrent Pi model refreshes, retain results for five minutes, and fall back to the last successful workspace-scoped result during transient refresh failures.
- Give cold Pi model discovery a 60-second termination deadline, plus the existing three-second shutdown grace, so concurrent workspace startup does not exhaust the previous 20-second deadline.

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
