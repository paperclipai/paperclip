# Workflow Eval Packs v0

This pack is a deterministic, offline regression harness for Paperclip workflow/orchestration failure modes observed during EAOS dogfood work.

It is intentionally separate from `evals/promptfoo/`:

- no LLM calls
- no external network or vendor calls
- no production data
- no live Paperclip API reads/writes
- all IDs, comments, paths, and run metadata are synthetic or hand-redacted

## Pack contents

`pack.json` registers five golden replay cases:

1. `useful-output-but-failed-adapter` — preserves useful comments/artifacts/validation evidence even when the adapter/process exits failed.
2. `duplicate-recovery-child` — detects duplicate recovery children and requires a single canonical active recovery path.
3. `stale-blocker-graph` — detects final/stale blockers that still block a parent while an active canonical child exists.
4. `missing-validation-evidence` — detects completion handoffs that lack test/typecheck/build/dry-run evidence.
5. `review-stage-hang` — detects review stages stuck after reviewer process loss.

Each fixture has:

- `redaction.sanitized: true`
- synthetic issue/run IDs
- local-only actions
- an `expectedOutcome` route explaining the desired workflow disposition

## Local run commands

From the repository root:

```bash
pnpm workflow-evals:replay
pnpm workflow-evals:replay -- --json
pnpm workflow-evals:replay -- --case stale-blocker-graph
pnpm test:workflow-evals
```

Equivalent direct commands:

```bash
node scripts/workflow-eval-replay.mjs --pack evals/workflow-packs/v0/pack.json
node --test scripts/workflow-eval-replay.test.mjs
```

## VPS safety notes

Run this harness as a single local process. It is lightweight and should not use heavy parallelism on the small VPS.

Do not wrap it in repo-wide test/build loops unless the issue explicitly needs that broader validation. The replay command reads local JSON fixtures only and fails closed if a fixture declares external HTTP/vendor actions.

## Adding a case

1. Add a sanitized fixture under `fixtures/`.
2. Register it in `pack.json` with an expected `classification` and deterministic checks.
3. Add or update `scripts/workflow-eval-replay.test.mjs` if the new case needs a new check.
4. Run `pnpm test:workflow-evals` and `pnpm workflow-evals:replay`.

## Redaction contract

Fixtures must not contain raw Paperclip production IDs, raw run logs, API keys, bearer tokens, DB URLs, private chat IDs, or vendor request payloads. Use synthetic IDs and short summaries instead.
