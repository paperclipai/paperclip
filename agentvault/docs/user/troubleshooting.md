# Troubleshooting

This guide covers common issues and solutions when using AgentVault.

## Table of Contents

- [Installation Issues](#installation-issues)
- [Configuration Issues](#configuration-issues)
- [Deployment Issues](#deployment-issues)
- [Runtime Issues](#runtime-issues)
- [Performance Issues](#performance-issues)
- [Network Issues](#network-issues)

## Installation Issues

### npm install fails

**Problem:** `npm ERR!` during installation

**Solutions:**

```bash
# Clear npm cache
npm cache clean --force

# Use specific Node version
nvm install 18

# Install without optional dependencies
npm install --no-optional

# Check network connectivity
npm config set registry https://registry.npmjs.org/
```

### dfx not found

**Problem:** `command not found: dfx`

**Solutions:**

```bash
# Install dfx
sh -ci "$(curl -fsSL https://sdk.dfinity.org/install.sh)"

# Add to PATH
export PATH="$HOME/bin:$PATH"

# Verify installation
dfx --version
```

### Permission denied errors

**Problem:** `EACCES: permission denied` when running commands

**Solutions:**

```bash
# Run with sudo (use caution)
sudo npm install -g agentvault

# Fix file permissions
chmod +x ./dist/cli/index.js

# Use proper ownership
sudo chown -R $USER:$USER ~/.agentvault
```

## Configuration Issues

### agent.yaml not found

**Problem:** `Error: agent.yaml not found`

**Solutions:**

```bash
# Initialize new project
agentvault init <project-name>

# Check current directory
ls -la

# Create minimal agent.yaml
cat > agent.yaml <<EOF
name: My Agent
entry: src/index.ts
EOF
```

### Invalid configuration

**Problem:** `Error: Invalid configuration value`

**Solutions:**

```bash
# Validate configuration
agentvault validate

# Show example config
agentvault init --example

# Use schema documentation
docs/user/deployment.md
```

### Wallet not found

**Problem:** `Error: No wallet configured`

**Solutions:**

```bash
# Create new wallet
agentvault wallet create

# Import existing wallet
agentvault wallet import --mnemonic

# Check wallet storage
ls -la ~/.agentvault/wallets
```

## Deployment Issues

### Insufficient cycles

**Problem:** `Error: Insufficient cycles to deploy`

**Solutions:**

```bash
# Check balance
agentvault wallet balance

# Request from faucet
agentvault wallet faucet

# Purchase cycles
agentvault wallet purchase --amount 1000000000000

# Deploy with less cycles
agentvault deploy --cycles 500000000000
```

### Canister creation failed

**Problem:** `Error: Failed to create canister`

**Solutions:**

```bash
# Check network status
agentvault network status

# Verify identity
dfx identity whoami

# Try alternative network
agentvault deploy --network local

# Check for rate limits
agentvault status
```

### Code installation failed

**Problem:** `Error: Failed to install code`

**Solutions:**

```bash
# Verify WASM file
ls -lh dist/*.wasm

# Recompile
agentvault package

# Manual compilation
npx tsc && npx esbuild

# Check WASM magic bytes
xxd dist/agent.wasm
```

### Deployment timeout

**Problem:** `Error: Deployment timed out`

**Solutions:**

```bash
# Increase timeout
agentvault deploy --timeout 600

# Use background deployment
agentvault deploy --background

# Check canister status
agentvault status <canister-id>
```

## Runtime Issues

### Canister not responding

**Problem:** Canister deployed but not responding to queries

**Solutions:**

```bash
# Check canister status
agentvault status <canister-id>

# Restart canister
agentvault restart <canister-id>

# Check health endpoint
agentvault health <canister-id>

# View logs for errors
agentvault logs <canister-id>
```

### Out of memory

**Problem:** `Error: Canister out of memory`

**Solutions:**

```bash
# Increase memory allocation
agentvault upgrade <canister-id> --memory 512

# Optimize agent code
agentvault optimize --target <project-path>

# Restart canister
agentvault restart <canister-id>

# Clear stable memory (if applicable)
agentvault exec <canister-id> "clear"
```

### Transaction failed

**Problem:** Transaction sent but failed on-chain

**Solutions:**

```bash
# Check transaction status
agentvault wallet tx <tx-id>

# View failure reason
agentvault wallet tx <tx-id> --details

# Retry transaction
agentvault wallet retry <tx-id>

# Check fees
agentvault wallet fees --network icp
```

## Performance Issues

### Slow performance

**Problem:** Dashboard or CLI operations are slow

**Solutions:**

```bash
# Clear cache
agentvault cache clear

# Check disk space
df -h ~/.agentvault

# Optimize database
agentvault db optimize

# Reduce log verbosity
agentvault config set --log-level warn
```

### High memory usage

**Problem:** AgentVault consuming too much memory

**Solutions:**

```bash
# Check memory usage
ps aux | grep agentvault

# Limit concurrent operations
agentvault config set --max-concurrent 5

# Clear history
agentvault history clear

# Restart services
pkill -HUP agentvault
```

### Database lock errors

**Problem:** `Error: Database locked`

**Solutions:**

```bash
# Check for running processes
ps aux | grep agentvault

# Kill stale processes
pkill -9 agentvault

# Remove lock file
rm -f ~/.agentvault/*.lock

# Restart
agentvault restart
```

## Network Issues

### Connection refused

**Problem:** `ECONNREFUSED: Connection refused`

**Solutions:**

```bash
# Check if service is running
agentvault status

# Check port availability
netstat -an | grep 4943

# Check firewall
ufw status  # Linux
sudo ufw allow 4943/tcp

# Try alternative host
agentvault network status --host https://ic0.app
```

### DNS resolution failed

**Problem:** `Error: Unable to resolve host`

**Solutions:**

```bash
# Check DNS resolution
nslookup ic0.app

# Use alternative DNS
echo "8.8.8.8" | sudo tee /etc/resolv.conf

# Use direct IP
agentvault config set --icp-host http://205.171.201.22
```

### Timeout errors

**Problem:** Operations timing out after default timeout

**Solutions:**

```bash
# Increase timeout globally
agentvault config set --timeout 300

# Increase per-command timeout
agentvault deploy --timeout 600

# Use longer retries
agentvault config set --retries 5
```

## Debug Mode

Enable detailed logging for troubleshooting:

```bash
# Enable debug mode
agentvault --debug <command>

# Set debug level
agentvault config set --log-level debug

# Enable verbose output
agentvault --verbose <command>

# Save logs to file
agentvault logs <canister-id> > debug.log 2>&1
```

## Getting Help

### Built-in Help

```bash
# General help
agentvault --help

# Command-specific help
agentvault deploy --help

# List available commands
agentvault --list-commands
```

### Issue Reporting

Report bugs and issues:

```bash
# Collect diagnostic information
agentvault doctor

# Create bug report
agentvault bug-report --output bug-report.txt

# Submit to GitHub
gh issue create --title "Issue Title" --body @bug-report.txt
```

### Community Support

Get help from the community:

- **GitHub Issues:** https://github.com/your-org/agentvault/issues
- **Discord:** https://discord.gg/agentvault
- **Forum:** https://forum.dfinity.org/
- **Documentation:** https://docs.agentvault.dev

## Recovery Procedures

### Recover from failed deployment

```bash
# List available rollbacks
agentvault rollback list <canister-id>

# Rollback to previous version
agentvault rollback <canister-id> --version <version-number>
```

### Emergency canister stop

```bash
# Force stop canister
agentvault stop <canister-id> --force

# Delete canister (caution: irreversible)
agentvault delete <canister-id> --confirm
```

## Advanced Troubleshooting

### Enable verbose logging

```bash
# Set environment variable
export AGENTVAULT_DEBUG=true

# Enable all log categories
agentvault config set --log-categories all

# Set max log level
agentvault config set --log-level trace
```

### Inspect canister state

```bash
# Query canister status
agentvault status <canister-id>

# Query canister info
agentvault info <canister-id>

# Dump canister heap
agentvault exec <canister-id> "debug.heapDump()"
```

### Network diagnostics

```bash
# Test network connectivity
agentvault network test

# Measure latency
agentvault network ping --count 10

# Test with different hosts
agentvault network test --host ic0.app
agentvault network test --host gateway.ic0.app
```

## Preventive Measures

### Regular backups

```bash
# Schedule automatic backups
agentvault backup schedule --all --frequency daily

# Backup before major changes
agentvault backup create --all --pre-change
```

### Health monitoring

```bash
# Enable continuous monitoring
agentvault monitor start --interval 60

# Set up alerts
agentvault alert configure --email admin@example.com
agentvault alert configure --webhook https://hooks.example.com
```

### Resource limits

```bash
# Set memory limits
agentvault config set --max-memory 4GB

# Set CPU limits
agentvault config set --max-cpu 80%

# Set disk limits
agentvault config set --max-disk 10GB
```

## Next Steps

- [ ] Check [Getting Started Guide](./getting-started.md)
- [ ] Review [Deployment Guide](./deployment.md)
- [ ] Read [Web Dashboard Guide](./webapp.md)
- [ ] Report unresolved issues via GitHub
