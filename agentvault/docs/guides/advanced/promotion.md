# Promotion Guide

Promote canisters between environments.

## Overview

Promotion moves a canister from one environment to another (e.g., staging to production).

```bash
agentvault promote <agent-name> --from <source> --to <target>
```

## Promotion Flow

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│  Local   │────▶│ Staging  │────▶│    Prod  │
│ (Dev)    │     │  (Test)  │     │ (Live)   │
└──────────┘     └──────────┘     └──────────┘
```

## Commands

### Basic Promotion

```bash
# Promote from local to staging
agentvault promote my-agent --from local --to staging

# Promote from staging to production
agentvault promote my-agent --from staging --to production
```

### With WASM Deployment

```bash
# Promote and deploy WASM
agentvault promote my-agent -f staging -t prod -w ./dist/agent.wasm
```

### Blue-Green Deployment

```bash
# Enable zero-downtime deployment
agentvault promote my-agent --from staging --to prod --blue-green
```

## Options

| Option | Description |
|--------|-------------|
| `-f, --from <env>` | Source environment |
| `-t, --to <env>` | Target environment |
| `--target-canister <id>` | Target canister ID |
| `--blue-green` | Enable blue-green deployment |
| `-w, --wasm-path <path>` | Path to WASM file |
| `--skip-deploy` | Skip actual deploy, only update history |

## Blue-Green Deployment

Blue-green deployment creates a new canister alongside the existing one:

1. Deploy new version to "green" canister
2. Verify green canister health
3. Switch traffic to green
4. Decommission old "blue" canister

### Workflow

```bash
# 1. Promote with blue-green
agentvault promote my-agent --blue-green

# 2. Verify new canister
agentvault health <new-canister-id>

# 3. Switch routing (if applicable)
agentvault config set --routing <new-canister-id>

# 4. Remove old canister
agentvault delete <old-canister-id>
```

## Promotion History

View promotion history:

```bash
# List promotions
agentvault promote list <agent-name>

# Show promotion details
agentvault promote show <promotion-id>
```

## Best Practices

### Before Promotion

- [ ] All tests pass
- [ ] Code reviewed
- [ ] Backup created
- [ ] Environment variables configured

### During Promotion

- [ ] Monitor logs
- [ ] Verify health checks
- [ ] Test critical paths

### After Promotion

- [ ] Verify functionality
- [ ] Update documentation
- [ ] Notify stakeholders

## Troubleshooting

### Promotion Fails

```bash
# Check environment connectivity
agentvault status --network <env>

# Verify WASM file
ls -la ./dist/agent.wasm

# Check logs
agentvault logs --network <env>
```

### Blue-Green Issues

```bash
# List all canisters
agentvault list

# Check canister status
agentvault status <canister-id>

# Rollback if needed
agentvault rollback <canister-id>
```

## Related Commands

- [Rollback](./rollback.md) - Rollback to previous version
- [Backup](../../user/backups.md) - Create backups
- [Deployment](../../user/deployment.md) - Deployment guide
