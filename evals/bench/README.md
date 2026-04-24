# paperclip-bench

`paperclip-bench` is the scaffold for Paperclip's benchmark harness and benchmark content. Phase 1 keeps it inside the monorepo under `evals/bench/`, but the layout is intentionally shaped so it can move into a standalone repository later with minimal churn.

This phase does not implement the runner. It establishes:

- where imported benchmark manifests belong
- where Paperclip-native tasks belong
- where starter company packages belong
- where runner, evaluator, Python bridge, ops, and generated run artifacts belong
- the initial schema contract for task and suite manifests

## Layout

| Path | Purpose |
|---|---|
| `bench.schema.json` | Shared JSON Schema definitions for `paperclip-bench/task/v1` and `paperclip-bench/suite/v1`. |
| `suites/` | Versioned suite manifests such as local smoke, SWE-bench Lite smoke, and Paperclip-native smoke. |
| `benchmarks/imported/` | Imported benchmark metadata and normalized task manifests without vendoring third-party source repositories. |
| `benchmarks/paperclip-native/` | Paperclip-native tasks, prompts, rubrics, evaluator config, and hidden-test placeholders. |
| `companies/` | Starter company packages used to seed Paperclip-native benchmark runs. |
| `fixtures/` | Fixture repo placeholders plus shared env/secrets examples. |
| `src/` | Future TypeScript CLI, task normalization, runners, evaluators, metrics, and reports. |
| `python/` | Future bridge scripts for ecosystems that already expect Python entrypoints. |
| `ops/` | Local Docker and single-machine cloud execution scaffolding. |
| `runs/` | Generated benchmark outputs. Raw runs stay untracked by default. |

## Manifest Validation

Phase 1 picks JSON Schema plus YAML manifests. The validation script loads YAML, validates against `bench.schema.json`, and checks both suite and task examples:

```bash
node evals/bench/scripts/validate-manifests.mjs
# or
pnpm --dir evals/bench run validate:manifests
```

## V0 Verification Intent

The first vertical slice will be considered wired correctly when these commands are all true:

1. `node evals/bench/scripts/validate-manifests.mjs` passes.
2. A contributor can locate imported tasks, native tasks, starter companies, runner code, Python bridge code, ops files, and generated runs from this directory layout alone.
3. Later phases can add implementation in place without changing manifest ids or top-level directory meaning.

## Notes

- `.paperclip.yaml` starter-company files are placeholders in this phase. Their exact import/runtime contract lands with the Paperclip runner integration work.
- Hidden tests are represented as directories only. Real evaluator wiring lands in later phases.
- The current Paperclip CLI already has early bench commands under `cli/src/commands/bench.ts`; this scaffold defines the repository contract those commands can grow into.
