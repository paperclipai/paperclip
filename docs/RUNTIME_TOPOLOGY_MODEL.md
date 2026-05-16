# Runtime Topology Model

How Paperclip/Selarix organizes operational state on disk, and how to inspect it.

## Instance Layout

All runtime state lives under `~/.paperclip/instances/default/`:

```
~/.paperclip/instances/default/
├── config.json                  # Instance configuration (DB, server, auth)
├── companies/                   # One directory per company (UUID)
│   └── {company_id}/
│       ├── agents/              # Agent definitions
│       │   └── {agent_id}/
│       │       └── instructions/
│       │           └── AGENTS.md
│       └── claude-prompt-cache/ # Cached prompt fragments (hash-keyed)
│           └── {sha256_hash}/
│               └── agent-instructions.md
├── projects/                    # Projects grouped by company
│   └── {company_id}/
│       └── {project_id}/       # Project workspace
├── data/
│   ├── backups/                # SQL backup archives (.sql.gz)
│   ├── run-logs/               # Agent execution logs
│   │   └── {company_id}/
│   │       └── {agent_id}/
│   └── storage/                # Uploaded assets (images, files)
│       └── {company_id}/
│           └── assets/
├── db/                         # Embedded PostgreSQL data directory
├── logs/                       # Application logs
├── secrets/                    # Secret configuration
├── telemetry/                  # Telemetry data
└── workspaces/                 # Workspace state
```

## Entity Relationships

```
Company (UUID)
├── has many → Agents (UUID)
│   └── has → Instructions (AGENTS.md)
├── has many → Projects (UUID)
├── has many → Prompt Caches (SHA-256 hash)
├── has many → Run Logs (per agent)
└── has many → Storage Assets (date-organized)
```

## Key Concepts

### Companies
Top-level organizational unit. Each company is a UUID directory under `companies/`. A company owns agents, projects, prompt caches, and storage.

### Agents
Defined under `companies/{id}/agents/{agent_id}/instructions/`. Each agent has an `AGENTS.md` file describing its behavior and configuration.

### Prompt Caches
Stored under `companies/{id}/claude-prompt-cache/`. Keyed by SHA-256 hash of the prompt content. Contains pre-processed instruction files for faster agent startup.

### Projects
Under `projects/{company_id}/{project_id}/`. Represent discrete workstreams within a company. May contain workspace-specific configuration.

### Backups
Compressed SQL dumps under `data/backups/`. Named `paperclip-YYYYMMDD-HHMMSS.sql.gz`. Backup schedule and retention configured in `config.json`.

### Run Logs
Agent execution logs under `data/run-logs/{company_id}/{agent_id}/`. Used for debugging and audit trail.

### Storage Assets
Uploaded files under `data/storage/{company_id}/assets/`. Organized by date (`YYYY/MM/DD/`).

## Health Indicators

| Flag | Meaning | Action |
|------|---------|--------|
| HEALTHY | No issues detected | None |
| ORPHANED_STATE | Runtime artifacts reference nonexistent entities | Investigate, then clean up |
| STALE_COMPANIES | Companies with no activity beyond threshold | Verify still needed |
| DUPLICATE_AGENTS | Multiple agents with identical instructions | Consolidate or verify intentional |
| MISSING_METADATA | Expected metadata files absent | Restore or recreate |
| BACKUP_GAP | No backup within 24h | Check backup scheduler |
| NO_BACKUPS | Backup directory missing | Reconfigure backups |

## Using the Topology Report

Generate a report:

```bash
# Markdown summary to stdout
python scripts/runtime_topology_report.py

# JSON output
python scripts/runtime_topology_report.py --json

# Write both JSON + markdown to a directory
python scripts/runtime_topology_report.py --output /tmp/topology

# Custom staleness threshold (default: 14 days)
python scripts/runtime_topology_report.py --stale-days 7

# Custom instance root
python scripts/runtime_topology_report.py --instance-root /path/to/instance
```

## Runbook: Understanding Runtime Topology

### When to run the topology report

- **During incident response** — to check for orphaned or stale state that may indicate a failed migration or cleanup.
- **Before major upgrades** — snapshot current topology for comparison after upgrade.
- **Monthly hygiene** — identify accumulating backup storage, stale companies, orphaned agents.
- **After bulk operations** — verify no state was left behind (e.g., company deletion should clean agents, projects, caches, storage, and run logs).

### Interpreting the report

1. **Start with health flags.** If `HEALTHY`, no immediate action needed.
2. **Check orphaned state first.** Orphans indicate incomplete cleanup — a company was deleted from the database but its disk artifacts remain. Safe to archive/remove after confirming the entity no longer exists in the DB.
3. **Review stale companies.** A company with no activity for 14+ days may be abandoned. Cross-reference with the database to determine if it still has active users.
4. **Check backup continuity.** Gaps in backup timestamps indicate the backup scheduler was stopped. Verify the cron/interval is still running.
5. **Review duplicate agents.** Two agents with identical instruction hashes may be intentional (same template deployed to multiple companies) or accidental (copy-paste). Document the intended state.

### Common remediation actions

| Situation | Action |
|-----------|--------|
| Orphaned run logs | `rm -rf ~/.paperclip/instances/default/data/run-logs/{company_id}/{agent_id}` |
| Orphaned storage | Archive to cold storage, then remove |
| Stale prompt caches | Safe to delete — they regenerate on next agent startup |
| Backup directory growing | Adjust `retentionDays` in `config.json`, or archive older backups externally |
| Missing agent instructions | Re-deploy agent configuration from source of truth |

### Storage sizing guidelines

- **Prompt caches**: ~1-10 KB each, regenerate automatically. Safe to purge entirely.
- **Run logs**: Grow over time. Consider log rotation if total exceeds 1 GB.
- **Backups**: Each archive is 7-56 MB (varies with DB size). At hourly intervals with 30-day retention, budget ~20-50 GB.
- **Storage assets**: Uploaded files. Size depends on usage. Monitor for unexpected growth.

### Automating topology checks

Add to a scheduled task or CI pipeline:

```bash
# Fail CI if orphans detected
python scripts/runtime_topology_report.py --json | python -c "
import json, sys
report = json.load(sys.stdin)
if report['orphans']['total_orphans'] > 0:
    print(f'FAIL: {report[\"orphans\"][\"total_orphans\"]} orphans found')
    sys.exit(1)
print('OK: No orphans')
"
```
