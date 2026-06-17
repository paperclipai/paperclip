# Janitor Report Template

Use this template for every Janitor run.

```markdown
# Janitor Run Report — <ISO timestamp>

## Status

- Final status: `<clean|cleaned|skipped|needs-review>`
- Run type: `<scheduled|manual>`
- Agent ID: `<agent-id>`
- Host/container: `<host>`
- Started: `<timestamp>`
- Finished: `<timestamp>`

## Disk

| Mount | Before | After | Change |
|-------|--------|-------|--------|
| `/paperclip` | `<used>/<total>` | `<used>/<total>` | `<delta>` |
| `/tmp` | `<used>/<total>` | `<used>/<total>` | `<delta>` |

## Cleanup Summary

| Category | Candidates | Pruned | Skipped | Estimated freed |
|----------|------------|--------|---------|-----------------|
| Heartbeat artifacts | `<n>` | `<n>` | `<n>` | `<size>` |
| Orphaned workspaces | `<n>` | `<n>` | `<n>` | `<size>` |
| Temp dirs | `<n>` | `<n>` | `<n>` | `<size>` |
| Stale locks | `<n>` | `<n>` | `<n>` | `<size>` |
| DB maintenance | `<n>` | `<n>` | `<n>` | `<size>` |

## Skipped Items

- `<path-or-resource>` — `<reason>`

If none:

- None

## Anomalies

- `<severity>`: `<rule>` — `<details>`

If none:

- None

## Issues Opened

- `<issue-link>`

If none:

- None
```

## Final Status Rules

Use:

- `clean` when no cleanup candidates or anomalies exist
- `cleaned` when safe cleanup was performed and no anomalies remain
- `skipped` when cleanup was not performed because safety checks could not be completed
- `needs-review` when anomalies were found or a critical cleanup path is unsupported
