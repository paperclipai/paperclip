import type { ControlCenterData } from '@/lib/types'

export const controlCenterFallback: ControlCenterData = {
  title: 'Gas Town Control Center',
  mayor: {
    name: 'The Mayor',
    status: 'Detached',
  },
  stats: {
    heartbeat: false,
    workers: 3,
    hooks: 3,
    work: 3,
    convoys: 2,
    escalations: 2,
    p1p2: 2,
    autoRefreshSeconds: 10,
  },
  convoys: [
    {
      id: 'CV-204',
      route: 'Build Yard -> Central Vault',
      cargo: 'optimized wasm',
      eta: '18m',
      status: 'En Route',
    },
    {
      id: 'CV-199',
      route: 'North Cache -> QA Dock',
      cargo: 'snapshot bundle',
      eta: '42m',
      status: 'Queued',
    },
  ],
  crew: [
    {
      name: 'johnnyclem',
      rig: 'AgentVault',
      state: 'Ready',
      hook: 'mail',
      activity: 'Dispatch review',
      session: 'Yes',
    },
    {
      name: 'atlas-9',
      rig: 'DustRunner',
      state: 'On Patrol',
      hook: 'merge',
      activity: 'Queue triage',
      session: 'Yes',
    },
    {
      name: 'mira-17',
      rig: 'NeonRelay',
      state: 'Repairing',
      hook: '-',
      activity: 'Patch ingress',
      session: 'No',
    },
  ],
  workers: [
    { name: 'packager-1', role: 'WASM Build', status: 'Running', uptime: '3h 14m' },
    { name: 'guardrail-2', role: 'Policy Check', status: 'Idle', uptime: '47m' },
    { name: 'deployer-7', role: 'Canister Ops', status: 'Paused', uptime: '11m' },
  ],
  sessions: [
    { id: 'S-129', owner: 'johnnyclem', state: 'Active', lastSeen: 'now' },
    { id: 'S-122', owner: 'atlas-9', state: 'Idle', lastSeen: '6m ago' },
  ],
  activity: [
    { id: 'a1', message: 'Deploy promoted to staging', age: '4m ago' },
    { id: 'a2', message: 'Backup archived to Arweave', age: '12m ago' },
    { id: 'a3', message: 'Worker guardrail-2 resumed', age: '19m ago' },
  ],
  inbox: [
    { id: 'm1', from: 'Ops', subject: 'Cycles top-up confirmed', age: '2m ago' },
    { id: 'm2', from: 'CI', subject: '2 merge checks failed', age: '8m ago' },
    { id: 'm3', from: 'Watchtower', subject: 'Replica latency recovered', age: '25m ago' },
  ],
  mergeQueue: [
    { pr: '#14', repo: 'AgentVault', title: 'Cloud backup retry policy', ci: 'Fail' },
    { pr: '#13', repo: 'AgentVault', title: 'Canister health lane cleanup', ci: 'Pending' },
    { pr: '#12', repo: 'AgentVault', title: 'Bump esbuild + lock refresh', ci: 'Pass' },
  ],
  escalations: [
    { id: 'E-10', severity: 'P1', title: 'No heartbeat on rig NeonRelay', owner: 'mira-17' },
    { id: 'E-09', severity: 'P2', title: 'Merge queue blocked > 20m', owner: 'atlas-9' },
  ],
  rigs: [
    { name: 'AgentVault', polecats: 2, crew: 3, agents: '👁️ 🌩️' },
    { name: 'DustRunner', polecats: 1, crew: 2, agents: '🛰️ 🧭' },
    { name: 'NeonRelay', polecats: 1, crew: 2, agents: '🛠️ 🔦' },
  ],
  dogs: [
    { name: 'Bolt', handler: 'johnnyclem', status: 'Deployed' },
    { name: 'Trace', handler: 'atlas-9', status: 'In Kennel' },
  ],
  workItems: [
    { priority: 'P2', id: 'hq-cv-4hftk', title: 'Tracking air-buds', status: 'READY', age: '3h ago' },
    { priority: 'P1', id: 'sync-22m9', title: 'Restore missing heartbeats', status: 'IN PROGRESS', age: '21m ago' },
    { priority: 'P3', id: 'ux-11f0', title: 'Tune dashboard labels', status: 'BLOCKED', age: '1d ago' },
  ],
  hooks: [
    { name: 'merge-watch', target: 'Merge Queue', status: 'Bound', lastRun: '2m ago' },
    { name: 'mail-drain', target: 'Inbox', status: 'Bound', lastRun: '7m ago' },
    { name: 'convoy-ping', target: 'Convoys', status: 'Muted', lastRun: '15m ago' },
  ],
  updatedAt: new Date(0).toISOString(),
}

export function cloneControlCenterFallback(): ControlCenterData {
  return JSON.parse(JSON.stringify(controlCenterFallback)) as ControlCenterData
}
