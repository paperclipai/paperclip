# Configuration

Configure your AgentVault projects with YAML configuration files.

## agent.yaml

The main agent configuration file at project root:

```yaml
name: My Agent
description: Description of your agent
entry: src/index.ts
memory: 256
compute: medium
cycles: 1000000000000
routing:
  - canister-a-id
  - canister-b-id
```

### Configuration Options

| Option | Type | Description | Default |
|--------|------|-------------|---------|
| `name` | string | Agent name | package.json name |
| `description` | string | Agent description | - |
| `entry` | string | Entry point file | `src/index.ts` |
| `memory` | number | Memory allocation (MB) | 256 |
| `compute` | string | Compute tier: `low`, `medium`, `high` | `medium` |
| `cycles` | bigint | Initial cycles allocation | 1T |
| `routing` | array | Routing canisters | - |

### Memory Tiers

| Tier | Memory | Use Case |
|------|--------|----------|
| Low | 128 MB | Simple agents, minimal state |
| Medium | 256 MB | Standard agents (default) |
| High | 512 MB+ | Complex agents, large state |

### Compute Tiers

| Tier | Compute | Use Case |
|------|---------|----------|
| Low | 1x | Light processing |
| Medium | 2x | Standard processing (default) |
| High | 4x | Intensive processing |

## icp.yaml

ICP network configuration for deployment settings:

```yaml
environments:
  local:
    network:
      type: local
      host: http://127.0.0.1:4943
    replicaCount: 4
    cycles:
      initial: 100T
  production:
    network:
      type: ic
      host: https://ic0.app
    replicaCount: 20
    cycles:
      initial: 500T
      refillThreshold: 100T

optimization:
  level: 3
  shrink: true
  removeDebug: true
```

### Environment Options

| Option | Description |
|--------|-------------|
| `network.type` | `local` or `ic` |
| `network.host` | Network endpoint URL |
| `replicaCount` | Number of replicas |
| `cycles.initial` | Initial cycles allocation |
| `cycles.refillThreshold` | Auto-refill threshold |

### Optimization Options

| Option | Description |
|--------|-------------|
| `level` | Optimization level (0-3) |
| `shrink` | Enable WASM shrinking |
| `removeDebug` | Remove debug symbols |

## Environment Variables

### ICP Configuration

```bash
ICP_LOCAL_URL=http://127.0.0.1:4943    # Local replica URL
ICP_MAINNET_URL=https://ic0.app        # Mainnet URL
ICP_NETWORK=local                       # Default network
ICP_IDENTITY=default                    # dfx identity name
```

### RPC Endpoints

```bash
# Ethereum
ETHEREUM_RPC_URL=https://eth.example.com
SEPOLIA_RPC_URL=https://sepolia.example.com
INFURA_API_KEY=your-key
ETHERSCAN_API_KEY=your-key

# Solana
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_MAINNET_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_DEVNET_RPC_URL=https://api.devnet.solana.com

# Polkadot
POLKADOT_RPC_URL=wss://rpc.polkadot.io
KUSAMA_RPC_URL=wss://kusama-rpc.polkadot.io
```

### Application Settings

```bash
AGENTVAULT_DEBUG=false                  # Enable debug mode
AGENTVAULT_LOG_LEVEL=info               # Log level
AGENTVAULT_CACHE_DIR=~/.agentvault      # Cache directory
```

## .env File

Create a `.env` file in your project root:

```env
# ICP Configuration
ICP_LOCAL_URL=http://127.0.0.1:4943
ICP_MAINNET_URL=https://ic0.app

# Ethereum
ETHEREUM_RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
ETHERSCAN_API_KEY=YOUR_KEY

# Solana
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Polkadot
POLKADOT_RPC_URL=wss://rpc.polkadot.io
```

**Important**: Add `.env` to `.gitignore` to avoid committing secrets.

## Configuration Precedence

Configuration is loaded in this order (later overrides earlier):

1. Default values
2. `agent.yaml`
3. `icp.yaml`
4. `.env` file
5. Environment variables
6. CLI flags

## Validation

Validate your configuration:

```bash
# Validate agent.yaml
agentvault validate

# Show effective configuration
agentvault config show
```

## Project Structure

A complete AgentVault project:

```
my-agent/
├── .agentvault/
│   ├── config.yaml       # Generated configuration
│   └── state/            # Local state storage
├── src/
│   └── index.ts          # Agent entry point
├── agent.yaml            # Agent configuration
├── icp.yaml              # ICP deployment config
├── package.json
├── tsconfig.json
└── .env                  # Environment variables (gitignored)
```

## Next Steps

- [Deployment Guide](../user/deployment.md) - Deploy your configured agent
- [CLI Reference](../cli/reference.md) - All CLI commands
- [Environment Variables](../cli/options.md) - All configuration options
