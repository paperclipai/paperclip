# @paperclipai/adapter-pi-local

## Unreleased

### Patch Changes

- Reconcile streamed text and thinking with message, turn, and agent completion snapshots so one logical message renders once. Preserve separate messages with identical text and keep parser state isolated per run.
- Pi and process transcript consumers now use `createPiStdoutParser` through their adapter's `createStdoutParser` factory. The one-line parser remains stateless.

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
