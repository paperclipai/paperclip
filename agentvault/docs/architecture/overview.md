# Architecture Overview

AgentVault system architecture and design.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              User Layer                                  │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐               │
│  │   CLI         │  │   Web         │  │   Agent       │               │
│  │   (Node.js)   │  │   Dashboard   │  │   Code        │               │
│  └───────┬───────┘  └───────┬───────┘  └───────┬───────┘               │
└──────────┼──────────────────┼──────────────────┼────────────────────────┘
           │                  │                  │
           ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           AgentVault Core                                │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│  │ Deployment  │ │ Packaging   │ │  Wallet     │ │  Security   │       │
│  │   Module    │ │   Module    │ │  Module     │ │   Module    │       │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘ └──────┬──────┘       │
│         │               │               │               │               │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│  │ Monitoring  │ │  Backup     │ │  Archival   │ │  Inference  │       │
│  │   Module    │ │   Module    │ │   Module    │ │   Module    │       │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘ └──────┬──────┘       │
└─────────┼────────────────┼────────────────┼────────────────┼───────────┘
          │                │                │                │
          ▼                ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         External Services                                │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│  │ ICP Network │ │  Arweave    │ │  Bittensor  │ │ Blockchain  │       │
│  │  (Canister) │ │   Network   │ │   Network   │ │   RPCs      │       │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘       │
└─────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. CLI Layer (`cli/`)

Command-line interface with 37 commands:

| Category | Commands | Purpose |
|----------|----------|---------|
| Core | init, package, deploy, exec, show, fetch, status, list | Project lifecycle |
| Wallet | wallet, identity, cycles, tokens | Multi-chain wallet ops |
| Monitoring | monitor, health, info, stats, logs | Canister observability |
| Backup | backup, rebuild | State management |
| Deployment | promote, rollback | Environment promotion |
| Advanced | inference, archive, approve, profile, trace | Extended features |

### 2. Core Library (`src/`)

TypeScript library providing:

- **Deployment** (`src/deployment/`): ICP client, deployment orchestration
- **Packaging** (`src/packaging/`): WASM compilation and optimization
- **Canister** (`src/canister/`): Actor bindings, encryption, state management
- **Wallet** (`src/wallet/`): Multi-chain wallet providers
- **Security** (`src/security/`): VetKeys, multisig, encryption
- **Monitoring** (`src/monitoring/`): Health checks, metrics, alerting
- **Backup** (`src/backup/`): Backup creation, restoration
- **Archival** (`src/archival/`): Arweave integration
- **Inference** (`src/inference/`): Bittensor integration

### 3. Canister Layer (`canister/`)

Motoko canister code:

- Agent canister implementation
- Candid interface definitions
- State management
- Inter-canister calls

### 4. Web Dashboard (`webapp/`)

Next.js application:

- Canister monitoring
- Agent management
- Log viewing
- Wallet operations

## Data Flow

### Deployment Flow

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  init   │───▶│ package │───▶│  deploy │───▶│ verify  │
└─────────┘    └─────────┘    └─────────┘    └─────────┘
     │              │              │              │
     ▼              ▼              ▼              ▼
 .agentvault/   dist/*.wasm   ICP Canister   health check
   config       artifacts     created        passes
```

### Backup Flow

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   fetch     │───▶│   backup    │───▶│   archive   │
│   state     │    │   create    │    │   to Arweave│
└─────────────┘    └─────────────┘    └─────────────┘
       │                  │                  │
       ▼                  ▼                  ▼
  canister state    backup.json       arweave tx
  to local file     in ~/.agentvault  permanent
```

## Module Dependencies

```
                    ┌─────────────┐
                    │    CLI      │
                    └──────┬──────┘
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
       ▼                   ▼                   ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Deployment │     │   Wallet    │     │  Security   │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  Canister   │
                    │   Actor     │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ ICP Network │
                    └─────────────┘
```

## Storage

### Local Storage

| Path | Content |
|------|---------|
| `~/.agentvault/wallets/` | Wallet data (CBOR) |
| `~/.agentvault/backups/` | Backup files |
| `~/.agentvault/config/` | Configuration |
| `~/.config/dfx/` | ICP identities |

### Remote Storage

| Service | Content | Persistence |
|---------|---------|-------------|
| ICP Canister | Agent state | Persistent |
| Arweave | Backups | Permanent |
| Blockchain | Transactions | Immutable |

## Security Boundaries

```
┌──────────────────────────────────────────────────────────┐
│                    Trusted Zone                           │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐         │
│  │ User CLI   │  │ Local      │  │ Config     │         │
│  │            │  │ Storage    │  │ Files      │         │
│  └────────────┘  └────────────┘  └────────────┘         │
└──────────────────────────────────────────────────────────┘
                         │
                         │ Authenticated
                         ▼
┌──────────────────────────────────────────────────────────┐
│                    ICP Network                            │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐         │
│  │ Canister   │  │ System     │  │ VetKeys    │         │
│  │ (Sandboxed)│  │ Canisters  │  │ Service    │         │
│  └────────────┘  └────────────┘  └────────────┘         │
└──────────────────────────────────────────────────────────┘
                         │
                         │ Untrusted
                         ▼
┌──────────────────────────────────────────────────────────┐
│                    External APIs                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐         │
│  │ Ethereum   │  │ Solana     │  │ Arweave    │         │
│  │ RPC        │  │ RPC        │  │ Gateway    │         │
│  └────────────┘  └────────────┘  └────────────┘         │
└──────────────────────────────────────────────────────────┘
```

## Performance Considerations

### CLI Startup

- Lazy loading of modules
- Minimal dependencies at startup
- Caching of compiled artifacts

### Network Calls

- Connection pooling
- Request batching where possible
- Configurable timeouts

### Memory Usage

- Streaming for large files
- Cleanup of temporary resources
- Efficient serialization (CBOR)

## Next Steps

- [Modules](./modules.md) - Detailed module documentation
- [Canister](./canister.md) - Canister architecture
- [Security Overview](../security/overview.md) - Security model
