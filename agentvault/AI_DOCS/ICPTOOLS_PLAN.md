Implementation Plan: ICP Tools Integration (All Phases)
Overview
This plan implements the full PRD across 8 weeks, integrating ic-wasm and icp-cli into AgentVault with auto-detection of available tools.
---
Phase 1: Core Integration (Weeks 1-3)
Week 1: Tool Wrappers
Tasks:
1. Create ic-wasm wrapper (src/icp/icwasm.ts)
   - Execute ic-wasm commands (optimize, shrink, resource, metadata, check-endpoints, info)
   - Parse output and errors
   - TypeScript interfaces for all ic-wasm operations
   - Auto-detect if ic-wasm is available
2. Create icp-cli wrapper (src/icp/icpcli.ts)
   - Execute icp-cli commands (build, deploy, canister, cycles, identity, network, token)
   - Handle authentication
   - Parse responses
   - Auto-detect if icp-cli is available
3. Add dependencies
   - execa for running external commands
   - execa type definitions
4. Write unit tests
   - Wrapper functionality tests (90% coverage target)
   - Mock external command execution
   - Test auto-detection logic
Files to create:
- src/icp/icwasm.ts
- src/icp/icpcli.ts
- src/icp/types.ts
- src/icp/index.ts
- tests/unit/icwasm.test.ts
- tests/unit/icpcli.test.ts
---
Week 2: Packaging Integration
Tasks:
1. Integrate ic-wasm optimize into packaging pipeline
   - Modify src/packaging/compiler.ts
   - Add optimization step after WASM generation
   - Support --optimize-level flag (0-3)
   - Generate optimization reports
2. Add ic-wasm shrink before deployment
   - Minimize WASM size with --shrink flag
   - Track size reduction metrics
   - Report before/after sizes
3. Implement resource limit configuration
   - Add --memory-limit, --compute-quota, --instruction-limit flags
   - Use ic-wasm resource command
   - Persist limits in config
4. Add validation with check-endpoints
   - Compare generated WASM against Candid interface
   - Fail packaging on validation errors
   - Support --validate flag
5. Update CLI package command
   - Add new flags: --optimize, --shrink, --validate, --memory-limit, etc.
   - Display optimization results
Files to modify:
- src/packaging/compiler.ts (major changes)
- src/packaging/types.ts (add optimization options)
- src/packaging/packager.ts (add optimization step)
- cli/commands/package.ts (add new flags)
Files to create:
- src/icp/optimization.ts (orchestrator for ic-wasm operations)
Tests:
- tests/packaging/optimization.test.ts
- Integration tests for packaging with optimization
---
Week 3: Deployment Integration
Tasks:
1. Migrate deployment to icp-cli
   - Modify src/deployment/deployer.ts to use icp-cli
   - Fallback to dfx if icp-cli not available (auto-detect)
   - Support multiple environments (local, ic, mainnet, dev, staging, production)
2. Add environment management
   - Create src/icp/environment.ts
   - Read icp.yaml configuration
   - Manage environment-specific settings
   - Support project-root overrides
3. Implement sync functionality
   - Add icp-cli sync integration
   - Keep remote canisters in sync
   - Handle incremental updates
   - Report sync status
4. Write integration tests
   - Test deployment across environments
   - Test fallback to dfx
   - Test sync functionality
Files to create:
- src/icp/environment.ts
- src/icp/sync.ts
Files to modify:
- src/deployment/deployer.ts (add icp-cli integration)
- src/deployment/types.ts (extend for new options)
- cli/commands/deploy.ts (add env options)
Tests:
- tests/deployment/icpcli-deploy.test.ts
- tests/integration/deployment-sync.test.ts
---
Phase 2: Monitoring & Management (Weeks 4-5)
Week 4: Monitoring
Tasks:
1. Implement canister info query
   - Use ic-wasm info to extract metadata
   - Display resource usage
   - Show WASM module details
   - Create src/monitoring/info.ts
2. Add health checking
   - Periodic canister status polling
   - Alert on cycle depletion
   - Detect performance degradation
   - Create src/monitoring/health.ts
3. Build monitoring dashboard (CLI)
   - Real-time status display with --watch flag
   - Color-coded health indicators
   - Resource usage graphs (text-based)
   - Create cli/commands/monitor.ts
4. Implement alerting
   - Threshold-based alerts (cycles < 10T, memory > 80%, etc.)
   - Multiple notification levels
   - Alert history
   - Create src/monitoring/alerting.ts
Files to create:
- src/monitoring/info.ts
- src/monitoring/health.ts
- src/monitoring/alerting.ts
- src/monitoring/index.ts
- src/monitoring/types.ts
- cli/commands/monitor.ts
Tests:
- tests/monitoring/info.test.ts
- tests/monitoring/health.test.ts
- tests/monitoring/alerting.test.ts
---
Week 5: Identity & Cycles
Tasks:
1. Add identity management
   - List available identities
   - Create new identities
   - Import/export identity files
   - Handle identity passwords securely
   - Create src/icp/identity.ts
2. Implement cycle management
   - Check cycle balances across canisters
   - Mint cycles for canisters
   - Transfer cycles between canisters
   - Predict cycle depletion
   - Create src/icp/cycles.ts
3. Add token operations
   - ICP token transfers
   - ICRC-1/ICRC-2 token support
   - Query token balances
   - Create src/icp/tokens.ts
4. Create CLI commands
   - cli/commands/identity.ts
   - cli/commands/cycles.ts
   - cli/commands/tokens.ts
Files to create:
- src/icp/identity.ts
- src/icp/cycles.ts
- src/icp/tokens.ts
- cli/commands/identity.ts
- cli/commands/cycles.ts
- cli/commands/tokens.ts
Tests:
- tests/icp/identity.test.ts
- tests/icp/cycles.test.ts
- tests/icp/tokens.test.ts
---
Phase 3: Advanced Features (Weeks 6-8)
Week 6: Local Development
Tasks:
1. Local network management
   - Launch local networks via icp-cli network
   - Create isolated test environments
   - Configure network parameters
   - Manage multiple local networks
   - Create src/icp/network.ts
2. Deploy to local networks
   - Fast iteration cycles
   - Debugging support
   - Snapshot/restore capability
   - Create src/deployment/local-deploy.ts
3. Local canister testing
   - Run unit tests against local canisters
   - Integration testing
   - Load testing
   - Create src/testing/local-runner.ts
Files to create:
- src/icp/network.ts
- src/deployment/local-deploy.ts
- src/testing/local-runner.ts
- cli/commands/network.ts
- cli/commands/test.ts
Tests:
- tests/icp/network.test.ts
- tests/deployment/local-deploy.test.ts
---
Week 7: Multi-Environment
Tasks:
1. Environment configuration via icp.yaml
   - Define multiple environments (dev, staging, production)
   - Environment-specific settings
   - Shared configuration inheritance
   - Create src/config/icp-config.ts
2. Deploy across environments
   - Promote canisters between environments
   - Environment rollbacks
   - Blue/green deployments
   - Create src/deployment/promotion.ts
3. Environment isolation
   - Separate cycles per environment
   - Independent canister IDs
   - Environment-specific identities
   - Enhance src/icp/environment.ts
Files to create:
- src/config/icp-config.ts
- src/config/types.ts
- src/deployment/promotion.ts
- cli/commands/promote.ts
- cli/commands/rollback.ts
- ~/.agentvault/icp.yaml (example config)
Tests:
- tests/config/icp-config.test.ts
- tests/deployment/promotion.test.ts
---
Week 8: Instrumentation & Debugging
Tasks:
1. Integrate ic-wasm instrument
   - Emit execution traces to stable memory
   - Method-level timing information
   - Call stack visualization
   - Create src/icp/instrumentation.ts
2. Debug dashboard
   - View execution traces
   - Analyze performance bottlenecks
   - Memory usage profiling
   - Create src/debugging/dashboard.ts
3. Log aggregation
   - Collect canister logs
   - Filter and search logs
   - Export log data
   - Create src/debugging/logs.ts
4. Create CLI commands
   - cli/commands/instrument.ts
   - cli/commands/trace.ts
   - cli/commands/profile.ts
   - cli/commands/logs.ts
Files to create:
- src/icp/instrumentation.ts
- src/debugging/dashboard.ts
- src/debugging/logs.ts
- cli/commands/instrument.ts
- cli/commands/trace.ts
- cli/commands/profile.ts
- cli/commands/logs.ts
Tests:
- tests/icp/instrumentation.test.ts
- tests/debugging/dashboard.test.ts
- tests/debugging/logs.test.ts
---
Configuration Files
New config files to create:
1. ~/.agentvault/icp.yaml - ICP environment configuration
2. ~/.agentvault/toolchain.yaml - Toolchain settings
3. config/icp.schema.json - Zod validation schema
Example icp.yaml structure:
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
---
package.json Updates
New dependencies to add:
{
  dependencies: {
    execa: ^8.0.0
  },
  devDependencies: {
    @types/execa: ^8.0.0
  }
}
---
Directory Structure (After Implementation)
src/
├── canister/          # Existing
├── config/            # NEW
│   ├── icp-config.ts
│   ├── types.ts
│   └── index.ts
├── debugging/         # NEW
│   ├── dashboard.ts
│   ├── logs.ts
│   └── index.ts
├── deployment/        # Modified
│   ├── deployer.ts
│   ├── icpClient.ts
│   ├── promotion.ts   # NEW
│   ├── local-deploy.ts # NEW
│   └── ...
├── icp/               # NEW
│   ├── icwasm.ts
│   ├── icpcli.ts
│   ├── identity.ts
│   ├── cycles.ts
│   ├── tokens.ts
│   ├── network.ts
│   ├── environment.ts
│   ├── sync.ts
│   ├── optimization.ts
│   ├── instrumentation.ts
│   ├── types.ts
│   └── index.ts
├── monitoring/        # NEW
│   ├── info.ts
│   ├── health.ts
│   ├── alerting.ts
│   ├── types.ts
│   └── index.ts
├── packaging/         # Modified
│   ├── compiler.ts
│   ├── packager.ts
│   └── ...
├── security/          # Existing
├── testing/           # NEW
│   ├── local-runner.ts
│   └── index.ts
└── wallet/            # Existing
cli/commands/         # Modified + NEW
├── deploy.ts
├── package.ts
├── monitor.ts        # NEW
├── identity.ts       # NEW
├── cycles.ts         # NEW
├── tokens.ts         # NEW
├── network.ts        # NEW
├── test.ts           # NEW
├── promote.ts        # NEW
├── rollback.ts       # NEW
├── instrument.ts     # NEW
├── trace.ts         # NEW
├── profile.ts        # NEW
├── logs.ts           # NEW
└── ...
---
Key Implementation Considerations
1. Auto-Detection Strategy (Hybrid):
      // Check for ic-wasm
   const hasIcwasm = await detectTool('ic-wasm');
   
   // Check for icp-cli
   const hasIcpCli = await detectTool('icp-cli');
   
   // Check for dfx
   const hasDfx = await detectTool('dfx');
   
   // Use best available tool
   if (hasIcpCli) {
     return await deployWithIcpCli(options);
   } else if (hasDfx) {
     return await deployWithDfx(options);
   } else {
     throw new Error('No deployment tool available');
   }
   
2. Error Handling:
   - Wrap all external command calls with try/catch
   - Parse stderr/stderr for meaningful error messages
   - Provide fallback suggestions
   - Log errors for debugging
3. Testing Strategy:
   - Mock external commands in unit tests
   - Use test fixtures for command outputs
   - Integration tests require actual tool availability (skip if missing)
   - E2E tests for complete workflows
4. Performance Targets (from PRD):
   - WASM size reduction: 40-60%
   - Packaging time: <45s
   - Deployment time: <90s
   - Query latency: <200ms
   - Cycle minting: <10s
5. Backward Compatibility:
   - Keep existing dfx functionality
   - Default to auto-detect, prefer icp-cli when available
   - Add deprecation warnings for dfx commands
   - Gradual migration path documented in README
---
Success Metrics (from PRD)
- ✅ WASM Size Reduction: 40-60% after optimization
- ✅ Packaging Time: <45s
- ✅ Deployment Time: <90s
- ✅ Query Latency: <200ms
- ✅ Deployment Success Rate: 98%+
- ✅ Rollback Time: <30s
- ✅ Test Coverage: 90% for wrappers, 85% for integration layer
