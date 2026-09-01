# Deterministic runner workflow evals

The workflow evaluator converts the stress-derived workflow catalog into a
credential-free matrix over sanitized Codex, OpenCode, and ACPX fixtures.
It evaluates provider-neutral behavior; the fixtures contain normalized events,
not prompts, credentials, raw reasoning, or provider traces.

The workspace-private `@paperclipai/paperclip-eval-kernel` package owns only
structural scenario-by-candidate orchestration. Runner-specific cases,
observations, scoring, traceability, and report rendering remain package-local.

Use:

```sh
pnpm --filter @paperclipai/paperclip-runner test:runner-workflow-evals
pnpm --filter @paperclipai/paperclip-runner report:runner-workflow-evals
```

The report command writes JSON, Markdown, JUnit, and GitHub-safe summaries
under `.paperclip-local/evals/workflows/`. It performs no network requests and
does not start a production provider.

The checked traceability manifest is
`spec/evals/stress-workflow-traceability.json`. The build gate fails when a
finding references an unknown workflow or a missing regression-test anchor.

Live schedules, paid provider campaigns, raw trace capture, and recorded
evidence are intentionally excluded from this slice.
