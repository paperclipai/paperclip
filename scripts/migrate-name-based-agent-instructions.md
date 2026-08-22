# Migrate Name-Based Agent Instructions

## What

A one-time migration script that relocates agent instruction files from **name-based** directories (e.g. `agents/CTO/instructions`) to **UUID-based** directories (e.g. `agents/<agent-uuid>/instructions`).

Historically, a manager agent (e.g. CEO) could create instruction files for a new agent using the agent's display name as the directory name. The system only resolves instructions under `agents/{agent.id}/instructions`, so any files placed under `agents/{agent.name}/instructions` were invisible at runtime. This script finds those misplaced directories and copies their contents to the correct UUID-based path.

## When to Run

- **After upgrading** to a version where the CEO agent's system prompt has been updated to enforce UUID-based paths (the source-side fix). This ensures no new name-based directories will be created going forward.
- **Before decommissioning** any agent whose instructions may still reside in a name-based directory.
- Only needs to be run **once** per instance. Re-running is safe (idempotent) — already-migrated agents are automatically skipped.

## How It Works

1. Reads all agents from the database (`id`, `companyId`, `name`).
2. For each agent whose `name` is not a UUID:
   - Checks whether a name-based `instructions` directory exists at `{instanceRoot}/companies/{companyId}/agents/{name}/instructions`.
   - If it does **and** no UUID-based directory exists yet, the files are copied to `{instanceRoot}/companies/{companyId}/agents/{id}/instructions`.
3. **Collision detection**: If multiple agents in the same company share the same display name, the script logs a warning and skips that group — the operator must resolve the ambiguity manually.
4. **No overwrites**: If a UUID-based `instructions` directory already exists, the agent is skipped.
5. **No deletions**: Name-based source directories are **not** removed after migration. Remove them manually after verifying the results.

## Prerequisites

- `DATABASE_URL` environment variable must be set (used to query agent records).
- `PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID` environment variables must be set (used to resolve the instance root directory).

## Usage

### Dry Run (default)

Preview what would be migrated without making any changes:

```bash
DATABASE_URL="postgres://…" \
PAPERCLIP_HOME="/path/to/paperclip-home" \
PAPERCLIP_INSTANCE_ID="your-instance-id" \
npx tsx scripts/migrate-name-based-agent-instructions.ts
```

### Apply Migration

Execute the migration and persist changes to disk:

```bash
DATABASE_URL="postgres://…" \
PAPERCLIP_HOME="/path/to/paperclip-home" \
PAPERCLIP_INSTANCE_ID="your-instance-id" \
npx tsx scripts/migrate-name-based-agent-instructions.ts --apply
```

## Output

| Prefix | Meaning |
|--------|---------|
| `DRY-RUN:` | Would migrate this agent (dry-run mode only) |
| `MIGRATE:` | Successfully migrated this agent (`--apply` mode) |
| `SKIP:` | UUID-based instructions already exist; skipped |
| `WARN:` | Name collision detected; skipped — requires manual resolution |

## Post-Migration

After running with `--apply` and verifying the migrated files:

1. Confirm each agent loads its instructions correctly at runtime.
2. Remove the now-redundant name-based directories manually:
   ```bash
   rm -rf /path/to/paperclip-home/instances/<instance-id>/companies/<company-id>/agents/<AgentName>/instructions
   ```
3. For agents flagged with `WARN:` (name collisions), inspect the shared name-based directory and manually distribute the files to the correct UUID-based paths.
