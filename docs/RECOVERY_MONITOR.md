# PaperClip Recovery Monitor

## Overview

The Recovery Monitor is an automated system that periodically checks for stalled workflows in Paperclip and executes recovery actions to restore normal operation. It runs every hour via GitHub Actions and can also be triggered manually.

## Purpose

The Recovery Monitor detects and reports five categories of stalled workflows:

1. **Exchange API Timeout** — Exchange API calls that have stalled for >2 hours
2. **Position Mismatch** — Position reconciliation issues stalled for >1 hour
3. **Signal Timeout** — Signal generation pipelines stalled for >3 hours
4. **Orphan Checkout** — Checked-out issues with no live heartbeat run for >6 hours
5. **Agent Paused Stalled** — Paused agents with in_progress work for >2 hours

## Architecture

### Components

- **`scripts/paperclip_recovery_monitor.py`** — Main recovery monitor script
  - Connects to the Paperclip database
  - Checks for stalled workflows matching each scenario
  - Generates reports and executes recovery actions
  - Posts recovery comments to affected issues

- **`.github/workflows/paperclip-recovery-monitor.yml`** — GitHub Actions workflow
  - Runs on hourly schedule (every hour at :15)
  - Can be triggered manually via `workflow_dispatch`
  - Executes both dry-run and actual recovery
  - Logs results and uploads artifacts

- **`tests/recovery_monitor_validation.py`** — Test suite for monitor logic
  - Validates report generation
  - Tests dry-run action previews
  - Verifies all scenarios are implemented

## How It Works

### Detection Phase

The monitor queries the database for issues matching each stalled workflow scenario:

```python
monitor = RecoveryMonitor(db_url, api_url, api_key)
matches = monitor.find_matches()  # Returns list of StalledWorkflow objects
```

### Reporting Phase

When matches are found, the monitor generates a human-readable report:

```
⚠ Found 3 stalled workflow(s):

## exchange_api_timeout (1 issue(s))
- Issue: BTCAAAAA-001
  Agent: agent-123
  Stalled for: 150 minutes
```

### Recovery Phase

For each stalled workflow, the monitor executes scenario-specific recovery actions:

| Scenario | Action |
|----------|--------|
| `exchange_api_timeout` | Posts recovery comment, escalates to exchange_monitor agent |
| `position_mismatch` | Posts recovery comment, initiates position reconciliation |
| `signal_timeout` | Posts recovery comment, wakes signal_generator agent |
| `orphan_checkout` | Posts recovery comment, releases checkout, returns to queue |
| `agent_paused_stalled` | Posts escalation comment for manual intervention |

## Usage

### Local Testing

```bash
# Check for stalled workflows
python3 scripts/paperclip_recovery_monitor.py matches

# Output as JSON
python3 scripts/paperclip_recovery_monitor.py matches --json

# Preview recovery actions (dry-run)
python3 scripts/paperclip_recovery_monitor.py run --dry-run

# Execute recovery actions
python3 scripts/paperclip_recovery_monitor.py run
```

### Environment Variables

Required when running locally:

- `DATABASE_URL` — PostgreSQL connection string (default: `postgres://paperclip:paperclip@localhost:5432/paperclip`)
- `PAPERCLIP_API_URL` — Paperclip API endpoint (default: `http://localhost:3100`)
- `PAPERCLIP_API_KEY` — API authentication key
- `PAPERCLIP_RUN_ID` — Optional run ID for tracking

### GitHub Actions

The recovery monitor runs automatically every hour. To trigger manually:

1. Go to GitHub Actions
2. Select "PaperClip Recovery Monitor" workflow
3. Click "Run workflow" button

## Thresholds

Each scenario has a time threshold before recovery is triggered:

| Scenario | Threshold |
|----------|-----------|
| Exchange API Timeout | 2 hours |
| Position Mismatch | 1 hour |
| Signal Timeout | 3 hours |
| Orphan Checkout | 6 hours |
| Agent Paused Stalled | 2 hours |

These thresholds are hardcoded in the SQL queries and can be adjusted as needed.

## Monitoring and Alerts

### Dry-Run Mode

The GitHub Actions workflow runs in dry-run mode first, allowing operators to review what recovery actions would be taken before they are executed.

### Execution Logs

Logs are uploaded as GitHub Actions artifacts for audit and troubleshooting:

- `recovery-dry-run.txt` — Dry-run preview of actions
- `recovery-execute.txt` — Actual execution results
- `recovery-summary.txt` — Combined summary

## Safety

- **No immediate live trading changes** — The recovery monitor escalates rather than making direct changes to core systems
- **Reversible actions** — Most recovery actions (comments, escalations) are non-destructive
- **Audit trail** — All actions are logged and posted as issue comments
- **Dry-run gate** — Dry-run phase allows review before execution

## Future Enhancements

Potential improvements for future iterations:

1. **Configurable thresholds** — Move time thresholds to database configuration
2. **Scenario-specific reporting** — Different notification channels per scenario
3. **Recovery metrics** — Track success/failure rates of recovery actions
4. **Smart escalation** — Route escalations to appropriate team members
5. **Historical analysis** — Build reports on stalled workflow patterns

## Troubleshooting

### "Failed to connect to database"

Verify environment variables are set correctly:

```bash
echo $DATABASE_URL
echo $PAPERCLIP_API_URL
echo $PAPERCLIP_API_KEY
```

### "Permission denied" on API calls

Ensure the API key has sufficient permissions. Recovery actions may require additional scopes.

### No stalled workflows found

This is the desired state! The monitor is working correctly and recovery actions are functioning normally.

### Recovery actions failing

Check the execution logs in GitHub Actions artifacts. Common causes:

- API key permissions
- Network connectivity
- Database connection issues
- Issue accessibility constraints
