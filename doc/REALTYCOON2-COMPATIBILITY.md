# RealTycoon2 Compatibility Boundary

RealTycoon2 is the product identity for current product work. Paperclip remains the inherited control-plane, runtime infrastructure, package namespace, CLI history, and compatibility reference layer.

## Product-Facing Rule

UI copy, onboarding/default states, operator-facing docs, and server-facing reflection text should use RealTycoon2-first Korean product language:

- RealTycoon2 for the product and company automation platform.
- Jarvis for AI agent assistance and operating modes.
- Mission, Objective, Key Result, Project, Task, To-Do, deliverable, gold, coin, quality, CareerMate, wikiLLM, and Graphify when naming v3.1 product concepts.
- Korean labels for loading, empty, support, and action states unless the term is a fixed technical name.

The public product surface should not present Paperclip or legacy company-name labels as the product name.

## Compatibility Names

These names may remain in internal or compatibility contexts:

- `@paperclipai/*` package names.
- `paperclipai` CLI entrypoint and legacy aliases.
- `PAPERCLIP_*` environment variables and secret references.
- Adapter, MCP, migration, and storage identifiers that already depend on Paperclip naming.
- Historical planning records, tests, release notes, and reference-engine comparisons.

When these names appear in docs, the surrounding text must make the boundary clear: Paperclip is compatibility infrastructure, not the RealTycoon2 product identity.

## Reference Engine Terms

Multica, wikiLLM, and Graphify may appear when documenting reference-engine parity or roadmap debt. Complete parity claims require concrete evidence. Without evidence, those rows stay partial, tech debt, missing, or deferred.
