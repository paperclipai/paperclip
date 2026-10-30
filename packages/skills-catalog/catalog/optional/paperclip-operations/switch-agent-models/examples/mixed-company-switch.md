# Example: move a mixed company onto a cheaper model

## Input

> "Acme's provider bill is climbing. Put every agent on `beam-free`. Two of them use the Paperclip connection; the rest go through our gateway, where the alias is `opencode-go-beam-free`."

## Apply the skill

```sh
export PAPERCLIP_API_URL=http://127.0.0.1:3100
export PAPERCLIP_GATEWAY_URL=http://127.0.0.1:8317

python3 scripts/switch_models.py --company "Acme" list
```

```
agent          resolves    model                        adapter
-------------  ----------  ---------------------------  ----------------
Researcher     provider    anthropic/claude-sonnet-4-5  codex_local
Builder        connection  paperclip/frontier-pro       paperclip_runner
Reviewer       provider    opencode-go-deepseek-pro     claude_local
```

The `resolves` column is the whole decision: the Builder needs a connection id, the other two need the gateway alias.

```sh
python3 scripts/switch_models.py --company "Acme" plan --all \
  --model opencode-go-beam-free \
  --connection-model beam-free
```

```
agent       resolves    before                       after                       validation
----------  ----------  ---------------------------  --------------------------  --------------
Researcher  provider    anthropic/claude-sonnet-4-5  opencode-go-beam-free       gateway model
Builder     connection  paperclip/frontier-pro       paperclip/beam-free         connection model
Reviewer    provider    opencode-go-deepseek-pro     opencode-go-beam-free       gateway model

3 agent(s) ready
```

Nothing has been written yet. Apply:

```sh
python3 scripts/switch_models.py --company "Acme" apply --all \
  --model opencode-go-beam-free --connection-model beam-free --yes --verify
```

```
ok    Researcher: anthropic/claude-sonnet-4-5 -> opencode-go-beam-free
ok    Builder: paperclip/frontier-pro -> paperclip/beam-free
ok    Reviewer: opencode-go-deepseek-pro -> opencode-go-beam-free

snapshot: /home/ops/.paperclip/model-switch-snapshots/20261028T093000Z.json
rollback: switch_models.py rollback --snapshot /home/ops/.paperclip/model-switch-snapshots/20261028T093000Z.json --yes
verify: every applied model confirmed
```

## Report

```
Switched 3 agents in Acme to Beam Free.

| agent      | before                       | after                     |
| Researcher | anthropic/claude-sonnet-4-5  | opencode-go-beam-free     |
| Builder    | paperclip/frontier-pro       | paperclip/beam-free       |
| Reviewer   | opencode-go-deepseek-pro     | opencode-go-beam-free     |

Verified by re-reading all three agents after the write.
Rollback: switch_models.py rollback --snapshot ~/.paperclip/model-switch-snapshots/20261028T093000Z.json --yes
```

A partial write is reported as a partial write: name the agent and the HTTP status, and leave the snapshot path in the reply so the rollback can reach the agents that did change.
