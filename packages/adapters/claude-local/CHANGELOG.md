# @paperclipai/adapter-claude-local

## 0.4.1

### Patch Changes

- Make the Paperclip tools MCP shim a self-contained esbuild bundle so remote execution targets can spawn it from an isolated runtime asset directory without needing @modelcontextprotocol/sdk on disk (SPO-50 QA blocking finding).
- Add isolated remote startup test (`paperclip-tools-mcp-shim.isolated.test.ts`) that runs the built bundle from a fresh tmp dir and round-trips an MCP `initialize` + `tools/list` to guard against regression.

## 0.4.0

### Minor Changes

- Add bundled Paperclip tools MCP shim wiring for Claude via per-run `--mcp-config`
- Add `disablePluginToolsMcp` adapter config escape hatch

### Patch Changes

- Updated dependencies
  - @modelcontextprotocol/sdk@^1.29.0

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

- Version bump (patch)
- Updated dependencies
  - @paperclipai/adapter-utils@0.2.7

## 0.2.6

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/adapter-utils@0.2.6

## 0.2.5

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/adapter-utils@0.2.5

## 0.2.4

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/adapter-utils@0.2.4

## 0.2.3

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/adapter-utils@0.2.3

## 0.2.2

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/adapter-utils@0.2.2

## 0.2.1

### Patch Changes

- Version bump (patch)
- Updated dependencies
  - @paperclipai/adapter-utils@0.2.1
