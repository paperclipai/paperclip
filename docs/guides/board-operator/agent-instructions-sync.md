---
title: Agent Instructions Sync
summary: Materialize live instructions into canonical AGENTS.md files and switch local agents to external mode
---

For local Paperclip agents, the cleanest way to avoid instruction drift is to use a canonical `AGENTS.md` on disk and point the agent at that file with `instructionsBundleMode: external`.

This avoids maintaining both:

- a git-tracked instructions file
- a second managed bundle copy under the Paperclip instance directory

## Recommended Pattern

Use `AGENTS.md` as the canonical file name everywhere. Keep one file per agent in your source tree, then run the migration script as a board user or an ancestor manager for the target agent.

The migration flow is:

1. Export the agent's live `AGENTS.md` into the canonical source path.
2. Rename or remove any legacy `AGENT.md`.
3. Switch the agent from `managed` to `external` mode so future runs read directly from the canonical file.
4. Verify the bundle metadata now points at the external path.

## Manifest Format

Create a JSON manifest:

```json
{
  "agents": [
    {
      "agentId": "11111111-1111-4111-8111-111111111111",
      "label": "Lead Engineer",
      "sourceFile": "/absolute/path/to/agents/lead-engineer/AGENTS.md"
    }
  ]
}
```

Fields:

- `agentId`: Paperclip agent id
- `sourceFile`: canonical AGENTS path to write and later read at runtime
- `entryFile`: optional, defaults to `AGENTS.md`
- `legacyFile`: optional legacy singular path to back up or remove
- `label`: optional human-readable name for script output

## Migrate

Dry run:

```sh
tsx scripts/migrate-agent-instructions-to-external.ts \
  --manifest ./agent-instructions.json
```

Write canonical files but keep the agents on managed bundles:

```sh
tsx scripts/migrate-agent-instructions-to-external.ts \
  --manifest ./agent-instructions.json \
  --write-files
```

Write files and switch agents to external mode:

```sh
tsx scripts/migrate-agent-instructions-to-external.ts \
  --manifest ./agent-instructions.json \
  --write-files \
  --switch-mode
```

Remove a legacy `AGENT.md` instead of backing it up:

```sh
tsx scripts/migrate-agent-instructions-to-external.ts \
  --manifest ./agent-instructions.json \
  --write-files \
  --switch-mode \
  --remove-legacy
```

## Drift Checks

If you keep any agents on managed bundles temporarily, or if you want a cron/CI guardrail, compare the canonical files against the live bundles:

```sh
tsx scripts/check-agent-instructions-drift.ts \
  --manifest ./agent-instructions.json
```

The command exits non-zero when any source file is missing or differs from the live bundle.

## Permissions

Switching bundle mode or updating instructions paths is restricted:

- the target agent can update itself
- an ancestor manager can update descendants
- board users can update any agent

If you only have read access, you can still run the drift checker and you can still materialize source files from live bundles, but the final `--switch-mode` step must be run by an authorized actor.
