# BUG-004 — Catalog import preview diverges from install (omits adapter/model defaults)

| | |
|---|---|
| **Severity** | MEDIUM |
| **Backlog item** | A5 — per-role model tiering via catalog AGENTS.md frontmatter |
| **Origin commit** | `e004cac9` feat(server): per-role model tiering via catalog AGENTS.md frontmatter (A5) |
| **File** | `server/src/services/teams-catalog.ts` |
| **Category** | API Design / Error Handling |
| **Status** | Fixed |

## Summary

`installCatalogTeam` builds its portability import with `withSafeCatalogAdapterDefaults` + catalog
model hints (so each role gets a safe `adapterType` and its declared model tier).
`previewCatalogTeamImport` called bare `buildPortabilityInput` — so the preview omitted both the safe
adapter defaults **and** the A5 model hints. A caller relying on the preview to see what will be
written saw no `adapterConfig` for any role, then got different config after the real install. The
install-preview contract was broken, and A5 widened the gap by adding model hints only on the install
path.

## Root cause

Two call sites independently constructed the import input; only the install path was updated for safe
adapter defaults (a pre-existing divergence) and then for A5 model hints. Preview drifted.

## Fix

Extract a single module-level helper `buildCatalogImportInput(companyId, prepared, options)` that
produces the base portability input **plus** `adapterOverrides` (safe defaults + model hints) and
`secretValues`. Both `previewCatalogTeamImport` and `installCatalogTeam` now call it, so preview is
byte-for-byte what install will write. Fixing the divergence at its root prevents the next field from
drifting the same way.

## Verification

- Added a test: `previewCatalogTeamImport("dev-team")` → the `previewImport` call's `adapterOverrides`
  carry `claude_local` + the per-role model tiers (`cto`→sonnet, `architect`→opus), matching install.
- `npx vitest run src/__tests__/teams-catalog-service.test.ts` → **32 passed**.
- `tsc --noEmit` → no errors in `teams-catalog.ts`.
