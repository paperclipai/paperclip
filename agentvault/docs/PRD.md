# AgentVault
## Product Requirements Document (PRD)

**Version:** 1.0
**Date:** January 31, 2026
**Status:** Draft

---

## 1. Executive Summary

AgentVault is an open-source CLI and canister system that enables true autonomy for local AI agents. It solves the fundamental problem of agent state persistence and execution reliability by migrating from fragile local file storage to immutable, sovereign Internet Computer (ICP) canisters.

Core value proposition: **Any user can fully rebuild and resume their agent on a clean OS install using only chain data and a seed phrase—eliminating browser/tab dependency, centralized KMS threats, and fragile off-chain storage.**

### Product Vision

Create an open-source tool that:
1. **Migrates** existing local AI agents (Clawdbot, Goose, Cline) to persistent ICP canisters
2. **Packages** agent logic as deterministic WASM modules
3. **Stores** core state and memories in ICP canisters (up to 500 GiB stable memory per canister)
4. **Enables** 24/7 on-chain execution without browser dependencies
5. **Provides** reconstruction CLI—fetch agent state from canister, decrypt via user-controlled keys, rebuild locally (WasmEdge or deploy)

### Differentiators

- **Sovereignty:** User controls their data and secrets—no external Vault or middleware SPOFs
- **Persistence:** True autonomy—agents continue even after local machine restarts
- **Cost-Efficient:** On-chain execution for lightweight inference; off-chain archival for heavy data (Arweave, ~$5/GB/year storage, ~1-2s block times)
- **Cross-Chain Fusion:** Native interoperability with Ethereum, Bitcoin, Solana via Chain Fusion oracles
- **Security-First:** Verifiably encrypted threshold key derivation; no plaintext exposure in canister code
- **Open Standards:** Uses ICP, VetKeys, Arweave standards—no lock-in

---

## 2. User Personas

### 2.1 Solo Developer
- **Profile:** Developer managing AI agents locally, frustrated with agent fragility
- **Needs:** Reliable way to persist agent state, recover from crashes, run autonomously
- **Pain Points:**
  - Agents lose state when local machine crashes
  - Can't resume agents across different computers
  - Browser/tab required for execution
- **Goals:** Deploy agent to ICP canister, migrate existing configs, run 24/7

### 2.2 Enterprise Operator
- **Profile:** Running AI agents at scale, needs sovereign deployment
- **Needs:** True autonomy without infrastructure dependencies, compliance-ready solution
- **Pain Points:**
  - Cloud vendor lock-in
  - Can't audit or verify agent state on-chain
  - Regulatory concerns about AI autonomy
- **Goals:** Deploy AgentVault canisters, manage agents via CLI, audit execution logs

### 2.3 Hobbyist/Tinkerer
- **Profile:** Experimenting with multiple AI agents, wants easy migration
- **Needs:** Simple CLI to package any agent as WASM, migrate without technical knowledge
- **Pain Points:**
  - Don't understand ICP canisters
  - Complex toolchain setup
  - Need Rust/WASM compilation skills
- **Goals:** One-command migration, cross-chain capabilities

---

## 3. Functional Requirements

### 3.1 Core Features (MVP)

#### 3.1.1 Agent Packaging
- **CLI Command:** `agentvault package <agent-dir>` packages agent directory into WASM
- **Auto-Detection:** Detects agent type (Clawdbot, Goose, Cline, generic)
- **Config Ingestion:** Reads agent configs (settings, memory, tasks)
- **WASM Compilation:** Compiles to `.wasm` and `.wat` files
- **Serialization:** Exports deterministic state JSON for canister upload

#### 3.1.2 Canister Deployment
- **Canister Creation:** Create new ICP canister for agent state
- **Deploy Command:** `agentvault deploy <agent-name>` uploads compiled agent
- **State Upload:** Uploads agent state JSON to canister storage
- **Secret Management:** VetKeys API for threshold key derivation

#### 3.1.3 Execution Layer
- **On-Chain Inference:** Agent logic compiled to WASM, deployed to canister
- **State Querying:** Query canister for agent state, memories, task queue
- **Action Dispatching:** Submit tasks to canister, poll for completion

#### 3.1.4 Reconstruction CLI
- **Fetch State:** `agentvault fetch <agent-name>` downloads state from canister
- **Decrypt State:** `agentvault decrypt` prompts for seed phrase, decrypts all agent data
- **Local Rebuild:** `agentvault rebuild` compiles WasmEdge locally, restarts agent

#### 3.1.5 Security
- **VetKeys Integration:** Encrypt secrets using threshold key derivation
- **Key Management:** Never expose seed phrase; derive keys per agent
- **Auditing:** Log all canister operations for transparency

### 3.2 Integration - Phase 2

#### 3.2.1 Multi-Agent Support
- **Agent Directory:** `~/.agentvault/agents/` stores multiple agent configs
- **Canister Mapping:** Each agent can be deployed to separate canister
- **Shared State:** Optional shared canisters for agent communication

#### 3.2.2 Cross-Chain Actions
- **Chain Fusion Integration:** Query cross-chain oracles via dfx
- **Wallet Connection:** Generate/import wallets for agent actions (e.g., ckETH)
- **Bridge:** Relay agent intents to other blockchains via smart contracts

#### 3.2.3 dApp (Optional)
- **Canister Monitoring UI:** Query agent canister status
- **Task Queue Viewer:** View pending agent tasks
- **Log Browser:** Browse execution history from canister

### 3.3 Advanced Features (Phase 3)

#### 3.3.1 Heavy Inference
- **Orchestration:** Route heavy inference to decentralized AI networks (Bitensor, Bittensor)
- **Payment:** User-funded inference via agent wallet
- **Latency Optimization:** Async/batched operations

#### 3.3.2 Archival
- **Arweave Integration:** Upload large files (logs, models) for cold storage
- **IPFS Fallback:** Optional IPFS caching for frequently accessed data

---

## 4. Technical Architecture

### 4.1 Tech Stack

#### CLI
- **Language:** TypeScript 5.7+
- **Runtime:** Node.js 18+
- **Packages:**
  - `dfinity/agent` - ICP canister deployment
  - `dfinity/candid` - IDL bindings
  - `vetkd` - WASM verification
  - `k256`, `bs58` - Cryptographic primitives
  - `bip39` - Wallet integration (ckETH)

#### Canister (Rust)
- **Framework:** Motoko + dfx SDK
- **Storage:** Stable memory (up to 500 GiB)
- **Execution:** WASI runtime with WASMEdge fallback
- **State Management:** Rust structs for agent data, memories, tasks

#### dApp (Optional - Next.js)
- **Framework:** Next.js 14+ (App Router)
- **State Fetching:** Agent SDK (ICP agent-calls)
- **Authentication:** Internet Identity (Internet Computer) for canister authentication
- **Deployment:** Fleek or direct dfx deploy

### 4.2 Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLI (Node.js/TypeScript)                  │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ Agent Packaging │ Migration │ Deployment   │ Execution    │ │
│  │ Compile to   │ Upload      │             │ On-Chain    │ │
│  │ WASM         │ to ICP     │             │ Query State │ │
│  │              │ Canister   │             │             │ │
│  └──────┬────────┴────────┴────┬────────┘             │
│         │                    │         │             │            │
│         ▼                    │         ▼             │            │
│  ┌──────────────────┐   ┌────────────┐   ┌──────────────────┐ │
│  │ AgentVault CLI    │   │ Cross-Chain  │   │ dApp (Next.js)   │ │
│  │ (User controls)   │   │ (Bitensor)    │   │ (Monitoring UI)  │ │
│  └──────────────────┘   └────────────┘   └──────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.3 Data Models

#### Agent State (Stored in Canister)
```typescript
interface AgentState {
  config: AgentConfig;
  memories: Memory[];
  tasks: Task[];
  context: Map<string, any>;
  version: string;
  lastUpdated: timestamp;
}

interface AgentConfig {
  name: string;
  model: string;
  settings: Map<string, any>;
  permissions: string[];
}

interface Memory {
  id: string;
  type: 'fact' | 'user_preference' | 'task_result';
  content: any;
  timestamp: number;
  importance: number; // 1-10
}
```

#### Task Queue (Stored in Canister)
```typescript
interface Task {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: any;
  timestamp: number;
}
```

---

## 5. Non-Functional Requirements

### 5.1 Performance
- **Packaging Time:** `<30s` to compile agent to WASM
- **Deploy Time:** `<2m` to deploy canister
- **Query Latency:** `<500ms` (95th percentile) for canister state
- **Reconstruction:** `<10s` to decrypt and rebuild agent locally

### 5.2 Reliability
- **Uptime:** 99.9%+ canister uptime
- **Error Recovery:** Graceful degradation on canister unavailability
- **Data Integrity:** Merkle tree verification for stable memory

### 5.3 Security
- **Cryptography:** Verifiably secure VetKeys implementation
- **Secret Protection:** Seed phrase never logged or stored plaintext
- **Canister Security:** Access control for agent owner, audit logs
- **Threshold Signatures:** Multi-sig approval for critical operations

### 5.4 Compatibility
- **ICP:** Motoko 0.9.2+ compatible
- **Agents:** Clawdbot (Claude Code), Goose, Cline, generic agents
- **Wallets:** ckETH, Polkadot, Solana via cbor-x

### 5.5 Scalability
- **Canister Memory:** 500 GiB stable memory (ICP limit)
- **Concurrent Agents:** 100+ agents per canister
- **State Sync:** Automatic background sync every 5 minutes

---

## 6. Implementation Phases

### Phase 1: Planning & Prototyping (Weeks 1-2)
**MVP Focus:** Basic CLI scaffolding, one agent type support

- [ ] Set up TypeScript project structure
- [ ] Implement basic CLI framework (Commander, Inquirer)
- [ ] Create agent packaging logic (WASM compilation stub)
- [ ] Implement basic ICP canister deployment
- [ ] Design state serialization format
- [ ] Create package.json with all dependencies
- [ ] Write integration tests for CLI commands
- [ ] Implement basic VetKeys integration (encryption only)

**Deliverable:** Working CLI with `agentvault package` and `agentvault deploy` commands

---

### Phase 2: Core Development (Weeks 3-6)
**MVP Focus:** Full packaging, deployment, and execution for one agent type

- [ ] Implement agent config ingestion (read existing Clawdbot/Goose/Cline configs)
- [ ] Build complete agent packaging pipeline
  - Read agent directory
  - Compile to WASM
  - Generate Candid interface
  - Serialize state JSON
- [ ] Implement canister deployment with dfx
  - Create Motoko canister scaffold
  - Upload WASM and state
  - Verify deployment
- [ ] Implement on-chain execution layer
  - Execute agent logic in canister
  - Query canister for state
- [ ] Implement reconstruction CLI
  - Fetch state from canister
  - Decrypt using VetKeys (prompt for seed)
  - Rebuild local agent (WasmEdge)
- [ ] Add error handling and logging
- [ ] Write comprehensive tests for packaging/deployment

**Deliverable:** Fully functional CLI for Clawdbot migration with persistent execution

---

### Phase 3: Multi-Agent & Cross-Chain (Weeks 7-10)
**Expansion Focus:** Multiple agent support and cross-chain actions

- [ ] Implement multi-agent canister management
- [ ] Add agent directory management (`~/.agentvault/agents/`)
- [ ] Implement cross-chain oracles (dfx Bitensor integration)
- [ ] Add wallet connection (ckETH, Polkadot, Solana)
- [ ] Build dApp monitoring UI (Next.js scaffold)
- [ ] Implement agent communication between canisters
- [ ] Add Chain Fusion smart contract deployment
- [ ] Implement heavy inference orchestration (Bitensor routing)

**Deliverable:** Multi-agent platform with cross-chain capabilities

---

### Phase 4: dApp & Advanced Features (Weeks 11-13)
**Expansion Focus:** Web interface and advanced features

- [ ] Build complete Next.js dApp
  - Canister status dashboard
  - Task queue viewer
  - Execution log browser
  - Agent configuration UI
- [ ] Implement Arweave archival integration
- [ ] Add heavy inference network integration (Bitensor API)
- [ ] Implement batched canister operations for performance
- [ ] Add advanced security features (multi-sig approvals)
- [ ] Implement performance monitoring and metrics
- [ ] Add export/import for agent backups

**Deliverable:** Full-featured platform with web interface

---

### Phase 5: Testing, Documentation, Launch (Weeks 14-16)
**Production Focus:** Polish, testing, and public release

- [ ] Comprehensive integration testing
  - Test with real agents (Clawdbot, Goose, Cline)
  - Cross-platform testing (macOS, Linux, Windows)
  - Load testing with 100+ agents
- [ ] Security audit (external if budget allows)
  - VetKeys cryptography review
  - Canister security audit
- [ ] Write complete documentation
  - User guide (migration, deployment, reconstruction)
  - Developer guide (extending agents, canister development)
  - API documentation (CLI, canister, dApp)
- [ ] Create example agents and migration guides
- [ ] Package for npm release
- [ ] Publish to npm
- [ ] Announce on GitHub/X

**Deliverable:** Production-ready open-source release

---

## 7. Success Metrics

### 7.1 Adoption
- **npm downloads:** 1,000+ within 3 months
- **GitHub stars:** 500+ within 6 months
- **Active canisters:** 50+ deployed AgentVault canisters
- **Migrated agents:** 10+ agent types supported

### 7.2 Quality
- **Test coverage:** 90%+ for all CLI and canister code
- **Bug rate:** `<0.5` critical bugs per release
- **Documentation completeness:** All commands documented with examples
- **User satisfaction:** 4.5/5.0 stars from early adopters

### 7.3 Performance
- **CLI execution time:** `<200ms` (95th percentile)
- **Deploy time:** `<2m` (canister creation + upload)
- **Query latency:** `<500ms` (95th percentile)
- **Reconstruction time:** `<10s` (decrypt + rebuild)

### 7.4 Reliability
- **Canister uptime:** 99.9%+
- **Migration success rate:** 95%+ (agent deploys successfully)
- **Data integrity:** 100% (Merkle tree verification)
- **Error recovery:** 99% graceful degradation on failures

---

## 8. Out of Scope

- **Multi-user web accounts** (focus on CLI first)
- **Cloud provider deployment** (self-hosted canisters only)
- **Native mobile app** (CLI first, dApp later)
- **AI model marketplace** (users provide their own)
- **Payment processing** (focus on crypto wallets, not fiat)
- **Enterprise features** (SSO, RBAC, audit logs - Phase 2+)

---

## 9. Risks & Mitigations

### 9.1 Technical Risks

| Risk | Impact | Probability | Mitigation |
|-------|---------|------------|------------|
| ICP stability | Canister downtime | Medium | Deploy multiple canisters, implement graceful fallback |
| WASM bugs | Agent failures | Low | Extensive testing, fallback to WasmEdge |
| VetKeys complexity | Key derivation issues | Low | Thorough testing, documentation, fallback to manual keys |
| State corruption | Data loss | Low | Merkle trees, versioning, backups |
| Arweave costs | High storage fees | Low | Use as optional cache only, user-controlled archival |

### 9.2 Security Risks

| Risk | Impact | Mitigation |
|-------|---------|------------|
| Seed phrase exposure | Compromise | Never log/seed phrase; prompt for confirmation |
| Canister access | Unauthorized agents | Access control; audit logs |
| Key derivation errors | Wallet failure | VetKeys verification; fallback derivation |

### 9.3 Adoption Risks

| Risk | Impact | Mitigation |
|-------|---------|------------|
| High learning curve | Users don't adopt | Comprehensive docs; tutorials; example agents |
| ICP ecosystem complexity | Developers discouraged | Clear onboarding; example code |
| Rust/WASM skill gap | Slower development | Training resources; partner with WASM experts |

---

## 10. Resource Requirements

### 10.1 Development
- **Languages:** TypeScript, Rust (Motoko)
- **Runtimes:** Node.js 18+, dfx, Motoko 0.9.2+
- **Platforms:** macOS, Linux, Windows
- **Tools:** VS Code, Git, dfx extensions

### 10.2 Testing
- **Test Agents:** Local instances of Clawdbot, Goose, Cline
- **Test Canisters:** Up to 10 ICP canisters for load testing
- **ICP Resources:** Free tier for development (10 cycles/second)
- **Funding:** Estimate $500-1000 for MVP (canister deployment + testing)

### 10.3 Community
- **Documentation Sites:** GitHub Pages, Read the Docs
- **Communication:** Discord, GitHub Issues, Twitter/X
- **Examples:** 5+ example agents (Clawdbot, custom agents)
- **Tutorials:** Migration guide, canister development guide

---

## 11. Appendix

### A. File Structure

```
agentvault/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── commands/
│   │   ├── package.ts      # agentvault package
│   │   ├── deploy.ts       # agentvault deploy
│   │   ├── fetch.ts        # agentvault fetch
│   │   ├── decrypt.ts      # agentvault decrypt
│   │   └── rebuild.ts      # agentvault rebuild
│   ├── packaging/
│   │   ├── compiler.ts     # WASM compilation
│   │   └── serializer.ts  # State JSON export
│   ├── icp/
│   │   ├── canister.ts    # dfx deployment
│   │   └── state.ts      # Canister state queries
│   ├── security/
│   │   └── vetkeys.ts     # Encryption/decryption
│   └── utils/
│       └── logger.ts       # CLI logging
├── tests/
│   ├── unit/                # Unit tests
│   ├── integration/         # Integration tests
│   └── e2e/               # End-to-end tests
├── docs/
│   ├── user-guide.md       # Migration tutorial
│   ├── dev-guide.md       # Developer documentation
│   └── api.md             # CLI and canister APIs
├── examples/
│   ├── agents/
│   │   ├── clawdbot/    # Clawdbot example
│   │   ├── goose/       # Goose example
│   │   └── generic/      # Generic agent example
│   └── canisters/
│       └── motoko/     # Example canister code
└── package.json
```

### B. CLI Commands Reference

```bash
# Packaging (compile agent to WASM)
agentvault package ./path/to/agent

# Deployment (upload to ICP canister)
agentvault deploy <agent-name> [--canister <canister-id>]

# Execution (run agent on-chain)
agentvault exec <agent-name> <task>

# State Management
agentvault list                          # List all agents
agentvault show <agent-name>            # Show agent state
agentvault fetch <agent-name>            # Download state from canister
agentvault decrypt <agent-name>           # Decrypt state (prompts for seed)
agentvault rebuild <agent-name>           # Rebuild locally from canister state
agentvault backup <agent-name>           # Export agent backup

# Cross-Chain
agentvault chain-bridge <agent> <chain> <action>    # Cross-chain action

# dApp (Phase 2+)
agentvault dapp start [--port 3000]        # Start monitoring UI
```

---

## License

MIT License - Open source, freely usable and modifiable.

---

*This PRD is complete and ready for Ralph Inferno to process*
