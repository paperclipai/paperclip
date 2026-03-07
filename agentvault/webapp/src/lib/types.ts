// ── Verification / Proof types ──────────────────────────────────────────────

export interface VetKeySignature {
  id: string
  actionId: string
  actionType: string
  actionDescription: string
  publicKey: string
  signature: string
  message: string
  signerPrincipal: string
  timestamp: string
  verified: boolean | null   // null = pending verification
}

export interface ArweaveAnchor {
  txId: string
  permalink: string
  blockHeight: number
  blockHash: string
  timestamp: string
  dataSize: number
  contentHash: string
  status: 'confirmed' | 'pending' | 'failed'
}

export interface CoverageReport {
  overall: number
  lines: number
  branches: number
  functions: number
  statements: number
  threshold: number      // required minimum (e.g. 80)
  passesThreshold: boolean
  generatedAt: string
  commitHash: string
  fileCount: number
}

export interface ComplianceScore {
  score: number          // 0-100
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  coverageWeight: number
  vetKeyWeight: number
  arweaveWeight: number
  details: {
    coverageContribution: number
    vetKeyContribution: number
    arweaveContribution: number
  }
  meetsStandard: boolean
  standardThreshold: number
}

export interface ProofRecord {
  id: string
  vaultId: string
  agentId: string
  agentName: string
  taskId?: string
  taskDescription?: string
  commitHash: string
  coverage: CoverageReport
  vetKeyChain: VetKeySignature[]
  arweaveAnchor?: ArweaveAnchor
  compliance: ComplianceScore
  shareToken?: string
  createdAt: string
  updatedAt: string
}

export interface ShareProofResult {
  shareUrl: string
  shareToken: string
  expiresAt: string
}

// ── End Verification / Proof types ──────────────────────────────────────────

export interface ApiError {
  message: string
  code?: string
  details?: unknown
}

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: ApiError
}

export interface Canister {
  id: string
  name: string
  status: 'running' | 'stopped' | 'stopping' | 'starting' | 'error'
  cycles: bigint | number
  memory: bigint | number
  controller: string
  createdAt: string
  updatedAt: string
}

export interface Agent {
  id: string
  name: string
  status: 'active' | 'inactive' | 'deploying' | 'error'
  canisterId?: string
  config: AgentConfig
  metrics?: AgentMetrics
  createdAt: string
  updatedAt: string
}

export interface AgentConfig {
  entry: string
  memory: number
  compute: string
  cycles?: bigint | number
  routing?: string[]
}

export interface AgentMetrics {
  requests: number
  errors: number
  avgLatency: number
  uptime: number
}

export interface Wallet {
  id: string
  principal: string
  balance: bigint | number
  type: 'local' | 'hardware'
  address?: string
  status?: 'connected' | 'disconnected'
  createdAt: string
}

export interface Deployment {
  id: string
  agentId: string
  status: 'pending' | 'deploying' | 'completed' | 'failed'
  canisterId?: string
  createdAt: string
  completedAt?: string
  error?: string
}

export interface Backup {
  id: string
  canisterId: string
  timestamp: string
  size: bigint | number
  checksum: string
  location: string
}

export interface Network {
  name: string
  status: 'connected' | 'disconnected' | 'degraded'
  url: string
  nodeCount: number
}

export interface LogEntry {
  id: string
  timestamp: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  source: string
  canisterId?: string
}

export interface Task {
  id: string
  type: 'deploy' | 'backup' | 'restore' | 'upgrade'
  status: 'pending' | 'running' | 'completed' | 'failed'
  progress: number
  message: string
  createdAt: string
  completedAt?: string
  error?: string
}

export interface Transaction {
  id: string
  type: 'send' | 'receive'
  amount: bigint | number
  from?: string
  to?: string
  timestamp: string
  status?: 'pending' | 'confirmed' | 'failed'
}

export interface Archive {
  id: string
  status: 'prepared' | 'uploading' | 'completed' | 'failed'
  canisterId: string
  timestamp: string
  size: bigint | number
  checksum?: string
  arweaveTxId?: string
  cost?: bigint | number
}

export interface InferenceQuery {
  subnet: string
  module: string
  input: unknown
  cached?: boolean
  latency?: number
  timestamp?: string
}

export interface ApprovalRequest {
  id: string
  type: 'deploy' | 'upgrade' | 'transfer' | 'config'
  target: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  creator: string
  createdAt: string
  expiresAt: string
  signatures: string[]
  requiredSignatures: number
  description?: string
}

export interface ChartDataPoint {
  label: string
  value: number
  timestamp?: string
}

export interface PageParams {
  page?: number
  limit?: number
  sort?: string
  filter?: Record<string, string>
}

export interface ControlCenterConvoy {
  id: string
  route: string
  cargo: string
  eta: string
  status: 'Queued' | 'En Route' | 'Docking'
}

export interface ControlCenterCrewMember {
  name: string
  rig: string
  state: 'Ready' | 'On Patrol' | 'Repairing' | 'Offline'
  hook: string
  activity: string
  session: 'Yes' | 'No'
}

export interface ControlCenterWorker {
  name: string
  role: string
  status: 'Idle' | 'Running' | 'Paused'
  uptime: string
}

export interface ControlCenterSession {
  id: string
  owner: string
  state: 'Active' | 'Idle'
  lastSeen: string
}

export interface ControlCenterActivity {
  id: string
  message: string
  age: string
}

export interface ControlCenterMail {
  id: string
  from: string
  subject: string
  age: string
}

export interface ControlCenterMergeItem {
  pr: string
  repo: string
  title: string
  ci: 'Pass' | 'Fail' | 'Pending'
}

export interface ControlCenterEscalation {
  id: string
  severity: 'P1' | 'P2' | 'P3'
  title: string
  owner: string
}

export interface ControlCenterRig {
  name: string
  polecats: number
  crew: number
  agents: string
}

export interface ControlCenterDog {
  name: string
  handler: string
  status: 'In Kennel' | 'Deployed'
}

export interface ControlCenterWorkItem {
  priority: 'P1' | 'P2' | 'P3'
  id: string
  title: string
  status: 'READY' | 'IN PROGRESS' | 'BLOCKED'
  age: string
}

export interface ControlCenterHook {
  name: string
  target: string
  status: 'Bound' | 'Muted'
  lastRun: string
}

export interface ControlCenterStats {
  heartbeat: boolean
  workers: number
  hooks: number
  work: number
  convoys: number
  escalations: number
  p1p2: number
  autoRefreshSeconds: number
}

export interface ControlCenterData {
  title: string
  mayor: {
    name: string
    status: 'Detached' | 'Connected'
  }
  stats: ControlCenterStats
  convoys: ControlCenterConvoy[]
  crew: ControlCenterCrewMember[]
  workers: ControlCenterWorker[]
  sessions: ControlCenterSession[]
  activity: ControlCenterActivity[]
  inbox: ControlCenterMail[]
  mergeQueue: ControlCenterMergeItem[]
  escalations: ControlCenterEscalation[]
  rigs: ControlCenterRig[]
  dogs: ControlCenterDog[]
  workItems: ControlCenterWorkItem[]
  hooks: ControlCenterHook[]
  updatedAt: string
}
