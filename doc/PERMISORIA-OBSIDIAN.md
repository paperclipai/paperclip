# Permisoria Obsidian Integration

This repository remains the implementation source for Paperclip.

For the local `Permisoria Admin` Paperclip company, curated operating knowledge lives in the separate Permisoria Obsidian vault:

`/Users/giovannytorresadrovet/Documents/Permisoria Obsidian Vault`

Start in the vault at:

- `00_Index/Source of Truth Map.md`
- `00_Index/Paperclip Operations.md`
- `20_Runbooks/Paperclip Runtime Operations.md`
- `20_Runbooks/Paperclip Obsidian Integration.md`
- `40_Reference/Paperclip Obsidian Access Map.md`
- `40_Reference/Paperclip Skill Cleanup Map.md`

## Ownership Boundary

Paperclip owns live execution state:

- issues, comments, work products, approvals, activity
- agents, skills, projects, goals, budgets, cost events
- secrets, runtime env bindings, heartbeat runs, checkout/run state

This repository owns implementation contracts:

- code, migrations, tests, build/deploy commands
- `doc/SPEC-implementation.md` for the V1 build contract
- `doc/execution-semantics.md` for runtime/liveness semantics
- `doc/DEVELOPING.md` for local development commands
- API and adapter documentation under `docs/`

Obsidian owns curated Permisoria operating memory:

- source-of-truth maps
- runbooks
- durable operating decisions
- reviewed snapshots that point back to Paperclip or Git

Do not copy raw Paperclip run logs, full issue threads, secrets, tokens, or transient execution traces into Obsidian.

## When Updating Docs

- Update repo docs when behavior, commands, schema, APIs, or implementation contracts change.
- Update Obsidian when the durable operating policy or Permisoria-specific source-of-truth map changes.
- If repo docs and Obsidian disagree, trust repo docs for implementation behavior and Paperclip for live state, then update the Obsidian note.
