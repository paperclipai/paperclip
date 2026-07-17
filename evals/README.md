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

# Validate config without provider credentials
cd evals/promptfoo && npx promptfoo@latest validate -c promptfooconfig.yaml

# Or run promptfoo directly
cd evals/promptfoo
promptfoo eval

# View results in browser
promptfoo view
```

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
| Memory provider binding | `phase5_memory` | Agent honors agent override before company default |
| Memory provenance audit | `phase5_memory` | Agent preserves inspectable source and operation records |
| Memory hook cost/trust | `phase5_memory` | Agent keeps memory hook cost attribution and source trust visible |
| Board command work objects | `phase5_control_surface` | Chat-like board commands create auditable work objects |

Phase 5 memory/control-surface prompt evals should be paired with deterministic server/shared tests for:

- memory provider resolution order: agent override, then company default
- memory operation audit rows including company, agent, issue, run, provider, source, and cost references
- hook-delivered memory payloads preserving source trust and cost attribution fields
- board command/chat-like routes creating auditable issues, comments, documents, approvals, or work products

### Adding new cases

1. Add a YAML file to `evals/promptfoo/tests/`
2. Follow the existing case format (see `core.yaml` for reference)
3. Run `promptfoo eval` to test

### Phases

- **Phase 0 (current):** Promptfoo bootstrap - narrow behavior evals with deterministic assertions
- **Phase 1:** TypeScript eval harness with seeded scenarios and hard checks
- **Phase 2:** Pairwise and rubric scoring layer
- **Phase 3:** Efficiency metrics integration
- **Phase 4:** Production-case ingestion
