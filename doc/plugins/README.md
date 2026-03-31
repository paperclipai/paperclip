# Paperclip Plugin System — Documentation Index

**Status:** Production-ready alpha (3 plugins deployed, 716 tests passing)

**Last Updated:** 2026-03-31

---

## Quick Start

| Goal | Document |
|------|----------|
| Understand the full plugin architecture | [`PLUGIN_SPEC.md`](./PLUGIN_SPEC.md) (59KB, complete spec) |
| Build your first plugin | [`PLUGIN_AUTHORING_GUIDE.md`](./PLUGIN_AUTHORING_GUIDE.md) (4KB, alpha surface) |
| See Opencode inspiration | [`ideas-from-opencode.md`](./ideas-from-opencode.md) (65KB, comparative analysis) |

---

## Current Implementation Status

### ✅ Production-Ready (Deployed)

| Plugin | Tools | Status | Tests |
|--------|-------|--------|-------|
| `@paperclipai/plugin-playwright-mcp` | 10 browser automation tools | ✅ Built, typechecked | E2E lifecycle |
| `@paperclipai/plugin-ruflo-bridge` | 9 Ruflo MCP tools | ✅ Built, typechecked | E2E lifecycle |
| `@paperclipai/plugin-skills-hub` | 12 agent skills tools | ✅ Built, typechecked | E2E lifecycle |

### ✅ SDK & Testing

| Component | Status | Coverage |
|-----------|--------|----------|
| Plugin SDK (`@paperclipai/plugin-sdk`) | ✅ v1.0.0 | 131 unit tests |
| E2E Lifecycle Tests | ✅ No Postgres required | 30 tests |
| Scaffold CLI (`create-paperclip-plugin`) | ✅ Builds external plugins | Smoke tests |

### ⚠️ Current Limitations (Alpha)

- **Trust model:** Plugin UI runs as same-origin JavaScript (trusted code, not sandboxed)
- **Deployment:** Single-tenant, self-hosted, single-node only
- **Plugin UI:** No shared React component kit yet — plugins render as ES modules in host extension slots
- **Assets:** `ctx.assets` not supported (no plugin asset uploads/reads)
- **Cloud readiness:** No shared artifact store or cross-node distribution layer

See [PLUGIN_SPEC.md §Current implementation caveats](./PLUGIN_SPEC.md#current-implementation-caveats) for full details.

---

## Documentation Map

```
doc/plugins/
├── README.md                          # This file — start here
├── PLUGIN_SPEC.md                     # Complete architecture spec (post-V1 target)
├── PLUGIN_AUTHORING_GUIDE.md          # Alpha authoring guide (what works now)
└── ideas-from-opencode.md             # Comparative analysis with Opencode plugin system
```

### Related Docs

- [`/packages/plugins/sdk/README.md`](../../packages/plugins/sdk/README.md) — SDK API reference
- [`/AGENTS.md`](../../AGENTS.md) — Plugin validation checklist for agents
- [`/doc/SPEC-implementation.md`](../SPEC-implementation.md) — V1 implementation contract (plugin system not in scope)

---

## Plugin Development Workflow

### 1. Scaffold a Plugin

```bash
# Inside Paperclip monorepo
pnpm --filter @paperclipai/create-paperclip-plugin build
node packages/plugins/create-paperclip-plugin/dist/index.js @yourscope/plugin-name \
  --output ./packages/plugins/examples
```

### 2. Develop Locally

```bash
cd packages/plugins/examples/your-plugin
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

### 3. Install in Paperclip (Local Path)

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/your-plugin","isLocalPath":true}'
```

### 4. Validation Checklist

Before considering a plugin production-ready:

- [ ] **Discovery:** Plugin in `packages/plugins/<name>` with valid `package.json`
- [ ] **Build:** `dist/worker.js` compiled and < 1MB
- [ ] **Tools:** Manifest declares tools, worker implements each
- [ ] **Docs:** README.md with usage examples
- [ ] **Tests:** SDK unit tests + E2E lifecycle tests passing
- [ ] **Typecheck:** `pnpm --filter <plugin> typecheck` passes
- [ ] **Integration:** `pnpm -r typecheck && pnpm test:run` passes

See [`/AGENTS.md`](../../AGENTS.md#plugin-development) for the full checklist.

---

## Architecture Overview

### Worker-Side Host APIs (Alpha)

Plugins have access to:

- `config`, `events`, `jobs`, `launchers`, `http`, `secrets`
- `activity`, `state`, `entities`, `projects`, `companies`
- `issues`, `comments`, `agents`, `agent sessions`, `goals`
- `data/actions`, `streams`, `tools`, `metrics`, `logger`

### UI Extension Surfaces

Plugins can mount UI in these host slots:

- `page`, `settingsPage`, `dashboardWidget`, `sidebar`, `sidebarPanel`
- `detailTab`, `taskDetailView`, `projectSidebarItem`
- `globalToolbarButton`, `toolbarButton`, `contextMenuItem`
- `commentAnnotation`, `commentContextMenuItem`

### Plugin UI Hooks

```typescript
import {
  usePluginData,
  usePluginAction,
  usePluginStream,
  usePluginToast,
  useHostContext,
} from '@paperclipai/plugin-sdk/ui';
```

See [`PLUGIN_AUTHORING_GUIDE.md`](./PLUGIN_AUTHORING_GUIDE.md#supported-alpha-surface) for the complete list.

---

## Testing Strategy

### Unit Tests (SDK)

```bash
pnpm --filter @paperclipai/plugin-sdk test
# 131 tests, ~500ms
```

### E2E Lifecycle Tests (No Postgres)

```bash
pnpm test -- plugin-e2e-lifecycle
# 30 tests, validates discovery → build → tool registration → execution
```

### Integration Tests (With Postgres)

```bash
pnpm test:run
# 716 tests total (133 files), includes plugin-worker-manager tests
```

---

## Publishing Guidance

- **Artifact:** npm packages (not GitHub repo installs)
- **Deployment:** Self-hosted instances install from npm or private registry
- **Example plugins:** `packages/plugins/examples/` are dev conveniences only — do not rely on these in production builds
- **Versioning:** SDK snapshots for local dev; publish to npm for production

---

## Future Scope (Not Yet Implemented)

The following are described in [`PLUGIN_SPEC.md`](./PLUGIN_SPEC.md) but not yet implemented:

- [ ] Cloud-ready multi-node plugin distribution
- [ ] Shared artifact store for plugin packages
- [ ] Host-provided React component kit for plugin UI
- [ ] Plugin asset uploads/reads (`ctx.assets`)
- [ ] Plugin-to-plugin communication layer
- [ ] Plugin observability dashboard
- [ ] Marketplace infrastructure

---

## Troubleshooting

### Plugin not discovered

- Check plugin is in `packages/plugins/<name>/` (not in `examples/`)
- Verify `package.json` has valid `name` field
- Run `pnpm --filter <plugin> build` to compile `dist/worker.js`

### Tool registration fails

- Ensure manifest declares all tools
- Verify worker exports each tool handler
- Check tool signatures match SDK types

### UI slot not rendering

- Confirm slot name matches host-supported list
- Check plugin manifest declares the slot
- Verify UI bundle compiles without errors

---

## Contributing

1. Read [`PLUGIN_SPEC.md`](./PLUGIN_SPEC.md) for the target architecture
2. Follow [`PLUGIN_AUTHORING_GUIDE.md`](./PLUGIN_AUTHORING_GUIDE.md) for alpha surface
3. Run full validation: `pnpm -r typecheck && pnpm test:run && pnpm build`
4. Update this README if adding new capabilities or changing workflows

---

**Questions?** See [`ideas-from-opencode.md`](./ideas-from-opencode.md) for comparative analysis and design rationale.
