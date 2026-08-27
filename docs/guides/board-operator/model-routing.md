---
title: Model routing defaults
summary: Applying and verifying the cross-family Cloud Reviewer default
---

The Model-Routing Policy rev 2 requires every Plan-Attacker, Goal-Alignment
checker, and Independent Reviewer to use a different model family than the
Planner or Executor it checks. Cross-family independence is satisfied by
assigning the checker to a different-family agent — one whose adapter is in the
other family. A per-issue `assigneeAdapterOverrides.adapterConfig.model` pin
carries no `adapterType`, so it cannot change the assigned agent's adapter. For
a family-bound adapter (`claude_local` → Claude, `codex_local` → GPT) the pin
therefore stays within that adapter's single family and cannot reach the other,
so it is not a substitute for a different-family agent. A multi-provider adapter
is a partial exception: `hermes_local` can infer the provider from the pinned
model, but only as a fallback — an explicit `provider` in its config, or a
configured Hermes provider whose model matches the pin, takes precedence and
keeps that provider. So a pin there can move between the families it serves
(e.g. Qwen and Gemma) without changing `adapterType` only when provider
resolution falls through to the model name — if you route a cross-family check
that way, always verify the resulting model family on the run ledger. For the Claude/GPT
cloud lanes, always assign a different-family agent. The Cloud Reviewer default
is the company-level fallback for cloud work.

## Cloud Reviewer default

The reviewed default is:

```json
{
  "adapterType": "claude_local",
  "adapterConfig": {
    "model": "claude-opus-4-8"
  }
}
```

Apply it only after this PR is merged **and** the separate CEO instruction-file
approval is granted — passing the review gate alone is not sufficient. From the
repository root, run the dry-run first:

```sh
scripts/configure-cloud-reviewer-default.sh
```

Then apply explicitly:

```sh
scripts/configure-cloud-reviewer-default.sh --apply
```

The script resolves the single `Cloud Reviewer*` agent in the selected company,
refuses ambiguous or unrelated targets, preserves adapter-agnostic settings
through the normal agent PATCH merge behavior, and verifies the resulting
adapter type and model. Pass `--agent-id` when a company intentionally has
multiple Cloud Reviewer agents.

After applying, verify the agent directly:

```sh
curl -fsS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/agents/<cloud-reviewer-id>" \
  | jq '{name, adapterType, model: .adapterConfig.model}'
```

Before promoting the flip, run **three consecutive canary runs**: assign a
GPT-executed review child to the Cloud Reviewer without an issue-level model
override. Each run ledger must show `claude-opus-4-8`; an issue that carries an
explicit override is not a valid default-routing sample. Promote only after all
three consecutive runs are clean.

## High-volume do-er default

The high-volume Cloud Iterator is the primary do-er for cloud execution. It
uses the GPT lane to avoid spending cloud Claude quota on repeated execution
heartbeats. The Cloud Planner stays on Claude because it is a gate for planning
quality. The Cloud Reviewer stays on Claude because it is a cross-family gate
for GPT execution.

Resolve each agent by name within your own company; the ids are instance-local.

| Role | Agent | Before | After |
|---|---|---|---|
| Iterator (do-er) | Cloud Iterator | `claude_local / claude-sonnet-5` | **`codex_local / gpt-5.6-luna`** |
| Reviewer (gate) | Cloud Reviewer | `codex_local / gpt-5.6-luna` | **`claude_local / claude-opus-4-8`** |
| Executor (do-er) | Cloud Executor / Codex Code Executor | `codex_local / gpt-5.6-terra` | unchanged |
| Iterator (do-er) | Codex Code Iterator | `codex_local / gpt-5.6-luna` | unchanged |
| Build/Test-Repair | Codex Build/Test Repair | `codex_local / gpt-5.6-luna` | unchanged |
| Planner (gate) | Cloud Planner | `claude_local / claude-opus-4-8` | unchanged |

Apply the Cloud Iterator change only after this PR is merged **and** the
separate CEO instruction-file approval is granted — passing the cross-family
review gate alone is not sufficient. The helper is dry-run only by default:

```sh
scripts/configure-high-volume-gpt-routing.sh
scripts/configure-high-volume-gpt-routing.sh --apply
```

The helper resolves the single `Cloud Iterator*` agent in the selected company,
refuses ambiguous or unrelated targets, and supports `--agent-id` when a
company intentionally has multiple matching agents. It sends the normal agent
PATCH request with `X-Paperclip-Run-Id` when `PAPERCLIP_RUN_ID` is set, then
verifies `codex_local / gpt-5.6-luna` in the response.

After applying, verify the agent directly:

```sh
curl -fsS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/agents/<cloud-iterator-id>" \
  | jq '{name, adapterType, model: .adapterConfig.model}'
```

Before promoting the flip, run **three consecutive canary runs**: assign a
high-volume issue to the Cloud Iterator without an issue-level model override.
Each run ledger must show `gpt-5.6-luna`; an issue that carries an explicit
override is not a valid default-routing sample. Promote only after all three
consecutive runs are clean.
