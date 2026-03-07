Phase 4: dApp & Advanced Features - Implementation Plan

---

## Current State Analysis

### What's Already Built (Phases 1-3)

**Core CLI (32 commands):**
- Agent lifecycle: init, package, deploy, fetch, decrypt, rebuild, exec, list, show, status
- Wallet system: wallet (connect/disconnect/balance/send/list), wallet-sign, wallet-history, wallet-export, wallet-import, wallet-multi-send, wallet-process-queue
- ICP management: identity, cycles, tokens, network (create/start/stop/status/list/ping)
- Monitoring: monitor, health, info, stats
- Deployment: promote, rollback
- Debugging: instrument, trace, profile, logs, test

**Core Modules:**
- `src/packaging/` -- Full agent-to-WASM pipeline (Clawdbot, Goose, Cline, generic parsers, esbuild, ic-wasm optimization)
- `src/deployment/` -- ICPClient (@dfinity/agent SDK), deployer, promotion/rollback with history tracking
- `src/icp/` -- ic-wasm wrapper (optimize/shrink/instrument/metadata), icp-cli wrapper (50+ operations), environment config, tool detection
- `src/monitoring/` -- Health checks, alerting, canister info/stats
- `src/wallet/` -- Full multi-chain (ckETH, Polkadot, Solana): CBOR serializer, BIP39/44 key derivation, 3 providers, cross-chain aggregator, chain dispatcher, transaction queue, VetKeys adapter, canister wallet sync
- `src/security/` -- VetKeysClient (Shamir's Secret Sharing), encryption/decryption
- `src/canister/` -- Actor IDL bindings, encryption helpers, canister types
- `src/debugging/` -- Log aggregation, types for traces/profiles
- `src/testing/` -- Local test runner (unit, integration, load test)
- `src/network/` -- Network configuration management

**Canister (Motoko):**
- `canister/agent.mo` -- 600+ lines, 14-function interface declared in Candid. Wallet registry, transaction queue, VetKeys mock endpoints. Agent state methods (`agent_*`) declared but NOT implemented.

**Existing Dependencies (relevant to Phase 4):**
- `@dfinity/agent` ^3.4.3, `@dfinity/candid` ^3.4.3, `@dfinity/principal` ^3.4.3
- `commander` ^12.1.0, `chalk` ^5.4.1, `ora` ^8.1.0, `execa` ^8.0.0
- `yaml` ^2.8.2, `esbuild` ^0.24.0, `cbor-x` ^1.6.0
- `ethers` ^6.16.0, `@polkadot/api` ^16.5.4, `@solana/web3.js` ^1.98.4

### Critical Gaps This Phase Must Address

1. **No web interface** -- Everything is CLI-only. No visual dashboard, no browser-based management.
2. **No archival layer** -- Agent state exists only on ICP. No long-term, immutable archival backup.
3. **No external inference integration** -- Agents cannot call heavyweight AI models (LLMs, vision, etc.).
4. **No batched canister operations** -- All operations are serial one-at-a-time calls.
5. **No multi-sig security** -- Single identity controls all operations; no approval workflows.
6. **No unified metrics/observability** -- Monitoring exists per-canister but no aggregated dashboard or time-series metrics.
7. **No agent backup export/import** -- `wallet-export`/`wallet-import` exists but no full agent state backup.
8. **Deploy/fetch/exec stubs** -- The `icpClient.ts` deploy/execute methods return simulated results. The canister `agent_*` methods are declared but not implemented. This is a prerequisite debt that Phase 4 must either resolve or explicitly work around.

---

## Phase 4 Goals

### 4.1 Next.js dApp (Weeks 11-12)
Build a complete web interface for managing agents, viewing canister status, browsing logs, and configuring agents -- all backed by the existing `src/` modules via API routes.

### 4.2 Archival & External Inference (Week 12)
Integrate Arweave for immutable agent state archival and Bittensor for heavy inference capabilities that exceed ICP compute limits.

### 4.3 Performance & Security (Week 13)
Implement batched canister operations, multi-sig approval workflows, aggregated metrics, and full agent backup/restore.

---

## Detailed Implementation Tasks

---

### Week 11: Next.js dApp Foundation

#### Task 1.1: Project Scaffolding

**Directory to Create:**
```
webapp/
  src/
    app/
      layout.tsx
      page.tsx
      globals.css
      api/
        agents/route.ts
        agents/[id]/route.ts
        agents/[id]/status/route.ts
        agents/[id]/logs/route.ts
        agents/[id]/tasks/route.ts
        agents/[id]/config/route.ts
        canisters/route.ts
        canisters/[id]/route.ts
        canisters/[id]/health/route.ts
        canisters/[id]/metrics/route.ts
        networks/route.ts
        wallets/route.ts
        deployments/route.ts
        deployments/promote/route.ts
        backups/route.ts
        backups/export/route.ts
        backups/import/route.ts
    components/
      layout/
        Header.tsx
        Sidebar.tsx
        Footer.tsx
      dashboard/
        CanisterStatusCard.tsx
        MetricsChart.tsx
        AlertsFeed.tsx
        NetworkStatusBadge.tsx
      agents/
        AgentList.tsx
        AgentDetail.tsx
        AgentConfigForm.tsx
        AgentDeployDialog.tsx
      tasks/
        TaskQueueTable.tsx
        TaskDetail.tsx
        TaskStatusBadge.tsx
      logs/
        LogViewer.tsx
        LogFilterBar.tsx
        LogEntry.tsx
      wallets/
        WalletOverview.tsx
        WalletBalanceCard.tsx
        TransactionHistory.tsx
      common/
        StatusBadge.tsx
        LoadingSpinner.tsx
        ErrorBoundary.tsx
        DataTable.tsx
        TimeAgo.tsx
    hooks/
      useCanisterStatus.ts
      useAgentList.ts
      useLogs.ts
      useMetrics.ts
      useWallets.ts
      useDeployments.ts
    lib/
      api-client.ts
      icp-connection.ts
      types.ts
      utils.ts
    providers/
      ICPProvider.tsx
      ThemeProvider.tsx
  public/
    favicon.ico
  package.json
  tsconfig.json
  next.config.ts
  tailwind.config.ts
  postcss.config.js
```

**New Dependencies (webapp/package.json):**
```json
{
  "dependencies": {
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@dfinity/agent": "^3.4.3",
    "@dfinity/candid": "^3.4.3",
    "@dfinity/principal": "^3.4.3",
    "recharts": "^2.10.0",
    "date-fns": "^3.0.0",
    "lucide-react": "^0.300.0",
    "clsx": "^2.1.0",
    "tailwind-merge": "^2.2.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tailwindcss": "^3.4.0",
    "postcss": "^8.4.0",
    "autoprefixer": "^10.4.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0"
  }
}
```

**Implementation Details:**
- Standalone Next.js app in `webapp/` directory (separate from the CLI `package.json`)
- API routes import directly from `../src/` modules, reusing all existing logic
- Tailwind CSS for styling, no heavy component library
- `recharts` for metrics visualization (lightweight, React-native)
- `lucide-react` for icons (tree-shakeable)
- `@dfinity/agent` for direct browser-to-canister calls where needed

#### Task 1.2: API Routes (Backend)

**Files to Create:**
- `webapp/src/app/api/agents/route.ts`
- `webapp/src/app/api/agents/[id]/route.ts`
- `webapp/src/app/api/agents/[id]/status/route.ts`
- `webapp/src/app/api/agents/[id]/logs/route.ts`
- `webapp/src/app/api/agents/[id]/tasks/route.ts`
- `webapp/src/app/api/agents/[id]/config/route.ts`
- `webapp/src/app/api/canisters/route.ts`
- `webapp/src/app/api/canisters/[id]/route.ts`
- `webapp/src/app/api/canisters/[id]/health/route.ts`
- `webapp/src/app/api/canisters/[id]/metrics/route.ts`
- `webapp/src/app/api/networks/route.ts`
- `webapp/src/app/api/wallets/route.ts`
- `webapp/src/app/api/deployments/route.ts`
- `webapp/src/app/api/deployments/promote/route.ts`
- `webapp/src/app/api/backups/route.ts`
- `webapp/src/app/api/backups/export/route.ts`
- `webapp/src/app/api/backups/import/route.ts`

**Route Specifications:**

```
GET    /api/agents                  List all agents (wraps listAgents from config-persistence)
GET    /api/agents/:id              Get agent details (wraps readAgentConfig)
GET    /api/agents/:id/status       Get agent canister status (wraps canisterStatus from icpcli)
GET    /api/agents/:id/logs         Get agent logs (wraps getLogs from debugging/logs)
GET    /api/agents/:id/tasks        Get task queue (wraps callAgentMethod('get_pending_tasks'))
PUT    /api/agents/:id/config       Update agent config (wraps writeAgentConfig)

GET    /api/canisters               List canisters (wraps canisterList from icpcli)
GET    /api/canisters/:id           Get canister details (wraps canisterStatus from icpcli)
GET    /api/canisters/:id/health    Get canister health (wraps checkHealth from monitoring/health)
GET    /api/canisters/:id/metrics   Get canister metrics (time-series from new metrics module)

GET    /api/networks                List networks (wraps listNetworkConfigs from network-config)
GET    /api/wallets                 List wallets (wraps listWallets from wallet-storage)

GET    /api/deployments             List deployment history (wraps loadDeploymentHistory from promotion)
POST   /api/deployments/promote     Promote (wraps promoteCanister from promotion)

POST   /api/backups/export          Export agent backup (new backup module)
POST   /api/backups/import          Import agent backup (new backup module)
```

**Key Design Decisions:**
- All API routes are thin wrappers around existing `src/` functions -- no business logic duplication
- API routes use Node.js runtime (not Edge) since they need filesystem access (`~/.agentvault/`)
- JSON responses follow `{ success: boolean, data?: T, error?: string }` envelope
- No authentication in v1 (local-only). Auth noted as future work.

#### Task 1.3: Canister Status Dashboard

**Files to Create:**
- `webapp/src/app/page.tsx` (dashboard home)
- `webapp/src/app/canisters/page.tsx` (canister list)
- `webapp/src/app/canisters/[id]/page.tsx` (canister detail)
- `webapp/src/components/dashboard/CanisterStatusCard.tsx`
- `webapp/src/components/dashboard/MetricsChart.tsx`
- `webapp/src/components/dashboard/AlertsFeed.tsx`
- `webapp/src/components/dashboard/NetworkStatusBadge.tsx`
- `webapp/src/hooks/useCanisterStatus.ts`
- `webapp/src/hooks/useMetrics.ts`

**Dashboard Features:**
- Grid of `CanisterStatusCard` components showing: canister ID, status (running/stopped/error), cycles balance, memory usage, last activity timestamp
- Color-coded health indicators (green/yellow/red) using existing `CanisterHealthStatus` from monitoring
- `MetricsChart` using recharts: time-series for cycles burn rate, memory growth, request count over last 1h/24h/7d
- `AlertsFeed` showing recent alerts from `getRecentAlerts()` with severity coloring
- `NetworkStatusBadge` showing local/IC network connectivity status
- Auto-refresh every 30 seconds via `useCanisterStatus` hook with `setInterval`
- Responsive grid layout: 1 column mobile, 2 columns tablet, 3-4 columns desktop

**Data Flow:**
```
Browser → GET /api/canisters → canisterList() from icpcli → JSON response
Browser → GET /api/canisters/:id/health → checkHealth() from monitoring → JSON response
Browser → GET /api/canisters/:id/metrics → metricsCollector.getTimeSeries() → JSON response
```

#### Task 1.4: Task Queue Viewer

**Files to Create:**
- `webapp/src/app/agents/[id]/tasks/page.tsx`
- `webapp/src/components/tasks/TaskQueueTable.tsx`
- `webapp/src/components/tasks/TaskDetail.tsx`
- `webapp/src/components/tasks/TaskStatusBadge.tsx`

**Task Queue Features:**
- Table view of pending, in-progress, completed, and failed tasks
- Columns: Task ID, Type, Status, Priority, Created, Started, Duration, Error
- Click-to-expand task detail (arguments, result, error trace)
- Status badges: pending (gray), in-progress (blue), completed (green), failed (red)
- Filter by status, sort by priority/created date
- Manual retry button for failed tasks (calls `callAgentMethod('retry_task', taskId)`)

**Data Source:**
- Tasks come from the canister's task queue via `callAgentMethod('get_pending_tasks')`, `callAgentMethod('get_task_history')`
- Polling every 10 seconds when the page is active
- Falls back to mock data if canister agent methods are not yet implemented (uses `TransactionQueueProcessor` data shape as reference)

#### Task 1.5: Execution Log Browser

**Files to Create:**
- `webapp/src/app/agents/[id]/logs/page.tsx`
- `webapp/src/components/logs/LogViewer.tsx`
- `webapp/src/components/logs/LogFilterBar.tsx`
- `webapp/src/components/logs/LogEntry.tsx`

**Log Browser Features:**
- Scrollable log viewer with virtual scrolling for large log sets
- Color-coded by level: info (blue), warning (yellow), error (red), debug (gray)
- Filter bar: level dropdown, text search, date range picker, method filter
- Live tail mode (auto-scroll to bottom, poll every 2 seconds)
- Export button (downloads JSON or CSV via `/api/agents/:id/logs?export=true&format=json`)
- Timestamp display in local timezone with relative time ("2m ago")

**Data Source:**
- `getLogs()` from `src/debugging/logs.ts` via `/api/agents/:id/logs`
- Query params: `?level=error&since=2026-02-01&pattern=timeout&limit=500`

#### Task 1.6: Agent Configuration UI

**Files to Create:**
- `webapp/src/app/agents/page.tsx` (agent list)
- `webapp/src/app/agents/[id]/page.tsx` (agent detail)
- `webapp/src/app/agents/[id]/config/page.tsx` (config editor)
- `webapp/src/components/agents/AgentList.tsx`
- `webapp/src/components/agents/AgentDetail.tsx`
- `webapp/src/components/agents/AgentConfigForm.tsx`
- `webapp/src/components/agents/AgentDeployDialog.tsx`

**Configuration UI Features:**
- Agent list with search, filter by type (clawdbot/goose/cline/generic)
- Agent detail page: config summary, linked canister, environment, deployment history timeline
- Config editor form with fields for:
  - Agent name, type, description
  - Source path
  - Environment selection (local, dev, staging, production)
  - Optimization settings (level, shrink, remove debug)
  - Cycles allocation (initial, min, auto-topup)
  - Identity selection
- Deploy dialog: select environment, confirm cycles, deploy button with progress indicator
- Config changes saved via `PUT /api/agents/:id/config` which calls `writeAgentConfig()`

---

### Week 12: Archival, Inference & Metrics

#### Task 2.1: Arweave Archival Integration

**Files to Create:**
- `src/archival/types.ts`
- `src/archival/arweave-client.ts`
- `src/archival/archival-manager.ts`
- `cli/commands/archive.ts`
- `webapp/src/app/api/archives/route.ts`
- `webapp/src/app/api/archives/[id]/route.ts`

**New Dependencies (root package.json):**
```json
{
  "arweave": "^1.15.0"
}
```

**Type Definitions (`src/archival/types.ts`):**
```typescript
export interface ArchivalConfig {
  /** Arweave gateway URL */
  gateway: string;
  /** Arweave wallet JWK path */
  walletPath: string;
  /** Auto-archive on deploy */
  autoArchive: boolean;
  /** Archive retention tags */
  tags: Record<string, string>;
}

export interface ArchiveEntry {
  /** Arweave transaction ID */
  txId: string;
  /** Agent name */
  agentName: string;
  /** Canister ID */
  canisterId: string;
  /** WASM hash */
  wasmHash: string;
  /** State hash (if state was archived) */
  stateHash?: string;
  /** Archive timestamp */
  timestamp: Date;
  /** Environment */
  environment: string;
  /** Archive size in bytes */
  sizeBytes: number;
  /** Confirmation status */
  status: 'pending' | 'confirmed' | 'failed';
  /** Number of confirmations */
  confirmations: number;
}

export interface ArchiveOptions {
  /** Include WASM binary */
  includeWasm: boolean;
  /** Include agent state */
  includeState: boolean;
  /** Include agent config */
  includeConfig: boolean;
  /** Custom tags */
  tags?: Record<string, string>;
}

export interface ArchiveManifest {
  /** Manifest version */
  version: number;
  /** Agent name */
  agentName: string;
  /** Creation timestamp */
  created: Date;
  /** Arweave transaction IDs for each component */
  components: {
    wasm?: string;
    state?: string;
    config?: string;
    metadata?: string;
  };
  /** Checksums for verification */
  checksums: Record<string, string>;
}
```

**ArweaveClient Functions (`src/archival/arweave-client.ts`):**
```typescript
createArweaveClient(config: ArchivalConfig): ArweaveClient
uploadData(data: Buffer, tags: Record<string, string>): Promise<string>  // returns txId
downloadData(txId: string): Promise<Buffer>
getTransactionStatus(txId: string): Promise<{ status: string; confirmations: number }>
getTransactionsByTag(tagName: string, tagValue: string): Promise<string[]>
estimateCost(sizeBytes: number): Promise<{ winston: string; ar: string }>
```

**ArchivalManager Functions (`src/archival/archival-manager.ts`):**
```typescript
archiveAgent(agentName: string, options: ArchiveOptions): Promise<ArchiveEntry>
restoreFromArchive(txId: string, outputDir: string): Promise<void>
listArchives(agentName?: string): Promise<ArchiveEntry[]>
getArchiveManifest(txId: string): Promise<ArchiveManifest>
verifyArchive(txId: string): Promise<{ valid: boolean; errors: string[] }>
pruneLocalArchiveIndex(): Promise<void>
```

**CLI Commands (`cli/commands/archive.ts`):**
```
agentvault archive <agent-name>                         # Archive agent to Arweave
agentvault archive <agent-name> --include-state          # Include agent state
agentvault archive restore <tx-id> --output <dir>        # Restore from archive
agentvault archive list [agent-name]                     # List archives
agentvault archive verify <tx-id>                         # Verify archive integrity
agentvault archive cost <agent-name>                      # Estimate archival cost
```

**Storage:**
- Archive index stored in `~/.agentvault/archives/index.yaml`
- Individual archive metadata in `~/.agentvault/archives/<agent-name>/`

**Archival Flow:**
```
1. Read agent config from ~/.agentvault/agents/<name>.json
2. Read WASM from configured path
3. Optionally fetch agent state from canister
4. Bundle components into archive manifest
5. Upload each component to Arweave with tags:
   - App-Name: AgentVault
   - Agent-Name: <name>
   - Content-Type: application/wasm | application/json
   - Version: <deployment-version>
   - Environment: <env>
6. Upload manifest pointing to component txIds
7. Store archive entry in local index
8. Return manifest txId as the archive identifier
```

#### Task 2.2: Bittensor Inference Integration

**Files to Create:**
- `src/inference/types.ts`
- `src/inference/bittensor-client.ts`
- `src/inference/inference-manager.ts`
- `cli/commands/inference.ts`
- `webapp/src/app/api/inference/route.ts`

**Type Definitions (`src/inference/types.ts`):**
```typescript
export type InferenceProvider = 'bittensor' | 'custom';

export interface InferenceConfig {
  /** Provider type */
  provider: InferenceProvider;
  /** Bittensor API endpoint */
  endpoint: string;
  /** API key */
  apiKey: string;
  /** Default subnet UID */
  defaultSubnet: number;
  /** Request timeout in milliseconds */
  timeout: number;
  /** Max retries */
  maxRetries: number;
}

export interface InferenceRequest {
  /** Request ID (generated) */
  id: string;
  /** Subnet UID to target */
  subnet: number;
  /** Prompt or input data */
  input: string;
  /** Model hint (optional) */
  model?: string;
  /** Temperature (0-1) */
  temperature?: number;
  /** Max output tokens */
  maxTokens?: number;
  /** Requesting agent name */
  agentName: string;
  /** Requesting canister ID */
  canisterId?: string;
}

export interface InferenceResponse {
  /** Request ID */
  requestId: string;
  /** Response text */
  output: string;
  /** Miner UID that served the response */
  minerUid: number;
  /** Miner hotkey */
  minerHotkey: string;
  /** Response latency in milliseconds */
  latencyMs: number;
  /** Token usage */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Cost in TAO (if applicable) */
  cost?: string;
}

export interface InferenceHistory {
  /** Agent name */
  agentName: string;
  /** Total requests */
  totalRequests: number;
  /** Total tokens used */
  totalTokens: number;
  /** Average latency */
  avgLatencyMs: number;
  /** Recent requests */
  recentRequests: InferenceRequest[];
}
```

**BittensorClient Functions (`src/inference/bittensor-client.ts`):**
```typescript
createBittensorClient(config: InferenceConfig): BittensorClient
query(request: InferenceRequest): Promise<InferenceResponse>
queryStream(request: InferenceRequest): AsyncIterable<string>
getSubnetInfo(subnetUid: number): Promise<SubnetInfo>
getMinerStats(subnetUid: number): Promise<MinerStats[]>
estimateCost(promptTokens: number, subnet: number): Promise<string>
healthCheck(): Promise<{ connected: boolean; latencyMs: number }>
```

**InferenceManager Functions (`src/inference/inference-manager.ts`):**
```typescript
initInference(config: InferenceConfig): InferenceManager
runInference(agentName: string, prompt: string, options?: Partial<InferenceRequest>): Promise<InferenceResponse>
runInferenceStream(agentName: string, prompt: string, options?: Partial<InferenceRequest>): AsyncIterable<string>
getInferenceHistory(agentName: string): InferenceHistory
clearInferenceHistory(agentName: string): void
```

**CLI Commands (`cli/commands/inference.ts`):**
```
agentvault inference query <agent-name> --prompt "..."   # Run inference query
agentvault inference query <agent-name> --stream          # Stream response
agentvault inference history <agent-name>                  # View inference history
agentvault inference config                                # Show/set inference config
agentvault inference cost --prompt "..." --subnet 1       # Estimate cost
agentvault inference health                                # Check Bittensor connectivity
```

**Integration with Agent Canister:**
- The canister can queue inference requests via the transaction queue
- `TransactionQueueProcessor` processes inference requests alongside wallet transactions
- Results are stored back in canister stable memory via `callAgentMethod('store_inference_result', result)`
- The dApp shows inference history in the agent detail page

**Storage:**
- Inference config in `~/.agentvault/inference.yaml`
- Inference history in `~/.agentvault/inference/<agent-name>/`

#### Task 2.3: Aggregated Metrics System

**Files to Create:**
- `src/metrics/types.ts`
- `src/metrics/collector.ts`
- `src/metrics/store.ts`
- `src/metrics/aggregator.ts`

**Type Definitions (`src/metrics/types.ts`):**
```typescript
export type MetricName =
  | 'cycles_balance'
  | 'memory_usage'
  | 'request_count'
  | 'error_count'
  | 'response_time_avg'
  | 'cycles_burn_rate'
  | 'stable_memory_usage'
  | 'heap_memory_usage';

export interface MetricDataPoint {
  /** Metric name */
  name: MetricName;
  /** Value */
  value: number;
  /** Timestamp */
  timestamp: Date;
  /** Canister ID */
  canisterId: string;
  /** Optional labels */
  labels?: Record<string, string>;
}

export interface MetricTimeSeries {
  /** Metric name */
  name: MetricName;
  /** Canister ID */
  canisterId: string;
  /** Data points */
  points: Array<{ timestamp: Date; value: number }>;
  /** Aggregation interval */
  interval: '1m' | '5m' | '1h' | '1d';
}

export interface MetricsSummary {
  /** Canister ID */
  canisterId: string;
  /** Current values */
  current: Record<MetricName, number>;
  /** 1-hour deltas */
  delta1h: Record<MetricName, number>;
  /** 24-hour deltas */
  delta24h: Record<MetricName, number>;
  /** Alerts triggered */
  alerts: number;
}

export interface MetricsCollectorConfig {
  /** Collection interval in seconds */
  intervalSeconds: number;
  /** Retention period in days */
  retentionDays: number;
  /** Metrics to collect */
  enabledMetrics: MetricName[];
  /** Canister IDs to monitor */
  canisterIds: string[];
}
```

**MetricsCollector Functions (`src/metrics/collector.ts`):**
```typescript
createCollector(config: MetricsCollectorConfig): MetricsCollector
startCollection(): void
stopCollection(): void
collectOnce(canisterId: string): Promise<MetricDataPoint[]>
isCollecting(): boolean
```

**MetricsStore Functions (`src/metrics/store.ts`):**
```typescript
storeMetrics(points: MetricDataPoint[]): void
getTimeSeries(canisterId: string, metric: MetricName, from: Date, to: Date, interval: string): MetricTimeSeries
getSummary(canisterId: string): MetricsSummary
pruneOldData(retentionDays: number): void
```

**MetricsAggregator Functions (`src/metrics/aggregator.ts`):**
```typescript
aggregateAcrossCanisters(canisterIds: string[], metric: MetricName): MetricTimeSeries
getFleetSummary(canisterIds: string[]): MetricsSummary[]
detectAnomalies(canisterId: string, metric: MetricName, windowMinutes: number): Anomaly[]
```

**Storage:**
- Metrics stored in `~/.agentvault/metrics/<canister-id>/` as append-only JSONL files
- One file per day: `2026-02-09.jsonl`
- Auto-pruned based on retention config

---

### Week 13: Performance, Security & Backup

#### Task 3.1: Batched Canister Operations

**Files to Create:**
- `src/icp/batch.ts`
- `src/icp/batch-types.ts`

**Type Definitions (`src/icp/batch-types.ts`):**
```typescript
export interface BatchOperation {
  /** Operation ID (auto-generated) */
  id: string;
  /** Operation type */
  type: 'call' | 'query' | 'status' | 'deploy';
  /** Target canister ID */
  canisterId: string;
  /** Method name (for call/query) */
  method?: string;
  /** Arguments (Candid format) */
  args?: string;
  /** Dependencies (operation IDs that must complete first) */
  dependsOn?: string[];
}

export interface BatchResult {
  /** Operation ID */
  operationId: string;
  /** Whether this operation succeeded */
  success: boolean;
  /** Result data (if success) */
  data?: unknown;
  /** Error message (if failure) */
  error?: string;
  /** Execution duration in milliseconds */
  durationMs: number;
}

export interface BatchExecutionResult {
  /** Total operations */
  total: number;
  /** Successful operations */
  succeeded: number;
  /** Failed operations */
  failed: number;
  /** Individual results */
  results: BatchResult[];
  /** Total execution time */
  totalDurationMs: number;
}

export interface BatchConfig {
  /** Maximum concurrent operations */
  maxConcurrency: number;
  /** Timeout per operation in milliseconds */
  operationTimeoutMs: number;
  /** Whether to stop on first failure */
  stopOnFailure: boolean;
  /** Retry failed operations */
  retryCount: number;
  /** Retry delay in milliseconds */
  retryDelayMs: number;
}
```

**BatchExecutor Functions (`src/icp/batch.ts`):**
```typescript
createBatchExecutor(config?: Partial<BatchConfig>): BatchExecutor
addOperation(op: BatchOperation): void
addOperations(ops: BatchOperation[]): void
execute(): Promise<BatchExecutionResult>
executeDryRun(): { order: string[]; parallelGroups: string[][] }
```

**Implementation Details:**
- Topological sort of operations by `dependsOn` graph
- Parallel execution within dependency-free groups using `Promise.allSettled`
- Default concurrency: 10 operations
- Exponential backoff retry: 1s, 2s, 4s
- Used by the dApp for bulk status checks, multi-canister deploys, fleet-wide queries
- CLI integration: `agentvault batch <operations-file.yaml>` (future, document now)

**Integration Points:**
- Dashboard uses batched queries to fetch status for all canisters in one call
- Promote command can batch-deploy to multiple target canisters
- Metrics collector uses batch queries for efficient periodic collection

#### Task 3.2: Multi-Sig Approval Workflows

**Files to Create:**
- `src/security/multisig.ts`
- `src/security/multisig-types.ts`
- `src/security/approval-store.ts`
- `cli/commands/approve.ts`
- `webapp/src/app/api/approvals/route.ts`
- `webapp/src/app/approvals/page.tsx`

**Type Definitions (`src/security/multisig-types.ts`):**
```typescript
export interface MultisigConfig {
  /** Required number of approvals */
  threshold: number;
  /** List of authorized signers (principal IDs) */
  signers: string[];
  /** Operations requiring multi-sig */
  protectedOperations: ProtectedOperation[];
  /** Approval timeout in hours */
  timeoutHours: number;
}

export type ProtectedOperation =
  | 'deploy_production'
  | 'promote_to_production'
  | 'rollback_production'
  | 'delete_canister'
  | 'transfer_cycles'
  | 'change_config'
  | 'export_backup';

export interface ApprovalRequest {
  /** Request ID */
  id: string;
  /** Operation being requested */
  operation: ProtectedOperation;
  /** Requester principal */
  requester: string;
  /** Operation parameters */
  params: Record<string, unknown>;
  /** Description */
  description: string;
  /** Creation timestamp */
  created: Date;
  /** Expiration timestamp */
  expires: Date;
  /** Current status */
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';
  /** Approvals received */
  approvals: Approval[];
  /** Rejections received */
  rejections: Rejection[];
}

export interface Approval {
  /** Signer principal */
  signer: string;
  /** Approval timestamp */
  timestamp: Date;
  /** Optional comment */
  comment?: string;
}

export interface Rejection {
  /** Signer principal */
  signer: string;
  /** Rejection timestamp */
  timestamp: Date;
  /** Reason for rejection */
  reason: string;
}
```

**MultisigManager Functions (`src/security/multisig.ts`):**
```typescript
initMultisig(config: MultisigConfig): MultisigManager
requestApproval(operation: ProtectedOperation, params: Record<string, unknown>, description: string): Promise<ApprovalRequest>
approve(requestId: string, signerPrincipal: string, comment?: string): Promise<ApprovalRequest>
reject(requestId: string, signerPrincipal: string, reason: string): Promise<ApprovalRequest>
executeIfApproved(requestId: string): Promise<{ executed: boolean; result?: unknown; error?: string }>
listPendingApprovals(): ApprovalRequest[]
getApproval(requestId: string): ApprovalRequest | null
expireOldRequests(): number
isProtected(operation: ProtectedOperation): boolean
```

**ApprovalStore Functions (`src/security/approval-store.ts`):**
```typescript
saveApproval(request: ApprovalRequest): void
loadApproval(requestId: string): ApprovalRequest | null
loadPendingApprovals(): ApprovalRequest[]
loadAllApprovals(): ApprovalRequest[]
deleteApproval(requestId: string): void
```

**CLI Commands (`cli/commands/approve.ts`):**
```
agentvault approve list                                    # List pending approvals
agentvault approve show <request-id>                       # Show approval details
agentvault approve sign <request-id>                       # Approve a request
agentvault approve reject <request-id> --reason "..."      # Reject a request
agentvault approve config                                  # Show/edit multisig config
agentvault approve config --threshold 2 --add-signer <principal>
```

**Storage:**
- Multisig config in `~/.agentvault/multisig.yaml`
- Approval requests in `~/.agentvault/approvals/`

**Integration Flow:**
```
1. User runs: agentvault deploy <wasm> --env production
2. CLI checks if 'deploy_production' is a protected operation
3. If protected: creates ApprovalRequest, prints request ID, exits
4. Other signers run: agentvault approve sign <request-id>
5. When threshold is met, any signer can run: agentvault approve execute <request-id>
6. The actual deploy executes
```

**dApp Integration:**
- Approvals page shows pending requests with approve/reject buttons
- Badge in sidebar shows count of pending approvals
- Toast notifications on approval status changes

#### Task 3.3: Agent Backup Export/Import

**Files to Create:**
- `src/backup/types.ts`
- `src/backup/exporter.ts`
- `src/backup/importer.ts`
- `cli/commands/backup.ts`

**Type Definitions (`src/backup/types.ts`):**
```typescript
export interface BackupManifest {
  /** Manifest version */
  version: number;
  /** Creation timestamp */
  created: Date;
  /** Agent name */
  agentName: string;
  /** Components included */
  components: {
    config: boolean;
    wasm: boolean;
    state: boolean;
    wallets: boolean;
    deploymentHistory: boolean;
    logs: boolean;
  };
  /** Checksums */
  checksums: Record<string, string>;
  /** Source environment */
  environment: string;
  /** Original canister ID */
  canisterId?: string;
}

export interface BackupOptions {
  /** Agent name */
  agentName: string;
  /** Output file path */
  outputPath: string;
  /** Include WASM binary */
  includeWasm?: boolean;
  /** Include agent state from canister */
  includeState?: boolean;
  /** Include wallet data (encrypted) */
  includeWallets?: boolean;
  /** Include deployment history */
  includeHistory?: boolean;
  /** Include logs */
  includeLogs?: boolean;
  /** Encryption password (for wallet data) */
  encryptionPassword?: string;
}

export interface ImportOptions {
  /** Backup file path */
  inputPath: string;
  /** Target agent name (defaults to original) */
  targetAgentName?: string;
  /** Target environment */
  targetEnvironment?: string;
  /** Overwrite existing config */
  overwrite?: boolean;
  /** Decryption password (for wallet data) */
  decryptionPassword?: string;
}

export interface BackupResult {
  /** Whether backup succeeded */
  success: boolean;
  /** Output file path */
  outputPath: string;
  /** Backup size in bytes */
  sizeBytes: number;
  /** Components included */
  components: string[];
  /** Manifest */
  manifest: BackupManifest;
}

export interface ImportResult {
  /** Whether import succeeded */
  success: boolean;
  /** Agent name created/updated */
  agentName: string;
  /** Components imported */
  components: string[];
  /** Warnings */
  warnings: string[];
}
```

**Exporter Functions (`src/backup/exporter.ts`):**
```typescript
exportBackup(options: BackupOptions): Promise<BackupResult>
createBackupBundle(agentName: string, components: Map<string, Buffer>): Buffer  // tar.gz
generateManifest(agentName: string, components: string[]): BackupManifest
calculateChecksums(components: Map<string, Buffer>): Record<string, string>
```

**Importer Functions (`src/backup/importer.ts`):**
```typescript
importBackup(options: ImportOptions): Promise<ImportResult>
extractBackupBundle(data: Buffer): Map<string, Buffer>
validateManifest(manifest: BackupManifest): { valid: boolean; errors: string[] }
previewBackup(inputPath: string): BackupManifest
```

**CLI Commands (`cli/commands/backup.ts`):**
```
agentvault backup export <agent-name> --output backup.tar.gz     # Export agent backup
agentvault backup export <agent-name> --include-state            # Include canister state
agentvault backup export <agent-name> --include-wallets          # Include wallets (prompts for password)
agentvault backup import <file>                                   # Import from backup
agentvault backup import <file> --target-name <name>             # Import with new name
agentvault backup preview <file>                                  # Preview backup contents
```

**Backup Format:**
- tar.gz bundle containing:
  - `manifest.json` -- BackupManifest
  - `config.json` -- Agent configuration
  - `agent.wasm` -- WASM binary (optional)
  - `state.json` -- Agent state (optional)
  - `wallets.enc` -- Encrypted wallet data (optional, AES-256-GCM)
  - `history.yaml` -- Deployment history (optional)
  - `logs/` -- Log files (optional)

---

## Updated Environment Configuration

**File to Update:** `src/icp/environment.ts`

Extend `IcpEnvironmentConfig` to include Phase 4 settings:

```typescript
export interface IcpEnvironmentConfig {
  // Existing fields...
  name: string;
  network: string | IcpEnvNetworkConfig;
  cycles?: IcpCyclesConfig;
  optimization?: IcpOptimizationConfig;
  identity?: string;

  // Phase 4 additions
  /** Canister IDs deployed in this environment */
  canisters?: Record<string, string>;
  /** Archival configuration */
  archival?: {
    enabled: boolean;
    autoArchiveOnDeploy: boolean;
    gateway?: string;
  };
  /** Inference configuration */
  inference?: {
    enabled: boolean;
    provider: 'bittensor' | 'custom';
    subnet?: number;
    endpoint?: string;
  };
  /** Multi-sig configuration for this environment */
  multisig?: {
    enabled: boolean;
    threshold: number;
    signers: string[];
  };
  /** Metrics collection configuration */
  metrics?: {
    enabled: boolean;
    intervalSeconds: number;
    retentionDays: number;
  };
}
```

**Example `icp.yaml` with Phase 4 features:**
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
    identity: dev-wallet
    canisters:
      agent1: rrkah-fqaaa-aaaaa-aaaaq-cai
    metrics:
      enabled: true
      intervalSeconds: 60
      retentionDays: 7

  staging:
    network:
      type: ic
    identity: staging-wallet
    archival:
      enabled: true
      autoArchiveOnDeploy: true
    inference:
      enabled: true
      provider: bittensor
      subnet: 1
    multisig:
      enabled: true
      threshold: 2
      signers:
        - "aaaaa-aa"
        - "bbbbb-bb"

  production:
    network:
      type: ic
    identity: prod-wallet
    archival:
      enabled: true
      autoArchiveOnDeploy: true
    multisig:
      enabled: true
      threshold: 3
      signers:
        - "aaaaa-aa"
        - "bbbbb-bb"
        - "ccccc-cc"
    metrics:
      enabled: true
      intervalSeconds: 30
      retentionDays: 90
```

---

## File Structure Summary

### New Directories
```
webapp/                          # Next.js dApp (standalone)
  src/app/                       # App router pages & API routes
  src/components/                # React components
  src/hooks/                     # Custom React hooks
  src/lib/                       # Utilities & API client
  src/providers/                 # React context providers

src/archival/                    # Arweave archival integration
  types.ts
  arweave-client.ts
  archival-manager.ts

src/inference/                   # Bittensor inference integration
  types.ts
  bittensor-client.ts
  inference-manager.ts

src/metrics/                     # Aggregated metrics system
  types.ts
  collector.ts
  store.ts
  aggregator.ts

src/backup/                      # Agent backup export/import
  types.ts
  exporter.ts
  importer.ts

src/icp/                         # Extended
  batch.ts                       # Batched canister operations
  batch-types.ts

src/security/                    # Extended
  multisig.ts                    # Multi-sig approval logic
  multisig-types.ts
  approval-store.ts

cli/commands/                    # New commands
  archive.ts
  inference.ts
  approve.ts
  backup.ts
```

### New CLI Commands (4 new top-level)
```
agentvault archive    <agent-name>                     # Arweave archival
agentvault inference  query <agent-name> --prompt "..."  # Bittensor inference
agentvault approve    list | sign | reject | config     # Multi-sig approvals
agentvault backup     export | import | preview         # Agent backup
```

---

## Dependencies to Add

### Root package.json (CLI + core modules)
```json
{
  "arweave": "^1.15.0"
}
```

### webapp/package.json (new)
```json
{
  "next": "^15.0.0",
  "react": "^19.0.0",
  "react-dom": "^19.0.0",
  "@dfinity/agent": "^3.4.3",
  "@dfinity/candid": "^3.4.3",
  "@dfinity/principal": "^3.4.3",
  "recharts": "^2.10.0",
  "date-fns": "^3.0.0",
  "lucide-react": "^0.300.0",
  "clsx": "^2.1.0",
  "tailwind-merge": "^2.2.0"
}
```

Note: No Bittensor SDK dependency needed -- the integration uses the Bittensor REST API (validator endpoints) via `fetch()`. No additional library required.

---

## Implementation Priorities

### High Priority (Must Have)
1. **Next.js dApp scaffolding & API routes** -- Foundation for all web features
2. **Canister status dashboard** -- Primary value of the web interface
3. **Batched canister operations** -- Performance prerequisite for dashboard
4. **Agent backup export/import** -- Data safety, user-requested
5. **Aggregated metrics** -- Required by dashboard charts

### Medium Priority (Should Have)
6. **Log browser** -- Debugging value
7. **Task queue viewer** -- Agent management value
8. **Agent config UI** -- Deploy/manage from browser
9. **Arweave archival** -- Long-term data preservation
10. **Multi-sig approvals** -- Production safety

### Low Priority (Nice to Have)
11. **Bittensor inference** -- Advanced feature, depends on external service availability
12. **dApp auth** -- Local-only in v1, auth is future work
13. **Real-time WebSocket updates** -- Polling is sufficient for v1

---

## Testing Strategy

### Unit Tests
- Each new `src/` module: archival, inference, metrics, backup, batch, multisig
- Mock external services (Arweave, Bittensor API)
- Test batch executor DAG ordering and concurrency
- Test multi-sig threshold logic and expiration

### Integration Tests
- API routes return correct response shapes
- Backup export → import round-trip preserves data
- Metrics collector stores and retrieves time-series correctly
- Batch executor handles mixed success/failure operations

### E2E Tests
- dApp loads and renders dashboard with mock data
- Export backup from CLI, import from dApp (or vice versa)
- Multi-sig: request → approve → execute flow across two identities

---

## Known Constraints & Decisions

1. **dApp is local-only in v1.** No authentication, no deployment to IC as a frontend canister. This keeps the scope manageable. Deploying the dApp to IC hosting is Phase 5+ work.

2. **Arweave requires a funded wallet.** The `archive` command will fail without a funded Arweave JWK wallet. The CLI should provide clear error messages and cost estimation before any upload.

3. **Bittensor integration uses REST API, not the Python SDK.** This avoids a Python dependency. API availability depends on validator uptime. The integration should gracefully degrade if the endpoint is unreachable.

4. **Backup format is tar.gz, not a custom binary format.** This ensures backups are inspectable and portable. Wallet data within the backup is encrypted separately with AES-256-GCM.

5. **Multi-sig is local/file-based in v1, not on-chain.** Approvals are stored in `~/.agentvault/approvals/`. On-chain multi-sig (canister-level) is future work. This is still useful for team workflows where multiple developers share a machine or sync approval files.

6. **Metrics are stored as flat JSONL files, not a time-series database.** This keeps dependencies minimal. If performance becomes an issue with large datasets, a future phase can add SQLite or a proper TSDB.

7. **The webapp imports from `../src/` directly.** This means the webapp and core modules share the same Node.js runtime. The webapp is not a standalone deployable -- it runs alongside the CLI in development. Production deployment (hosting the dApp separately) is future work.

---

## Success Criteria

Phase 4 is complete when:

- [ ] `npm run dev` in `webapp/` launches a Next.js dApp at localhost:3000
- [ ] Dashboard displays real canister status with health indicators and charts
- [ ] Task queue viewer shows pending/completed tasks from canister
- [ ] Log browser displays filtered, color-coded logs with export capability
- [ ] Agent config UI allows viewing and editing agent configurations
- [ ] `agentvault archive <agent>` uploads agent data to Arweave and returns a txId
- [ ] `agentvault archive restore <txId>` reconstructs agent from Arweave data
- [ ] `agentvault inference query <agent> --prompt "..."` returns a response from Bittensor
- [ ] Batched canister operations execute 10+ queries in parallel with correct dependency ordering
- [ ] `agentvault approve` workflow gates production deploys behind multi-sig
- [ ] `agentvault backup export <agent>` creates a portable tar.gz backup
- [ ] `agentvault backup import <file>` restores an agent from backup
- [ ] Metrics dashboard shows time-series charts for cycles, memory, request rate
- [ ] All new modules have unit tests passing
- [ ] No new TypeScript errors introduced in Phase 4 modules
