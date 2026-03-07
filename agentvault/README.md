# AgentVault

**Persistent On-Chain AI Agent Platform - Sovereign, Reconstructible, Autonomous**

AgentVault is an open-source CLI and canister system that enables true autonomy for local AI agents. Deploy agents to Internet Computer (ICP) canisters for persistent, 24/7 execution without browser dependencies.

## Features

- **Agent Packaging**: Compile TypeScript agents to WASM
- **Canister Deployment**: Deploy to ICP local replica or mainnet
- **State Management**: Query, fetch, and reconstruct agent state
- **Multi-Chain Wallets**: ICP, Ethereum, Polkadot, Solana support
- **VetKeys Integration**: Threshold key derivation for secure secrets
- **Monitoring**: Health checks, metrics, and alerting
- **Archival**: Arweave integration for permanent storage
- **AI Inference**: Bittensor network integration

## Installation

### From npm (Recommended)

```bash
npm install -g agentvault
agentvault --help
```

### From Source

```bash
git clone https://github.com/johnnyclem/agentvault.git
cd agentvault
npm install
npm run build
node dist/cli/index.js --help
```

### Prerequisites

- Node.js 18+
- dfx (Internet Computer SDK) - for canister deployment
- TypeScript 5.7+

## Quick Start

### 1. Initialize a New Agent Project

```bash
agentvault init my-agent
```

This creates a `.agentvault/` directory with agent configuration.

### 2. Package Your Agent

```bash
agentvault package ./my-agent
```

Compiles your agent to WASM and generates deployment artifacts.

### 3. Start Local ICP Replica

```bash
dfx start --background
```

### 4. Deploy to Canister

```bash
agentvault deploy --network local
```

### 5. Execute Agent

```bash
agentvault exec --canister-id <your-canister-id> "your task"
```

### 6. Query Agent State

```bash
agentvault show --canister-id <your-canister-id>
```

### 7. Fetch State for Local Rebuild

```bash
agentvault fetch --canister-id <your-canister-id>
```

## CLI Commands

### Core Commands

| Command | Description |
|---------|-------------|
| `init` | Initialize a new AgentVault project |
| `package` | Package agent directory to WASM |
| `deploy` | Deploy agent to ICP canister |
| `exec` | Execute task on canister |
| `show` | Show agent state |
| `fetch` | Download agent state from canister |
| `status` | Display project status |
| `list` | List all agents |

### Wallet Commands

| Command | Description |
|---------|-------------|
| `wallet` | Manage agent wallets |
| `identity` | Manage ICP identities |
| `cycles` | Manage canister cycles |
| `tokens` | Query token balances |

### Monitoring Commands

| Command | Description |
|---------|-------------|
| `monitor` | Monitor canister health |
| `health` | Run health checks |
| `info` | Get canister information |
| `stats` | View canister statistics |
| `logs` | View canister logs |

### Advanced Commands

| Command | Description | Status |
|---------|-------------|--------|
| `backup` | Backup agent data | Stable |
| `rebuild` | Rebuild agent from state | Stable |
| `promote` | Promote canister between environments | Stable |
| `rollback` | Rollback canister deployment | Stable |
| `inference` | Query AI inference services | Experimental |
| `archive` | Archive to Arweave | Experimental |
| `approve` | Multi-signature approvals | Experimental |
| `profile` | Profile canister performance | Experimental |
| `trace` | View execution traces | Experimental |

## Environment Variables

### ICP Configuration

```bash
ICP_LOCAL_URL=http://127.0.0.1:4943    # Local replica URL
ICP_MAINNET_URL=https://ic0.app        # Mainnet URL
```

### RPC Endpoints

```bash
# Ethereum
ETHEREUM_RPC_URL=https://eth.example.com
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

## Project Structure

```
agentvault/
├── src/                    # Core TypeScript library
│   ├── deployment/         # ICP client and deployment
│   ├── packaging/          # WASM compilation
│   ├── canister/           # Actor bindings
│   ├── wallet/             # Multi-chain wallet
│   ├── security/           # VetKeys and encryption
│   ├── monitoring/         # Health and metrics
│   ├── archival/           # Arweave client
│   └── inference/          # Bittensor client
├── cli/                    # CLI commands
├── canister/               # Motoko canister code
├── webapp/                 # Next.js dashboard
├── tests/                  # Test suite (508 tests)
└── examples/               # Sample agents
```

## Documentation (v1.0)

- **Website**: https://agentvault.cloud
- [Documentation index](docs/user/index-v1.0.md)
- [Comprehensive tutorial](docs/user/tutorial-v1.0.md)
- [Clawdbot/Claude skill runbook](docs/user/clawdbot-claude-skill.md)

## Development

```bash
npm run dev          # Development mode with watch
npm run dev:dashboard # Run core + web dashboard together
npm run dev:webapp   # Run only Next.js dashboard
npm run build        # Build TypeScript
npm run test         # Run test suite
npm run test:watch   # Run tests in watch mode
npm run typecheck    # TypeScript type checking
npm run typecheck:webapp # Dashboard type checking
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
```

## Testing

AgentVault has 508 tests covering:

- CLI commands (init, deploy, package, status)
- ICP client (connection, deployment, execution)
- Packaging (compiler, detector, packager)
- Integration tests

```bash
npm run test
```

## Known Limitations

| Feature | Status |
|---------|--------|
| Core flow (init → package → deploy → exec → fetch) | ✅ Working |
| Wallet crypto (real elliptic curves) | ⚠️ Basic SHA-256 |
| VetKeys threshold signatures | ⚠️ Simulated |
| Bittensor inference | ⚠️ Requires API access |
| Arweave archival | ⚠️ Requires wallet setup |
| Backup/restore | ⚠️ Manifest only |

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Run tests and linting
4. Submit a pull request

## License

MIT License - see [LICENSE](./LICENSE).

## Resources

- **Website**: https://agentvault.cloud
- **Documentation**: https://agentvault.cloud/docs
- **npm**: https://www.npmjs.com/package/agentvault
- [Product Requirements Document](./docs/PRD.md)
- [Implementation Plan](./AI_DOCS/)
- [Changelog](./CHANGELOG.md)
- [ICP Documentation](https://internetcomputer.org/docs/)
