# BUG-003 — Prototype-unsafe catalog model-alias lookup

| | |
|---|---|
| **Severity** | MEDIUM |
| **Backlog item** | A5 — per-role model tiering via catalog AGENTS.md frontmatter |
| **Origin commit** | `e004cac9` feat(server): per-role model tiering via catalog AGENTS.md frontmatter (A5) |
| **File** | `server/src/services/teams-catalog.ts` |
| **Category** | Injection / Input Validation |
| **Status** | Fixed |

## Summary

`readCatalogAgentModelHints` resolved a model alias from AGENTS.md frontmatter with a bare object
index: `CATALOG_MODEL_ALIAS[modelAlias]`. `CATALOG_MODEL_ALIAS` is a plain object literal, so a
frontmatter value matching an inherited `Object.prototype` member (`model: constructor`,
`model: toString`, `model: hasOwnProperty`) returned a truthy non-model value (a function) that
passed the `if (resolved)` guard, landed in `hints[slug]`, and propagated into
`adapterConfig.model` → the Claude CLI `--model` flag.

This is defense-in-depth: the input is a catalog `AGENTS.md`, a repo-controlled/trusted source, so
it is not remotely exploitable. But the lookup was structurally unsafe and the resolved value was
never constrained to known model IDs (the reviewer's H2 "unvalidated passthrough" concern).

## Root cause

`teams-catalog.ts:713-716` — property access on a prototype-bearing object literal with an unvalidated
string key, guarded only by truthiness (which `[Function]` satisfies).

## Fix

Gate the lookup on `Object.prototype.hasOwnProperty.call(CATALOG_MODEL_ALIAS, modelAlias)` before
indexing. This:

- **closes H1** — inherited members never resolve;
- **closes H2** — the only values that can resolve are the map's own entries (`opus`, `sonnet`),
  both canonical valid IDs, so no unknown id ever reaches `--model`.

An unrecognized alias (e.g. `model: haiku`) is silently skipped, exactly as before.

## Verification

- Exported `readCatalogAgentModelHints` and added pure-function tests covering: known-alias
  resolution, unrecognized alias → `{}`, and the three `Object.prototype` members → `{}`.
- `npx vitest run src/__tests__/teams-catalog-service.test.ts` → **31 passed** (3 new).

## Notes

- An allow-list of valid Claude model IDs (the reviewer's stronger H2 fix) is unnecessary given the
  own-property guard, because the map's values are the allow-list. If future aliases are added,
  keep the map's values canonical.
