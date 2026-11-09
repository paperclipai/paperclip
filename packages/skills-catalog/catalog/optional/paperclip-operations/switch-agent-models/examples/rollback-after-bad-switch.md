# Example: the new model is worse, put it back

## Input

> "We moved everything to `beam-free` this morning and reviews got sloppy. Roll it back."

## Apply the skill

Find the snapshot from the switch. It records the previous value of every agent that was touched.

```sh
ls -t ~/.paperclip/model-switch-snapshots/ | head -3
```

```sh
python3 scripts/switch_models.py rollback \
  --snapshot ~/.paperclip/model-switch-snapshots/20261028T093000Z.json
```

```
would restore Researcher: opencode-go-beam-free -> anthropic/claude-sonnet-4-5
would restore Builder: paperclip/beam-free -> paperclip/frontier-pro
would restore Reviewer: opencode-go-beam-free -> opencode-go-deepseek-pro

dry run: pass --yes to restore
```

That is a dry run: it prints the plan and writes nothing. Confirm, then run it again with `--yes`:

```sh
python3 scripts/switch_models.py rollback \
  --snapshot ~/.paperclip/model-switch-snapshots/20261028T093000Z.json --yes
```

```
ok    Researcher -> anthropic/claude-sonnet-4-5
ok    Builder -> paperclip/frontier-pro
ok    Reviewer -> opencode-go-deepseek-pro
```

## When no snapshot exists

The snapshot is the record, not the memory. Without one:

1. `list` the agents and note who is on the model being reverted.
2. Ask the user, or read the company's activity log, for the previous values.
3. `plan` the restore the same way a forward switch is planned — old value in `--model` or `--connection-model` — then `apply --yes --verify`. That run produces a snapshot of its own, so the restore is itself reversible.

Never restore by guessing a "better" model: the rollback target must be the value that was there before, or the user must choose a new one explicitly.
