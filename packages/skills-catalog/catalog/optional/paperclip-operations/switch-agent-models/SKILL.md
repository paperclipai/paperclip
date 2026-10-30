---
name: switch-agent-models
description: >
  Repoint a company's agents at a different model in bulk: resolve what each
  agent actually accepts, plan without writing, apply with a snapshot, verify
  the responses, and roll back. Use when a quota runs out or a provider
  changes.
key: paperclipai/optional/paperclip-operations/switch-agent-models
recommendedForRoles:
  - general
  - manager
tags:
  - agents
  - models
  - providers
  - bulk-edit
  - rollback
requires:
  - python3
---

# Switch Agent Models

Move selected agents of one company onto a different model, prove the change landed, and keep a way back.

## When to use

- A provider quota is nearly spent and work must continue on another model.
- A new provider, gateway, or cheaper model should replace the current one.
- A model change went wrong and the previous values must be restored.

## When not to use

- One agent, one model, no verification needed: use the agent's settings page.
- The user only wants to know which model an agent runs: `list` is enough.
- The request is about prompts, budgets, or instructions: this skill changes one field.

## The rule that decides the value

An agent stores its model in `adapterConfig.model`. A bound AI connection decides the family, not the current string:

| Agent | How it resolves | Write |
| --- | --- | --- |
| `runtimeConfig.aiConnection` is set | Paperclip projects that company AI connection into the agent's harness | `paperclip/<id>` or `openrouter/<id>` for OpenCode depending on the route; `openrouter/<id>` for Pi on OpenRouter and `<provider>/<id>` for a native provider; bare `<id>` for other harnesses |
| no binding | the agent's own provider resolves it — a local CLI config, a gateway alias, or a direct provider id | the exact string that provider accepts |

A record written before bindings existed still counts as connection-backed when its value starts with `paperclip/`.

Two consequences:

- `aiRoutingModel()` prefixes OpenCode connection models with `openrouter/` or `paperclip/` according to the bound route. Pi names its provider, so it takes `openrouter/` or `<provider>/`; Codex and Claude use bare model IDs. A saved value is not proof that the next run will resolve it correctly.
- `routing` is optional, so a native OpenRouter account and a `responsible_user` binding resolve without it. The prefix follows the provider in those cases instead of blocking the target.
- The trailing `(max)`, `(high)`, `(medium)`, or `(low)` on some existing models is a reasoning hint. The script preserves the suffix the agent already has, appends it only when the new value has none, and strips it from validation lookups. Pass `--drop-suffix` to remove it.

## Workflow

`$PAPERCLIP_API_URL` is required. `PAPERCLIP_COMPANY_ID` names the company unless `--company` is passed; `--company` accepts an id or a name. `PAPERCLIP_API_KEY` is optional in local-trusted installs and required otherwise.

```sh
# 0. which company, and what is configured today
python3 scripts/switch_models.py companies
python3 scripts/switch_models.py list

# 1. plan, no writes, with validation where a source exists
python3 scripts/switch_models.py plan --all \
  --model opencode-go-beam-free \
  --connection-model beam-free

# 2. apply, snapshot, then re-read every touched agent
python3 scripts/switch_models.py apply --select "GPU 执行,交付主管" \
  --model opencode-go-beam-free --connection-model beam-free --yes --verify

# 3. undo
python3 scripts/switch_models.py rollback \
  --snapshot ~/.paperclip/model-switch-snapshots/20261028T140000Z.json --yes
```

Selection accepts exact names, `re:<pattern>`, or `--all`. Run these commands from this skill's directory, or call the script by its absolute path.

`--model` is the literal value for agents that resolve through their provider. `--connection-model` is the upstream model ID for a company AI connection, not a preformatted harness value; the script adds any required harness prefix. For example, upstream `openrouter/auto` becomes `openrouter/openrouter/auto` for OpenCode and Pi. Give both flags when the company has both kinds, or select each kind in its own run.

## Validation

Validation is best-effort and never invents a source:

| Agent kind | Checked against | If the source is missing |
| --- | --- | --- |
| connection | the bound connection's model IDs from `GET /api/companies/{id}/ai-connections` | reported as unverified; OpenCode and Pi targets are blocked when the bound route cannot be determined |
| provider | `GET {gateway}/v1/models` when `--gateway-url` or `PAPERCLIP_GATEWAY_URL` is set | reported as unverified |

`--gateway-url` and `--gateway-key` belong to `plan` and `apply`; they override `PAPERCLIP_GATEWAY_URL` and `PAPERCLIP_GATEWAY_KEY`.

Unverified is not an error by default: many installs run CLI agents against a provider the server cannot see. `--force` skips a failed check; a failed check without `--force` blocks the write.

## Safety

- `plan` writes nothing and needs no confirmation.
- `apply` needs `--yes`; it writes a snapshot before the first change, then compares each PATCH response to the requested model. Every apply gets its own snapshot file, so two runs in the same second cannot overwrite each other.
- On rollback, verify the saved state against the API response. An unset model may be normalized to a concrete default by the server, so do not claim an exact restoration when the returned value differs.
- Only `adapterConfig.model` changes. Status, budget, permissions, instructions, and connections stay as they are.
- Report the snapshot path and the rollback command with the result. A switch the user cannot undo is not a finished switch.

## Shape of the result

Report the table the script printed — agent, resolution kind, before, after, validation — plus the snapshot path. If a write failed, say which agent and which HTTP status; do not describe a partial switch as done.

## Install

This directory is portable. Install a copy into the user-level skill homes of the machine that runs the API:

```sh
./install.sh --all                      # every user-level skill home that already exists
./install.sh --dsh --agents             # DeepSeek Harness, and the shared ~/.agents home
./install.sh --claude --codex           # pick the homes explicitly
./install.sh --dir ~/team-skills        # any directory that holds skills
```

The homes are `~/.dsh/skills` (DeepSeek Harness), `~/.agents/skills` (shared), `~/.claude/skills`, `~/.codex/skills`, and `~/.kimi-code/skills`; override any of them with `DSH_SKILLS_DIR`, `AGENTS_SKILLS_DIR`, `CLAUDE_SKILLS_DIR`, `CODEX_SKILLS_DIR`, or `KIMI_SKILLS_DIR`. Start a new agent session after installing so it discovers the skill.

When several tools read the same home tree, keep one real copy and link the rest to it:

```sh
./install.sh --canonical ~/.agents/skills --dsh --claude --codex
```

That writes `~/.agents/skills/switch-agent-models` and points the other homes at it. A copy per home also works, but the copies drift apart; `--canonical` keeps one source of truth.

`--force` replaces a different copy, `--dry-run` prints the plan, and `--uninstall --force` removes it. To update or remove an installed copy, run the installer from a separate source directory: it refuses to overwrite or delete its own source.

Read [references/model-resolution.md](references/model-resolution.md) for the resolution rules and failure signatures, and [examples/](examples/) for two complete walkthroughs.
