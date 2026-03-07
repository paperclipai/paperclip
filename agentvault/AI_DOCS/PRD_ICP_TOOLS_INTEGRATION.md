# AgentVault ICP Tools Integration
## Product Requirements Document (PRD)

**Version:** 1.0
**Date:** February 5, 2026
**Status:** Draft
**Related PRD:** Main AgentVault PRD (v1.0)

---

## 1. Executive Summary

This PRD outlines the integration of official ICP tooling (`ic-wasm` and `icp-cli`) into the AgentVault CLI to provide a more robust, maintainable, and feature-complete solution for ICP canister management.

**Problem Statement:**
The current AgentVault implementation relies on legacy dfx workflows and manual command execution, which lacks:
- Native WASM optimization and validation
- Streamlined deployment workflows
- Official toolchain support and updates
- Efficient canister lifecycle management

**Solution:**
Integrate `ic-wasm` (0.9.11) for WASM transformations and `icp-cli` (0.1.0) for canister operations, providing:
- Automatic canister optimization before deployment
- Native ICP network management
- Official toolchain compatibility
- Enhanced security and validation

**Value Proposition:**
- **50-70% smaller WASM files** through ic-wasm optimization
- **Faster deployments** with icp-cli's streamlined workflows
- **Better canister health** with resource limiting and validation
- **Official support** through ICP maintained tooling

---

## 2. Tooling Overview

### 2.1 ic-wasm (v0.9.11)
**Purpose:** CLI tool for performing Wasm transformations specific to ICP canisters

**Key Capabilities:**
- **Metadata Management**: Inject and manage custom metadata sections
- **Resource Limits**: Configure memory, CPU, and compute limits per canister
- **Optimization**: Remove dead code, minimize WASM size using wasm-opt
- **Validation**: Verify canister endpoints against Candid interfaces
- **Instrumentation**: Experimental execution tracing for debugging
- **Information**: Extract detailed canister metadata and statistics

**Relevance to AgentVault:**
- Optimize agent WASM modules before canister deployment
- Set appropriate resource limits for different agent types
- Validate canister interfaces before uploading
- Reduce deployment costs through WASM size optimization

### 2.2 icp-cli (v0.1.0)
**Purpose:** Development tool for building and deploying canisters on ICP

**Key Capabilities:**
- **Build**: Compile canisters from source (Rust, Motoko, TypeScript)
- **Deploy**: Deploy projects to multiple environments (local, testnet, mainnet)
- **Canister Operations**: Query, update, and manage canister state
- **Network Management**: Launch and manage local test networks
- **Identity Management**: Handle principal identities and authentication
- **Cycles Management**: Mint, transfer, and manage ICP cycles
- **Token Operations**: Perform ICP and ICRC token transactions
- **Environment Management**: Multi-environment project configurations

**Relevance to AgentVault:**
- Streamlined canister deployment workflows
- Multi-environment support (dev, staging, prod)
- Built-in identity and cycle management
- Local testing capabilities

---

## 3. Functional Requirements

### 3.1 Integration Points

#### 3.1.1 Canister Packaging (Phase 1)
**Objective:** Enhance agent packaging with ic-wasm optimization

**Requirements:**
- [ ] Integrate `ic-wasm optimize` into packaging pipeline
  - Remove unused functions and debug info
  - Apply wasm-opt optimizations
  - Generate optimization reports
- [ ] Add `ic-wasm shrink` before deployment
  - Strip unused Wasm sections
  - Minimize payload size
  - Report size reduction metrics
- [ ] Configure resource limits using `ic-wasm resource`
  - Set memory limits per agent type
  - Configure compute quotas
  - Define instruction limits
- [ ] Validate canister interfaces with `ic-wasm check-endpoints`
  - Compare generated WASM against Candid interface
  - Detect endpoint mismatches
  - Fail packaging on validation errors

**CLI Commands:**
```bash
# Enhanced packaging with optimization
agentvault package <agent-dir> --optimize --shrink --validate

# Packaging with custom resource limits
agentvault package <agent-dir> \
  --memory-limit 4GiB \
  --compute-quota 10000000000 \
  --optimize-level 3
```

**Success Metrics:**
- WASM size reduction: 40-60%
- Packaging time: <45s (including optimization)
- Validation pass rate: 100% for known-good agents

#### 3.1.2 Canister Deployment (Phase 1)
**Objective:** Migrate from dfx to icp-cli for deployment

**Requirements:**
- [ ] Integrate `icp-cli deploy` for canister deployment
  - Support multiple environments (local, ic, mainnet)
  - Handle identity authentication
  - Manage cycles allocation automatically
- [ ] Implement environment management via `icp-cli environment`
  - Read icp.yaml configuration
  - Support project-root overrides
  - Manage environment-specific settings
- [ ] Add build step via `icp-cli build`
  - Compile canisters from source
  - Generate Candid interfaces
  - Handle dependencies
- [ ] Implement canister sync via `icp-cli sync`
  - Keep remote canisters in sync
  - Handle incremental updates
  - Report sync status

**CLI Commands:**
```bash
# Deploy to local network
agentvault deploy <agent-name> --env local

# Deploy to mainnet with cycles
agentvault deploy <agent-name> --env mainnet --cycles 100T

# Deploy with custom configuration
agentvault deploy <agent-name> \
  --env production \
  --identity main-wallet \
  --canister-id abc123-def456
```

**Success Metrics:**
- Deployment time: <90s (including optimization)
- Success rate: 98%+ for valid configurations
- Rollback capability: <30s

#### 3.1.3 Canister Monitoring (Phase 2)
**Objective:** Provide real-time canister health monitoring

**Requirements:**
- [ ] Query canister info using `ic-wasm info`
  - Extract metadata and statistics
  - Display resource usage
  - Show Wasm module details
- [ ] Monitor canister operations via `icp-cli canister`
  - Query canister state
  - Check cycle balance
  - List active calls
- [ ] Implement health checks
  - Periodic canister status polling
  - Alert on cycle depletion
  - Detect performance degradation
- [ ] Generate canister reports
  - Resource usage over time
  - Deployment history
  - Performance benchmarks

**CLI Commands:**
```bash
# Show canister details
agentvault info <agent-name>

# Monitor canister status
agentvault monitor <agent-name> --watch

# Show resource usage
agentvault stats <agent-name> --period 24h

# Check canister health
agentvault health <agent-name> --detailed
```

**Success Metrics:**
- Query latency: <200ms
- Monitoring interval: configurable (1-60s)
- Alert response time: <5s

#### 3.1.4 Identity & Cycle Management (Phase 2)
**Objective:** Streamline identity and cycle management

**Requirements:**
- [ ] Integrate `icp-cli identity` for identity management
  - List available identities
  - Create new identities
  - Import/export identity files
  - Handle identity passwords securely
- [ ] Add cycle management via `icp-cli cycles`
  - Check cycle balances across canisters
  - Mint cycles for canisters
  - Transfer cycles between canisters
  - Predict cycle depletion
- [ ] Implement token operations via `icp-cli token`
  - ICP token transfers
  - ICRC-1/ICRC-2 token support
  - Query token balances
  - Cross-chain token operations (where supported)

**CLI Commands:**
```bash
# Identity management
agentvault identity list
agentvault identity create <name>
agentvault identity use <name>
agentvault identity export <name> --file backup.pem

# Cycle management
agentvault cycles balance <agent-name>
agentvault cycles mint <amount> --to <canister-id>
agentvault cycles transfer <amount> --from <source> --to <dest>
agentvault cycles predict <agent-name> --days 30

# Token operations
agentvault token balance --canister <canister-id>
agentvault token transfer <amount> --to <recipient>
```

**Success Metrics:**
- Identity operations: <2s
- Cycle minting: <10s
- Token transfers: <15s
- Balance queries: <500ms

### 3.2 Advanced Features

#### 3.2.1 Local Development (Phase 3)
**Objective:** Provide comprehensive local testing capabilities

**Requirements:**
- [ ] Launch local networks via `icp-cli network`
  - Create isolated test environments
  - Configure network parameters
  - Manage multiple local networks
- [ ] Deploy to local networks
  - Fast iteration cycles
  - Debugging support
  - Snapshot/restore capability
- [ ] Local canister testing
  - Run unit tests against local canisters
  - Integration testing
  - Load testing

**CLI Commands:**
```bash
# Launch local network
agentvault network create --name testnet1 --nodes 4
agentvault network start testnet1
agentvault network status testnet1

# Deploy locally
agentvault deploy <agent-name> --network testnet1

# Run tests locally
agentvault test <agent-name> --network local --load-test
```

#### 3.2.2 Multi-Environment Deployment (Phase 3)
**Objective:** Support development, staging, and production workflows

**Requirements:**
- [ ] Environment configuration via icp.yaml
  - Define multiple environments
  - Environment-specific settings
  - Shared configuration inheritance
- [ ] Deploy across environments
  - Promote canisters between environments
  - Environment rollbacks
  - Blue/green deployments
- [ ] Environment isolation
  - Separate cycles per environment
  - Independent canister IDs
  - Environment-specific identities

**CLI Commands:**
```bash
# Promote canister
agentvault promote <agent-name> --from dev --to staging
agentvault promote <agent-name> --from staging --to prod

# Deploy to specific environment
agentvault deploy <agent-name> --env production

# Rollback environment
agentvault rollback <agent-name> --env production --version 3
```

#### 3.2.3 Instrumentation & Debugging (Phase 3)
**Objective:** Provide advanced debugging capabilities

**Requirements:**
- [ ] Integrate `ic-wasm instrument` for execution tracing
  - Emit execution traces to stable memory
  - Method-level timing information
  - Call stack visualization
- [ ] Debug dashboard
  - View execution traces
  - Analyze performance bottlenecks
  - Memory usage profiling
- [ ] Log aggregation
  - Collect canister logs
  - Filter and search logs
  - Export log data

**CLI Commands:**
```bash
# Instrument canister
agentvault instrument <agent-name> --output trace.wat

# View traces
agentvault trace <agent-name> --method updateMemory

# Performance analysis
agentvault profile <agent-name> --duration 60s

# Log management
agentvault logs <agent-name> --filter error --tail 100
```

---

## 4. Technical Architecture

### 4.1 Toolchain Integration

```
┌─────────────────────────────────────────────────────────────────────┐
│                    AgentVault CLI (Node.js/TypeScript)           │
│                                                                │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │                    Command Layer                            │ │
│  │  package  │  deploy  │  monitor  │  manage           │ │
│  └────────────┬──────────┬────────────┬───────────────────────┘ │
│               │          │          │                           │
│  ┌────────────▼──────────▼──────────▼───────────────────────┐ │
│  │                  Integration Layer                         │ │
│  │  ic-wasm wrapper  │  icp-cli wrapper  │  Orchestrator │ │
│  └──────┬──────────────┬──────────────┬────────────────────┘ │
│         │              │              │                         │
│  ┌──────▼──────────────▼──────────────▼────────────────────┐ │
│  │              Tool Invocation Layer                         │ │
│  │  Spawn ic-wasm  │  Spawn icp-cli  │  Parse Output   │ │
│  └──────┬──────────────┬──────────────┬────────────────────┘ │
│         │              │              │                         │
│         ▼              ▼              ▼                         │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │              ICP Toolchain                           │ │
│  │  ic-wasm (v0.9.11)  │  icp-cli (v0.1.0)      │ │
│  └──────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

### 4.2 Package.json Updates

**New Dependencies:**
```json
{
  "dependencies": {
    "execa": "^8.0.0",
    "chalk": "^5.3.0",
    "ora": "^7.0.0",
    "inquirer": "^9.2.0"
  },
  "devDependencies": {
    "@types/inquirer": "^9.0.0",
    "@types/execa": "^8.0.0"
  }
}
```

### 4.3 Configuration Structure

**New config files:**
- `~/.agentvault/icp.yaml` - ICP environment configuration
- `~/.agentvault/toolchain.yaml` - Toolchain settings

**icp.yaml example:**
```yaml
environments:
  local:
    network:
      type: local
      replica_count: 4
    cycles:
      initial: 100T
  dev:
    network:
      type: ic
      replica_count: 13
    cycles:
      initial: 1T
    identity: dev-wallet
  staging:
    network:
      type: ic
      replica_count: 28
    cycles:
      initial: 10T
    identity: staging-wallet
  production:
    network:
      type: ic
      replica_count: 28
    cycles:
      initial: 100T
    identity: main-wallet

optimization:
  level: 3
  shrink: true
  remove_debug: true
  wasm_opt_flags:
    - --O3
    - --dce
    - --strip-debug
```

---

## 5. Implementation Phases

### Phase 1: Core Integration (Weeks 1-3)
**Focus:** Basic ic-wasm and icp-cli integration

**Week 1: Tool Wrappers**
- [ ] Create `ic-wasm` wrapper module (`src/icp/icwasm.ts`)
  - Execute ic-wasm commands
  - Parse output and errors
  - Provide TypeScript interfaces
- [ ] Create `icp-cli` wrapper module (`src/icp/icpcli.ts`)
  - Execute icp-cli commands
  - Handle authentication
  - Parse responses
- [ ] Add error handling and logging
- [ ] Write unit tests for wrappers

**Week 2: Packaging Integration**
- [ ] Integrate ic-wasm optimize into packaging
  - Modify `src/packaging/compiler.ts`
  - Add optimization step
  - Generate optimization reports
- [ ] Add ic-wasm shrink before deployment
  - Minimize WASM size
  - Track size reduction metrics
- [ ] Implement resource limit configuration
- [ ] Add validation with check-endpoints

**Week 3: Deployment Integration**
- [ ] Migrate deployment to icp-cli
  - Modify `src/icp/canister.ts`
  - Implement deploy command
  - Handle environments
- [ ] Add environment management
- [ ] Implement sync functionality
- [ ] Write integration tests

**Deliverables:**
- Functional ic-wasm and icp-cli wrappers
- Optimized packaging pipeline
- Working deployment with icp-cli

### Phase 2: Monitoring & Management (Weeks 4-5)
**Focus:** Canister monitoring, identity, and cycle management

**Week 4: Monitoring**
- [ ] Implement canister info query
- [ ] Add health checking
- [ ] Build monitoring dashboard (CLI)
- [ ] Implement alerting

**Week 5: Identity & Cycles**
- [ ] Add identity management commands
- [ ] Implement cycle management
- [ ] Add token operations
- [ ] Create prediction algorithms

**Deliverables:**
- Complete monitoring system
- Identity and cycle management
- Token operations support

### Phase 3: Advanced Features (Weeks 6-8)
**Focus:** Local testing, multi-env, and instrumentation

**Week 6: Local Development**
- [ ] Local network management
- [ ] Local deployment workflows
- [ ] Testing infrastructure

**Week 7: Multi-Environment**
- [ ] Environment configuration
- [ ] Promotion workflows
- [ ] Rollback support

**Week 8: Debugging**
- [ ] Instrumentation integration
- [ ] Trace analysis
- [ ] Debugging tools

**Deliverables:**
- Local development environment
- Multi-environment deployment
- Advanced debugging capabilities

---

## 6. Migration Path

### 6.1 Backward Compatibility
- Keep existing dfx-based deployment as fallback
- Gradual migration path for existing users
- Configuration migration tool

### 6.2 Breaking Changes
- New configuration format (icp.yaml)
- Changes to command flags
- Different output format

### 6.3 Migration Strategy
1. **Phase 1:** Add ic-wasm/icp-cli alongside dfx (parallel support)
2. **Phase 2:** Default to new tools, dfx as fallback
3. **Phase 3:** Deprecate dfx, fully migrate

---

## 7. Success Metrics

### 7.1 Performance
- **WASM Size Reduction:** 40-60% after optimization
- **Packaging Time:** <45s (including optimization)
- **Deployment Time:** <90s (including optimization and deploy)
- **Query Latency:** <200ms for canister info
- **Monitor Interval:** Configurable 1-60s

### 7.2 Reliability
- **Deployment Success Rate:** 98%+
- **Rollback Time:** <30s
- **Cycle Minting:** <10s
- **Identity Operations:** <2s

### 7.3 Adoption
- **Migration Rate:** 80% of existing users within 3 months
- **New Users:** 100% using icp-cli from day 1
- **Documentation:** All commands documented with examples

---

## 8. Testing Strategy

### 8.1 Unit Tests
- ic-wasm wrapper: 90% coverage
- icp-cli wrapper: 90% coverage
- Integration layer: 85% coverage

### 8.2 Integration Tests
- Packaging with optimization
- Deployment across environments
- Cycle transfer operations
- Identity management

### 8.3 E2E Tests
- Full workflow: package → optimize → deploy → monitor
- Multi-environment promotion
- Rollback scenarios
- Local network testing

---

## 9. Documentation

### 9.1 User Documentation
- Migration guide (dfx → icp-cli)
- Optimization configuration
- Multi-environment setup
- Identity and cycle management

### 9.2 Developer Documentation
- Tool wrapper API
- Integration layer architecture
- Configuration reference
- Testing guidelines

### 9.3 Examples
- Environment configurations
- Optimization profiles
- Deployment workflows
- Monitoring dashboards

---

## 10. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|-------|---------|------------|------------|
| ic-wasm/icp-cli bugs | Deployment failures | Low | Extensive testing, fallback to dfx |
| Breaking changes in tools | Compatibility issues | Medium | Version pinning, migration tools |
| Performance overhead | Slower workflows | Low | Benchmarking, optimization |
| Learning curve | User confusion | Medium | Comprehensive docs, examples |
| Tool dependency | Vendor lock-in | Low | Maintain abstraction layer |

---

## 11. Out of Scope

- Custom ic-wasm development
- Forking icp-cli
- Alternative deployment methods
- GUI interfaces (CLI only)
- Cloud provider integration

---

## 12. Related PRDs

- Main AgentVault PRD (v1.0)
- Phase-specific implementation docs
- Security requirements document

---

## 13. Appendix

### A. ic-wasm Commands Reference

```bash
# Metadata management
ic-wasm <input> metadata set <key> <value>
ic-wasm <input> metadata get <key>
ic-wasm <input> metadata list

# Resource limits
ic-wasm <input> resource set memory <limit>
ic-wasm <input> resource set compute <limit>
ic-wasm <input> resource list

# Optimization
ic-wasm <input> optimize -o output.wasm
ic-wasm <input> shrink -o output.wasm

# Validation
ic-wasm <input> check-endpoints --interface candid.did

# Information
ic-wasm <input> info
```

### B. icp-cli Commands Reference

```bash
# Build
icp build

# Deploy
icp deploy --env production

# Canister
icp canister info <canister-id>
icp canister call <canister-id> <method>

# Cycles
icp cycles balance <canister-id>
icp cycles mint <amount>

# Identity
icp identity list
icp identity create <name>

# Network
icp network create <name>
icp network start <name>

# Token
icp token balance --canister <canister-id>
icp token transfer <amount> --to <recipient>
```

---

## License

MIT License - Open source, freely usable and modifiable.

---

*This PRD is ready for implementation and will be developed alongside the main AgentVault PRD*
