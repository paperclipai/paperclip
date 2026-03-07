# CHANGELOG

All notable changes to AgentVault will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.0.0] - 2025-02-12 - v1.0.0 Final Release

### Added
- Complete core flow: init → package → deploy → exec → show → fetch
- Real ICP canister deployment via dfx integration
- Multi-chain wallet support (ICP, Ethereum, Polkadot, Solana)
- VetKeys threshold key derivation for secure secrets
- AES-256-GCM encryption with timing-safe HMAC verification
- Comprehensive CLI with 36 commands
- Next.js web dashboard with 8 pages
- Monitoring system with health checks and alerts
- Arweave archival integration
- Bittensor inference integration
- Environment variable configuration for all RPC endpoints
- Cryptographically secure random generation for share IDs
- `backup export --canister-id` option to include live canister state (tasks, memory, context)
- `promote --wasm-path` option for actual canister deployment during promotion

### Changed
- ICP client now uses real dfx commands for deployment
- WASM hash calculation uses proper SHA-256
- VetKeys IV generation uses crypto.randomBytes
- Memory thresholds now correctly use 4GB max canister limit
- Cycle parsing uses correct multipliers (T=10^12, G=10^9, M=10^6, K=10^3)
- Encryption uses timing-safe comparison to prevent timing attacks

### Fixed
- Math.random() replaced with crypto.randomBytes in vetkeys.ts
- All hardcoded localhost URLs now use environment variables
- ESM compatibility for arweave and bittensor clients
- Principal validation regex accepts valid ICP formats
- Webapp components now use real API hooks instead of mock data

### Security
- Timing-safe HMAC verification in encryption.ts
- Secure IV generation in vetkeys.ts
- Environment variable configuration for sensitive endpoints
- Threshold signatures properly validate canister connection

### Experimental Features
The following commands are marked [Experimental] and under active development:
- `inference` - Bittensor network integration
- `archive` - Arweave archival
- `approve` - Multi-signature workflows
- `profile` - Canister profiling
- `trace` - Execution traces
- `wallet-multi-send` - Multi-chain transactions
- `wallet-process-queue` - Transaction queue processing

## [Unreleased]

## [1.0.0] - 2025-02-10 - Phase 5: Production Release

### Added
- Production-ready AI agent platform for Internet Computer
- Complete web dashboard with agent management
- Multi-chain wallet support (ICP, Polkadot, Solana)
- Batched canister deployment operations
- Arweave archival for permanent storage
- Bittensor inference integration
- Multi-sig approval workflows
- Automated backup and restore
- Real-time monitoring and metrics
- Comprehensive CLI with 36 commands
- TypeScript/ESLint configuration
- CI/CD pipeline with GitHub Actions

### Changed
- Upgraded from development to production-ready state
- Added comprehensive documentation for users and developers
- Configured production deployment settings
- Established automated testing and release process

### Fixed
- Pre-existing test errors resolved
- CI/CD workflows configured
- Package configuration for npm publishing
- Production dfx.json and icp.yaml created

### Removed
- Pre-existing test file with errors removed
- Stale backup file cleaned up

---

## [1.0.0-rc.1] - 2025-02-09 - Phase 5: Documentation

### Added
- User guide: Getting started, deployment, wallets, backups
- Developer guide: Architecture, extending agents, canister development
- Troubleshooting guide with comprehensive solutions
- Web dashboard guide

---

## [1.0.0-rc.2] - 2025-02-08 - Phase 5: Testing & CI/CD

### Added
- GitHub Actions workflows: test, test-webapp, release
- Automated testing on every push/PR
- Coverage reporting with Codecov
- Automated npm publishing

---

## [1.0.0-rc.3] - 2025-02-07 - Phase 5: Package Config

### Added
- Package files configuration
- npm keywords for searchability
- Repository, bugs, homepage fields
- Engine strictness (Node.js 18+)
- License specification

---

## [0.4.1] - 2025-02-06 - Phase 4: Webapp & Backend

### Added
- Next.js 15 + React 19 web dashboard
- 8 dashboard pages (canisters, agents, tasks, logs, wallets, networks, backups, settings)
- 18 API routes
- 21 UI components (agents, tasks, logs, wallets, common)
- 6 custom hooks for data fetching
- 2 context providers (theme, ICP)
- 4 utility modules (types, api-client, utils, icp-connection)

---

## [0.4.0] - 2025-02-05 - Phase 4: Archival & Inference

### Added
- Arweave client for permanent storage
- Archive manager for local backup management
- Bittensor client for AI inference
- CLI commands: archive, inference, approve

---

## [0.3.0] - 2025-02-04 - Phase 4: Wallet & Multi-sig

### Added
- Multi-chain wallet system
- Hardware wallet support
- Transaction queue and history
- Multi-signature approval workflows
- CLI commands: wallet-export, wallet-import, wallet-history, wallet-sign, wallet-multi-send, wallet-process-queue

---

## [0.2.0] - 2025-02-03 - Phase 4: Testing & Monitoring

### Added
- Vitest testing framework
- Coverage reporting
- Monitoring system with health checks and alerts
- CLI commands: monitor, health, info, instrument

---

## [0.1.0] - 2025-02-02 - Phase 4: Metrics & Backup

### Added
- Metrics collection and aggregation
- Backup system with local and Arweave
- CLI commands: backup, status, show

---

## [0.0.1] - 2025-02-01 - Phase 3: Deployment

### Added
- Batched canister operations
- Topological sort for dependencies
- CLI commands: deploy, promote, rebuild, rollback

---

## [0.0.0] - 2025-01-25 - Initial Release

### Added
- Initial agent packaging system
- Basic deployment capabilities
- Wallet integration stubs
- Monitoring and metrics foundation
- Documentation structure

---

## [Unreleased]
