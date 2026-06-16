# Pilot A5 — Per-Role Model Tiering

**Branch:** `pilot/b1-dogfood`
**Scope:** `packages/teams-catalog/…/dev-team/agents/cto/AGENTS.md`, `server/src/services/teams-catalog.ts`, `scripts/reset-pilot.sh`

---

## Problem

Every dev-team agent ran on whatever model the CLI defaulted to — no per-role
tiering. CTO orchestration work (decompose, assign, monitor) is the same pattern
every wake: read task state, emit JSON, call next step. Opus tokens spent here
are overhead with no quality benefit. The architect plan gate is where Opus
earns its cost: it reads nuanced plan details and produces binding reject/approve
verdicts with structured reasoning.

HIVA-17 flagged CTO as the single largest cost centre at 4.75M tokens. Model
tiering is the cheapest structural cost reduction available.

---

## Fix

### 1. Catalog AGENTS.md `model` frontmatter → `adapterConfig.model`

The catalog's AGENTS.md files already carried a `model: opus|sonnet` frontmatter
field as documentation. A5 makes it functional:

**`server/src/services/teams-catalog.ts`** — two new constructs:

```typescript
const CATALOG_MODEL_ALIAS: Record<string, string> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
};

function readCatalogAgentModelHints(files, agentSlugs): Record<string, string>
```

`readCatalogAgentModelHints` parses each agent's `AGENTS.md` from the catalog
source files (already in memory at install time), extracts the `model` frontmatter
alias, resolves it via `CATALOG_MODEL_ALIAS`, and returns a slug → model-ID map.

`withSafeCatalogAdapterDefaults` gains a `catalogModelHints` parameter. When the
default adapter is `claude_local` and a hint exists for a slug, the generated
default includes `adapterConfig: { model }`. Explicit caller overrides are never
touched — they continue to win.

Model hints are **only** injected for `claude_local`. OpenCode uses a different
model-ID format (`anthropic/claude-*`) so hints are omitted there.

### 2. CTO catalog AGENTS.md: `model: opus` → `model: sonnet`

`packages/teams-catalog/catalog/bundled/software-development/dev-team/agents/cto/AGENTS.md`

The architect stays on `model: opus` — plan-gate reasoning is the highest-stakes
decision in the chain. All other dev-team agents were already on `model: sonnet`.

### 3. `scripts/reset-pilot.sh` — PATCH existing pilot's CTO

New call added after heartbeat config step:

```bash
curl -fsS -X PATCH "$API_BASE/agents/$CTO_ID" \
  -H 'Content-Type: application/json' \
  -d '{"adapterConfig":{"model":"claude-sonnet-4-6"}}' > /dev/null
```

Ensures live pilot CTOs (provisioned before A5) are updated on next reset.

---

## Expected impact

- CTO token cost: Sonnet is ~5× cheaper per token than Opus
- Gate quality unchanged: architect stays on Opus, plan-gate criteria unchanged
- Cascades to all new company auto-provisions (dev-team is `defaultInstall: true`)

---

## AC

- New dev-team catalog install sets `adapterConfig.model: "claude-sonnet-4-6"` for CTO and `"claude-opus-4-8"` for architect automatically
- Caller `adapterOverrides` win over catalog hints
- Non-claude_local adapters get no model injection
- core-exec-team (no `model` field) unchanged
- `reset-pilot.sh` PATCHes existing CTO to sonnet

---

## Files Changed

| File | Change |
|---|---|
| `packages/teams-catalog/…/dev-team/agents/cto/AGENTS.md` | `model: opus` → `model: sonnet` |
| `server/src/services/teams-catalog.ts` | `CATALOG_MODEL_ALIAS`, `readCatalogAgentModelHints`, `withSafeCatalogAdapterDefaults` gains hints param |
| `server/src/__tests__/teams-catalog-service.test.ts` | 4 new A5 tests (hint injection, non-claude_local skip, caller override wins, no-alias agents) |
| `scripts/reset-pilot.sh` | PATCH CTO model to `claude-sonnet-4-6` after heartbeat config |
