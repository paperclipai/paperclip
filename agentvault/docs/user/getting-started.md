# Getting Started

This guide will help you get started with AgentVault - an AI agent platform for the Internet Computer.

## Prerequisites

Before installing AgentVault, ensure you have:

- **Node.js 18+** - Required for running AgentVault CLI
- **dfx** - Internet Computer SDK for deploying canisters
  - Install with: `sh -ci "$(curl -fsSL https://sdk.dfinity.org/install.sh)"`
  - Verify with: `dfx --version`
- **ICP cycles** - Required for canister operations
  - Create a wallet and fund with cycles at [ICP Dashboard](https://dashboard.internetcomputer.org)
- **Git** - For cloning agent projects

## Installation

### Global Installation

Install AgentVault globally on your system:

```bash
npm install -g agentvault
```

Verify installation:

```bash
agentvault --version
```

### Development Installation

For local development or contributing:

```bash
git clone https://github.com/your-org/agentvault.git
cd agentvault
npm install
npm run build
npm link
```

## First Project

Create your first AI agent project:

```bash
agentvault init my-first-agent
cd my-first-agent
```

This creates the following structure:

```
my-first-agent/
├── agent.yaml          # Agent configuration
├── src/
│   └── index.ts      # Agent entry point
└── package.json       # Node.js dependencies
```

## Configuration

Edit `agent.yaml` to configure your agent:

```yaml
name: My First Agent
description: A sample AI agent
entry: src/index.ts
memory: 256
compute: medium
cycles: 1000000000000  # 1T cycles
```

### Configuration Options

| Option | Type | Description | Default |
|---------|--------|-------------|----------|
| `name` | string | Agent name | `package.json` name |
| `description` | string | Agent description | - |
| `entry` | string | Entry point file | `src/index.ts` |
| `memory` | number | Memory allocation in MB | 256 |
| `compute` | string | Compute tier: `low`, `medium`, `high` | `medium` |
| `cycles` | bigint | Initial cycles allocation | 1T |
| `routing` | array | Routing canisters | - |

## Local Testing

Test your agent locally before deployment:

```bash
agentvault test
```

This runs the agent in a local test environment with simulated ICP interactions.

### Testing Options

```bash
agentvault test --verbose
agentvault test --coverage
```

## Deployment

Deploy your agent to the Internet Computer:

```bash
# Local deployment
agentvault deploy --network local

# Production deployment
agentvault deploy --network ic
```

### Deployment Flags

| Flag | Description |
|-------|-------------|
| `--network` | Network: `local` or `ic` |
| `--canister-id` | Upgrade existing canister |
| `--cycles` | Custom cycles allocation |
| `--no-verify` | Skip post-deployment verification |

## Verification

Verify your deployed agent:

```bash
agentvault status <canister-id>
```

## Troubleshooting

### Common Issues

**dfx not found**
```bash
export PATH="$HOME/bin:$PATH"
dfx --version
```

**Insufficient cycles**
```bash
# Check wallet balance
agentvault wallet balance

# Request faucet
agentvault wallet request
```

**Build failures**
```bash
# Clean and rebuild
rm -rf dist
npm run build
```

**Network timeouts**
```bash
# Check network status
agentvault network status

# Switch to alternate network
dfx identity use ic
```

## Next Steps

- Explore [Deployment Guide](./deployment.md)
- Set up [Wallets](./wallets.md)
- Configure [Backups](./backups.md)
- Access the [Web Dashboard](./webapp.md)

## Getting Help

```bash
agentvault --help
agentvault <command> --help
```

For issues or feature requests, visit:
- GitHub Issues: https://github.com/your-org/agentvault/issues
- Discord: https://discord.gg/agentvault
- Documentation: https://docs.agentvault.dev
