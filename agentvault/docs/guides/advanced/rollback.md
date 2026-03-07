# Rollback Guide

Rollback canister to previous deployment.

## Overview

Rollback restores a canister to a previous version when issues are detected.

```bash
agentvault rollback --canister-id <id> --version <n>
```

## Commands

### List Available Versions

```bash
agentvault rollback --canister-id <id> --list
```

Output:
```
Version  Deployed At           Status
-------  -------------------   --------
3        2026-02-12 14:30:00   Current
2        2026-02-11 09:15:00   Available
1        2026-02-10 16:45:00   Available
```

### Rollback to Version

```bash
# Rollback to version 2
agentvault rollback --canister-id <id> --version 2
```

### Force Rollback

```bash
# Skip confirmation
agentvault rollback --canister-id <id> --version 2 --force
```

## Options

| Option | Description |
|--------|-------------|
| `-c, --canister-id <id>` | Canister ID (required) |
| `--version <n>` | Version to rollback to |
| `--list` | List available versions |
| `--force` | Force without confirmation |

## Rollback Process

1. **Validation**: Verify canister exists and version is available
2. **Backup**: Create backup of current state
3. **Download**: Fetch previous version WASM
4. **Install**: Install previous version
5. **Restore**: Restore state from backup
6. **Verify**: Health check and validation

## Recovery Scenarios

### Failed Deployment

```bash
# 1. Check current status
agentvault status <canister-id>

# 2. List versions
agentvault rollback -c <canister-id> --list

# 3. Rollback
agentvault rollback -c <canister-id> --version <n>
```

### Corrupted State

```bash
# 1. Stop canister
agentvault stop <canister-id>

# 2. Restore from backup
agentvault backup restore <backup-id>

# 3. Start canister
agentvault start <canister-id>
```

### Performance Issues

```bash
# 1. Profile current version
agentvault profile -c <canister-id>

# 2. Compare with previous
agentvault rollback -c <canister-id> --list

# 3. Rollback if needed
agentvault rollback -c <canister-id> --version <n>
```

## Best Practices

### Before Rollback

- [ ] Identify the issue
- [ ] Check available versions
- [ ] Notify stakeholders
- [ ] Plan verification steps

### During Rollback

- [ ] Monitor logs
- [ ] Verify installation
- [ ] Test critical paths

### After Rollback

- [ ] Verify functionality
- [ ] Document incident
- [ ] Plan fix for rolled-back version
- [ ] Schedule re-deployment

## Rollback Limitations

| Limitation | Description |
|------------|-------------|
| State Compatibility | State must be compatible with older WASM |
| Version Availability | Only recent versions are retained |
| Downtime | Brief downtime during rollback |

## Troubleshooting

### Version Not Available

```bash
# Check backup storage
ls -la ~/.agentvault/backups/

# Restore from backup instead
agentvault backup restore <backup-id>
```

### State Incompatibility

```bash
# Fetch current state before rollback
agentvault fetch --canister-id <id>

# Rollback with state migration
agentvault rollback -c <id> --version <n> --migrate-state
```

### Rollback Fails

```bash
# Check canister status
agentvault info <canister-id>

# Verify cycles
agentvault cycles balance <canister-id>

# Check logs
agentvault logs <canister-id> --level error
```

## Related Commands

- [Promotion](./promotion.md) - Promote between environments
- [Backup](../../user/backups.md) - Backup and restore
- [Deployment](../../user/deployment.md) - Deployment guide
