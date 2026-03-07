Phase 3: Local Development & Debugging - Implementation Plan
📊 Current State Analysis
✅ What's Already Built (Phase 1-2):
- Core CLI: init, package, deploy, fetch, decrypt, rebuild, exec, list, show, wallet
- ICP Integration: Full icp-cli wrapper with identity, cycles, tokens, network functions
- Monitoring: Health checks, alerts, canister info, stats
- Environment Management: Basic config loading, multiple environments support
- Deployment: ICP client with @dfinity/agent SDK, canister deployment
- ic-wasm Wrapper: optimize, shrink, resource, metadata, instrument, info
❌ What's Missing for Phase 3:
- No local network management CLI commands
- No local testing framework
- No debugging instrumentation CLI
- No log aggregation system
- No environment promotion/rollback
- No trace/profile CLI commands
- No debug dashboard
---
🎯 Phase 3 Goals
3.1 Local Network Management (Week 6)
Enable developers to spawn and manage isolated local ICP networks for fast iteration.
3.2 Multi-Environment Deployment (Week 7)
Support dev → staging → production workflows with promotion and rollback.
3.3 Instrumentation & Debugging (Week 8)
Provide advanced debugging capabilities with execution tracing and profiling.
---
📋 Detailed Implementation Tasks
Week 6: Local Network Management
Task 1.1: Network CLI Commands
Files to Create:
- cli/commands/network.ts
Subcommands to implement:
agentvault network create --name <net-name> --nodes <n>  # Create local network config
agentvault network start <net-name>                    # Start local network
agentvault network stop <net-name>                     # Stop local network
agentvault network status <net-name>                   # Get network status
agentvault network list                                # List all networks
agentvault network ping <net-name>                     # Check connectivity
Implementation Details:
- Wrap existing icpcli.networkStart(), networkStop(), networkStatus(), networkList(), networkPing()
- Add network configuration storage in ~/.agentvault/networks/
- Support creating named network configs (stored as YAML)
- Add create subcommand with options: --nodes, --replica-count, --cycles
Task 1.2: Local Deployment Helper
Files to Create:
- src/deployment/local-deploy.ts
Functions:
- deployToLocal(wasmPath: string, networkName: string): Promise<DeployResult>
- snapshotCanister(canisterId: string): Promise<Snapshot>
- restoreCanister(snapshot: Snapshot): Promise<void>
- getLocalNetworkStatus(): Promise<NetworkStatus>
Features:
- Fast deployment to running local network (skip dfx)
- Snapshot canister state to .agentvault/snapshots/
- Quick restore from snapshot
- Debugging mode flags (source maps, verbose logging)
Task 1.3: Local Test Runner
Files to Create:
- src/testing/local-runner.ts
- cli/commands/test.ts
Commands:
agentvault test <agent-name> --network <net> --unit           # Run unit tests
agentvault test <agent-name> --network <net> --integration  # Integration tests
agentvault test <agent-name> --network <net> --load-test    # Load test
agentvault test <agent-name> --watch                       # Watch mode for TDD
Implementation:
- Use vitest with ICP canister targets
- Generate test reports (JUnit, HTML)
- Run against local canister ID
- Load test with configurable concurrency
- Watch mode for test-driven development
---
Week 7: Multi-Environment Deployment
Task 2.1: Enhanced Environment Config
Files to Update:
- src/icp/environment.ts (extend existing)
- Create ~/.agentvault/icp.yaml.example (example config)
Enhanced Features:
environments:
  local:
    network:
      type: local
      replica_count: 4
    cycles:
      initial: 100T
      min_cycles: 10T
      auto_topup: true
  dev:
    network:
      type: ic
      subnet: subnet-id
    cycles:
      initial: 1T
    identity: dev-wallet
    canisters:
      agent1: rrkah-...   # Track deployed canisters
  staging:
    network:
      type: ic
      subnet: staging-subnet
    cycles:
      initial: 10T
    identity: staging-wallet
  production:
    network:
      type: ic
      subnet: prod-subnet
    cycles:
      initial: 100T
    identity: prod-wallet
optimization:
  enabled: true
  level: O3
  shrink: true
  remove_debug: false  # Keep in prod for debugging
Task 2.2: Environment Promotion System
Files to Create:
- src/deployment/promotion.ts
- cli/commands/promote.ts
Commands:
agentvault promote <agent-name> --from dev --to staging    # Promote canister
agentvault promote <agent-name> --from staging --to prod   # Blue-green deploy
Features:
- Fetch WASM hash from source canister
- Deploy to target environment
- Track deployment history in ~/.agentvault/history/
- Rollback support (revert to previous version)
- Blue/green deployment support (parallel canisters)
Task 2.3: Environment Rollback
Files to Create:
- cli/commands/rollback.ts
Commands:
agentvault rollback <agent-name> --env <env> --version <v>  # Rollback
agentvault rollback <agent-name> --env <env> --to <timestamp> # Rollback to time
Features:
- List deployment history for canister
- Select version to rollback to
- Quick rollback (uses same WASM hash)
- Rollback validation (cycles, health check)
---
Week 8: Instrumentation & Debugging
Task 3.1: Instrumentation Integration
Files to Create:
- src/icp/instrumentation.ts
Functions:
- instrumentWasm(wasmPath: string, outputPath: string): Promise<InstrumentResult>
- getExecutionTrace(canisterId: string): Promise<Trace[]>
- parseTraceData(traceData: Buffer): ParsedTrace
Features:
- Wrap existing icwasm.instrument() 
- Parse execution trace output
- Export trace to JSON for analysis
- Visualize call stacks
- Method-level timing extraction
Task 3.2: Debug Dashboard
Files to Create:
- src/debugging/dashboard.ts
- cli/commands/dashboard.ts (optional TUI dashboard)
Commands:
agentvault dashboard <canister-id>                    # Launch TUI dashboard
agentvault trace <canister-id> --filter <method>    # View traces
agentvault profile <canister-id> --period <time>     # Profile performance
Dashboard Features:
- Real-time metrics: Cycles, memory, request rate, error rate
- Execution traces: Call tree visualization with timing
- Memory profiling: Heap usage, stable memory allocation
- Log aggregation: Live log stream with filtering
- Alert center: Live alert feed with severity levels
- Hot reload: Refresh on deployment
Task 3.3: Log Aggregation System
Files to Create:
- src/debugging/logs.ts
- cli/commands/logs.ts
Commands:
agentvault logs <canister-id> --tail                        # Tail logs
agentvault logs <canister-id> --filter <pattern>              # Filter logs
agentvault logs <canister-id> --since <time>                 # Since timestamp
agentvault logs <canister-id> --export <file>                # Export logs
agentvault logs <canister-id> --level <error|warning|info>  # Filter by level
Features:
- Collect logs from multiple sources (console, stdout, canister logs)
- Store in ~/.agentvault/logs/<canister-id>/
- Full-text search across logs
- Time-based filtering
- Export to JSON/CSV for analysis
Task 3.4: Advanced Debugging Commands
Files to Create:
- cli/commands/instrument.ts
- cli/commands/trace.ts  
- cli/commands/profile.ts
Commands:
agentvault instrument <wasm-file> --output <out.wasm>     # Instrument WASM
agentvault trace <canister-id> --depth <n>                # Get execution traces
agentvault profile <canister-id> --duration <seconds>        # Profile canister
Instrument Command Features:
- Add debug sections to stable memory
- Emit method entry/exit points
- Track stable memory growth
- Generate trace metadata
Trace Command Features:
- Fetch traces from stable memory
- Display call tree with timing
- Filter by method name
- Export trace to flamegraph format
Profile Command Features:
- Sample CPU/memory usage over time
- Generate flamegraph visualization
- Identify performance bottlenecks
- Export profile data
---
🗂 File Structure Updates
New Directories:
src/
  debugging/
    dashboard.ts        # Debug TUI dashboard
    logs.ts             # Log aggregation
  testing/
    local-runner.ts     # Local test runner
    types.ts            # Test-related types
cli/commands/
  network.ts           # Network management
  test.ts              # Testing command
  promote.ts          # Promotion command
  rollback.ts         # Rollback command
  instrument.ts       # Instrument WASM
  trace.ts            # View traces
  profile.ts          # Profile canister
  dashboard.ts        # Debug dashboard
  logs.ts             # Log viewing
~/.agentvault/
  networks/           # Network configs
  snapshots/          # Canister snapshots
  history/            # Deployment history
  logs/               # Collected logs
  icp.yaml.example    # Example config
---
🔧 Type Definitions to Add
src/icp/types.ts additions:
export interface NetworkConfig {
  name: string;
  type: 'local' | 'ic';
  nodes?: number;
  replicaCount?: number;
  cycles?: {
    initial: string;
    min?: string;
    autoTopup?: boolean;
  };
  created?: Date;
  status?: 'running' | 'stopped' | 'error';
}
export interface DeploymentHistory {
  agentName: string;
  environment: string;
  canisterId: string;
  wasmHash: string;
  timestamp: Date;
  version: number;
  success: boolean;
}
export interface CanisterSnapshot {
  canisterId: string;
  timestamp: Date;
  state: ArrayBuffer;
  cycles: bigint;
  memory: bigint;
}
export interface ExecutionTrace {
  method: string;
  startTime: number;
  endTime: number;
  duration: number;
  caller?: string;
  children: ExecutionTrace[];
  memoryDelta?: bigint;
}
src/debugging/types.ts (new file):
export interface LogEntry {
  timestamp: Date;
  level: 'info' | 'warning' | 'error' | 'debug';
  message: string;
  canisterId: string;
  method?: string;
  context?: Record<string, any>;
}
export interface TraceFilter {
  method?: string;
  minDuration?: number;
  maxDepth?: number;
  caller?: string;
}
export interface ProfileResult {
  samples: number;
  duration: number;
  methodStats: Map<string, {
    count: number;
    totalDuration: number;
    avgDuration: number;
    maxDuration: number;
  }>;
  memorySnapshots: number[];
}
---
📊 Dependencies to Consider
Potential New Dependencies:
- blessed or ink for TUI dashboard
- flamegraph for trace visualization
- winston or pino for advanced logging (optional)
- chalk-animation for dashboard animations
Already Available:
- commander - CLI framework ✅
- chalk - Terminal styling ✅
- ora - Spinners ✅
- execa - Process execution ✅
- yaml - Config parsing ✅
---
✅ Implementation Priorities
High Priority (Must Have):
1. Network CLI commands - Essential for local development
2. Local test runner - Required for CI/CD integration
3. Environment promotion - Critical for dev → prod workflows
4. Log aggregation - Debugging prerequisite
Medium Priority (Should Have):
5. Canister snapshots - Speed up development iterations
6. Trace viewing - Performance analysis
7. Rollback functionality - Production safety
Low Priority (Nice to Have):
8. TUI dashboard - Visual debugging aid
9. Profiling tools - Advanced performance analysis
10. Load testing - Stress testing capability
---
🧪 Testing Strategy
Unit Tests:
- Each CLI command
- Network management functions
- Test runner logic
- Instrumentation parsing
Integration Tests:
- Deploy to local network → test → promote to staging
- Full workflow: init → package → deploy → test → promote
- Rollback workflow
E2E Tests:
- Complete local dev cycle
- Multi-environment deployment
- Debugging with traces
---
📝 Questions Before Implementation
1. Dashboard Preference: Do you want a TUI (terminal-based) dashboard or a web-based dashboard?
2. Testing Framework: Should we extend the existing vitest setup for local canister testing, or integrate with a different framework?
3. Storage Location: Should all Phase 3 data (networks, snapshots, logs) go in ~/.agentvault/, or allow custom paths via environment variable?
4. Backward Compatibility: Should Phase 3 features be opt-in (require config) or work with existing Phase 1-2 workflows automatically?
5. Priority Order: Should we implement all of Week 6 first before moving to Week 7, or interleave tasks to get end-to-end functionality working sooner?
---
🚀 Success Criteria
Phase 3 is complete when:
- ✅ Developers can spawn local networks with agentvault network create/start
- ✅ Canisters can be deployed and tested locally with fast iteration
- ✅ Promotions work: agentvault promote <agent> --from dev --to prod
- ✅ Rollbacks can restore previous canister versions
- ✅ Execution traces can be viewed with agentvault trace
- ✅ Logs are aggregated and searchable with agentvault logs
- ✅ Optional debug dashboard provides real-time visualization
