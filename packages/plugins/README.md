# Paperclip Plugins

**Status:** Production-ready (3 plugins deployed, 849/849 tests passing — 100%)

**Last Updated:** 2026-04-01

---

## Overview

This directory contains the Paperclip plugin system — a modular architecture for extending Paperclip with custom tools, workflows, and integrations.

### Architecture

```
packages/plugins/
├── sdk/                          # Core plugin SDK (131 unit tests)
│   ├── src/
│   │   ├── index.ts              # Worker SDK: definePlugin, runWorker
│   │   ├── ui/                   # React hooks: usePluginData, usePluginAction
│   │   ├── testing/              # Test harness: createTestHarness
│   │   ├── bundlers/             # Build presets for worker/manifest/UI
│   │   └── protocol/             # JSON-RPC protocol types
│   └── README.md                 # SDK API reference (888 lines)
├── playwright-mcp/               # Browser automation (10 tools)
├── ruflo-bridge/                 # Multi-agent orchestration (9 tools)
├── skills-hub/                   # Hermes skills discovery (12 tools)
├── examples/                     # Example plugins for learning
│   ├── plugin-hello-world-example/
│   ├── plugin-file-browser-example/
│   ├── plugin-kitchen-sink-example/
│   └── plugin-authoring-smoke-example/
├── create-paperclip-plugin/      # Scaffold CLI for new plugins
└── __tests__/                    # E2E lifecycle tests (30 tests, no Postgres)
```

---

## Production Plugins

| Plugin | Tools | Description | Tests |
|--------|-------|-------------|-------|
| `@paperclipai/plugin-playwright-mcp` | 10 | Browser automation with Playwright MCP | E2E lifecycle |
| `@paperclipai/plugin-ruflo-bridge` | 9 | Multi-agent orchestration, semantic memory, workflows | E2E lifecycle |
| `@paperclipai/plugin-skills-hub` | 12 | Discover and install Hermes Agent skills | E2E lifecycle |

**Total:** 31 tools across 3 production plugins.

---

## Quick Start

### Install SDK

```bash
pnpm add @paperclipai/plugin-sdk
```

### Create a Plugin

```bash
# Build the scaffold CLI
pnpm --filter @paperclipai/create-paperclip-plugin build

# Generate a new plugin
node packages/plugins/create-paperclip-plugin/dist/index.js @yourscope/my-plugin \
  --output ./packages/plugins/examples
```

### Validate All Plugins

```bash
# Run full validation suite (8 steps, ~55s)
./scripts/validate-plugins.sh

# Output:
# [0/7] Script Self-Tests... ✅
# [1/7] SDK Typecheck... ✅
# [2/7] SDK Unit Tests... ✅ (131 tests)
# [3/7] Plugin E2E Lifecycle Tests... ✅ (30 tests)
# [4/7] Plugin Typecheck... ✅ (3 plugins)
# [5/7] Plugin Build... ✅ (3 plugins)
# [6/7] Documentation Validation (presence + canonical README status sync)... ✅
# [7/7] Install Script Validation... ✅
```

---

## Plugin SDK

The SDK provides:

- **Worker SDK** (`@paperclipai/plugin-sdk`) — `definePlugin`, `runWorker`, context types
- **UI SDK** (`@paperclipai/plugin-sdk/ui`) — React hooks for plugin UI components
- **Testing** (`@paperclipai/plugin-sdk/testing`) — In-memory test harness
- **Bundlers** (`@paperclipai/plugin-sdk/bundlers`) — esbuild/rollup presets
- **Dev Server** (`@paperclipai/plugin-sdk/dev-server`) — Hot reload for development

See [`sdk/README.md`](./sdk/README.md) for complete API reference.

---

## Development Workflow

### 1. Scaffold

```bash
node packages/plugins/create-paperclip-plugin/dist/index.js @scope/plugin-name \
  --output ./packages/plugins/examples
```

### 2. Develop

```bash
# Typecheck
pnpm --filter @scope/plugin-name typecheck

# Build
pnpm --filter @scope/plugin-name build

# Test (if plugin has tests)
pnpm --filter @scope/plugin-name test
```

### 3. Validate

Before committing, run the full validation suite:

```bash
./scripts/validate-plugins.sh
```

### 4. Document

Each plugin must have:

- `README.md` with features, tools, usage examples
- Inline JSDoc comments on exported functions
- Update `doc/plugins/README.md` if adding a new production plugin

---

## Testing

### SDK Unit Tests

```bash
pnpm --filter @paperclipai/plugin-sdk test
# 131 tests passing
```

### E2E Lifecycle Tests

```bash
pnpm test -- plugin-e2e-lifecycle
# 30 tests passing (no Postgres dependency)
```

Test coverage:
- Plugin manifest validation
- Worker lifecycle (setup, health, shutdown)
- Tool registration and invocation
- Event handling
- Data/actions registration
- UI component rendering (slots, launchers)

---

## Deployment

### Current Model (Single-Node)

Plugins are installed locally into the Paperclip instance:

```bash
# Install from npm (recommended for deployed plugins)
pnpm add @paperclipai/plugin-playwright-mcp

# Or link from local development
pnpm link ./packages/plugins/playwright-mcp
```

### Limitations (Alpha)

- **Trust model:** Plugin UI runs as same-origin JavaScript (trusted code, not sandboxed)
- **Deployment:** Single-tenant, self-hosted, single-node only
- **Plugin UI:** No shared React component kit yet — plugins render as ES modules in host extension slots
- **Assets:** `ctx.assets` not supported (no plugin asset uploads/reads)
- **Cloud readiness:** No shared artifact store or cross-node distribution layer

See [`doc/plugins/PLUGIN_SPEC.md`](../../doc/plugins/PLUGIN_SPEC.md) §Current implementation caveats for full details.

---

## Documentation

| Document | Purpose |
|----------|---------|
| [`doc/plugins/README.md`](../../doc/plugins/README.md) | Plugin system overview |
| [`doc/plugins/PLUGIN_SPEC.md`](../../doc/plugins/PLUGIN_SPEC.md) | Complete architecture spec (59KB) |
| [`doc/plugins/PLUGIN_AUTHORING_GUIDE.md`](../../doc/plugins/PLUGIN_AUTHORING_GUIDE.md) | Step-by-step authoring guide |
| [`sdk/README.md`](./sdk/README.md) | SDK API reference |
| Plugin READMEs | Individual plugin documentation |

---

## Autonomous Validation

The plugin system is validated hourly via cron:

```cron
0 * * * * root /root/paperclip-repo/scripts/validate-plugins.sh >> /var/log/paperclip-plugin-validation.log 2>&1
```

Validation includes:
- Script self-tests
- SDK typecheck + unit tests
- E2E lifecycle tests
- All plugins typecheck + build
- Documentation presence + canonical README status sync
- Install script validation

Reports are saved as JSON to `/tmp/paperclip-plugin-validation-<timestamp>.json`.

---

## Contributing

1. Read [`PLUGIN_AUTHORING_GUIDE.md`](../../doc/plugins/PLUGIN_AUTHORING_GUIDE.md)
2. Scaffold a plugin or add to an existing one
3. Write tests (unit + E2E lifecycle)
4. Run `./scripts/validate-plugins.sh`
5. Submit PR with documentation updates

---

## License

MIT
