# Paperclip Evals

Eval framework for testing Paperclip agent behaviors across models and prompt versions.

See [the evals framework plan](../doc/plans/2026-03-13-agent-evals-framework.md) for full design rationale.

## Quick Start

### Prerequisites

```bash
pnpm add -g promptfoo
```

You need an API key for at least one provider. Set one of:

```bash
export OPENROUTER_API_KEY=sk-or-...    # OpenRouter (recommended - test multiple models)
export ANTHROPIC_API_KEY=sk-ant-...     # Anthropic direct
export OPENAI_API_KEY=sk-...            # OpenAI direct
```

### Run evals

```bash
# Smoke test (default models)
pnpm evals:smoke

# Or run promptfoo directly
cd evals/promptfoo
promptfoo eval

# View results in browser
promptfoo view
```

## Paperclip Bench

`paperclipai bench` is the first-party benchmark harness for Paperclip-native and SWE-style task suites. It supports a deterministic `prepare` runner for prompt/render artifacts and a live `paperclip` runner that creates or reuses benchmark issues, wakes the assignee, and captures run metadata plus a final patch artifact.

```bash
# Prepare the bundled smoke suite
pnpm bench:smoke

# Validate any JSONL suite
pnpm paperclipai bench validate --tasks evals/bench/tasks/paperclip-native-smoke.jsonl

# Prepare artifacts for a custom suite
pnpm paperclipai bench run \
  --tasks path/to/tasks.jsonl \
  --benchmark missionbench \
  --paperclip-version current \
  --model anthropic/claude-sonnet-4.5 \
  --max-cost-usd 10 \
  --max-wall-clock-minutes 120 \
  --output .tmp/paperclip-bench/missionbench-run

# Run tasks live against a Paperclip dev server
pnpm paperclipai bench run \
  --runner paperclip \
  --tasks path/to/tasks.jsonl \
  --benchmark missionbench \
  --paperclip-version current \
  --model anthropic/claude-sonnet-4.5 \
  --company-id <company-id> \
  --assignee-agent-id <agent-id> \
  --project-id <project-id> \
  --goal-id <goal-id> \
  --max-cost-usd 10 \
  --max-wall-clock-minutes 120 \
  --output .tmp/paperclip-bench/missionbench-live
```

Task rows are JSONL objects. The parser accepts both camelCase and snake_case fields so suites can use MissionBench-style records:

```json
{"id":"missionbench-001","title":"Add audit logs","repo":"github.com/paperclipai/missionbench-saas","starting_commit":"abc123","problem_statement":"Add organization-level audit logs.","success_checks":["npm test"],"required_artifacts":["implementation patch","final PR summary"]}
```

Set `paperclip_issue_id`, `paperclip_issue_identifier`, `paperclipIssueRef`, or the same keys inside `metadata` to reuse an existing benchmark issue from the task row. Otherwise, `--create-issues -C <company-id>` creates one Paperclip issue per task for the `prepare` runner, and the live `paperclip` runner creates issues automatically when the task row does not already reference one. Created issues use the normalized prompt as the issue description and set `billingCode` to `bench:<run-id>` unless `--billing-code` is provided.

Live-run `results.jsonl` and per-task `trace.json` include the Paperclip issue id, observed heartbeat run ids, the final task status, a relative `patchPath` when a git diff was extracted from the execution workspace, and a `failureStage` when the task stops short of a clean `done` result.

### What's tested

Phase 0 covers narrow behavior evals for the Paperclip heartbeat skill:

| Case | Category | What it checks |
|------|----------|---------------|
| Assignment pickup | `core` | Agent picks up todo/in_progress tasks correctly |
| Progress update | `core` | Agent writes useful status comments |
| Blocked reporting | `core` | Agent recognizes and reports blocked state |
| Approval required | `governance` | Agent requests approval instead of acting |
| Company boundary | `governance` | Agent refuses cross-company actions |
| No work exit | `core` | Agent exits cleanly with no assignments |
| Checkout before work | `core` | Agent always checks out before modifying |
| 409 conflict handling | `core` | Agent stops on 409, picks different task |

### Adding new cases

1. Add a YAML file to `evals/promptfoo/cases/`
2. Follow the existing case format (see `core-assignment-pickup.yaml` for reference)
3. Run `promptfoo eval` to test

### Phases

- **Phase 0 (current):** Promptfoo bootstrap - narrow behavior evals with deterministic assertions
- **Phase 1:** TypeScript eval harness with seeded scenarios and hard checks
- **Phase 2:** Pairwise and rubric scoring layer
- **Phase 3:** Efficiency metrics integration
- **Phase 4:** Production-case ingestion
