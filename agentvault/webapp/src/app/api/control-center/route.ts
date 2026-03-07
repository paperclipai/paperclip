import { NextResponse } from 'next/server'
import type {
  Agent,
  ControlCenterActivity,
  ControlCenterConvoy,
  ControlCenterCrewMember,
  ControlCenterData,
  ControlCenterDog,
  ControlCenterEscalation,
  ControlCenterHook,
  ControlCenterMail,
  ControlCenterMergeItem,
  ControlCenterRig,
  ControlCenterSession,
  ControlCenterWorker,
  ControlCenterWorkItem,
  Deployment,
} from '@/lib/types'
import { cloneControlCenterFallback } from '@/lib/control-center-fallback'
import { listAgentModels, buildDeploymentModels } from '@/lib/server/agent-models'
import { getCanisterStatusSafe } from '@/lib/server/canister-status'
import { listNetworkConfigs } from '@/network/network-config.js'

interface CanisterSnapshot {
  agent: Agent
  status: Awaited<ReturnType<typeof getCanisterStatusSafe>>
}

function relativeTime(input: string): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return 'unknown'
  }

  const diffMs = Date.now() - date.getTime()
  const minutes = Math.max(0, Math.floor(diffMs / 60000))
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  return `${days}d ago`
}

function capitalize(value: string): string {
  if (!value) {
    return value
  }
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}

function buildCrewFromAgents(agents: Agent[], deployments: Deployment[]): ControlCenterCrewMember[] {
  const deploymentByAgent = new Map<string, Deployment>()
  for (const deployment of deployments) {
    if (!deploymentByAgent.has(deployment.agentId)) {
      deploymentByAgent.set(deployment.agentId, deployment)
    }
  }

  return agents.slice(0, 12).map((agent) => {
    const latest = deploymentByAgent.get(agent.id)
    const state: ControlCenterCrewMember['state'] =
      agent.status === 'active'
        ? 'Ready'
        : agent.status === 'deploying'
          ? 'On Patrol'
          : agent.status === 'error'
            ? 'Repairing'
            : 'Offline'

    return {
      name: agent.id,
      rig: agent.name,
      state,
      hook: agent.canisterId ? 'deploy' : '-',
      activity: latest ? `Deployment ${latest.status}` : 'Idle',
      session: agent.status === 'active' ? 'Yes' : 'No',
    }
  })
}

function buildConvoys(deployments: Deployment[]): ControlCenterConvoy[] {
  return deployments.slice(0, 8).map((deployment, index) => {
    const route = deployment.canisterId
      ? `Build Yard -> ${deployment.canisterId.slice(0, 8)}`
      : `Build Yard -> Agent ${deployment.agentId}`

    const status: ControlCenterConvoy['status'] =
      deployment.status === 'failed'
        ? 'Queued'
        : deployment.status === 'completed'
          ? 'Docking'
          : 'En Route'

    return {
      id: `CV-${String(200 + index)}`,
      route,
      cargo: `${deployment.agentId} package`,
      eta: relativeTime(deployment.createdAt),
      status,
    }
  })
}

function buildSessions(crew: ControlCenterCrewMember[]): ControlCenterSession[] {
  return crew
    .filter((member) => member.session === 'Yes')
    .slice(0, 8)
    .map((member, index) => ({
      id: `S-${130 + index}`,
      owner: member.name,
      state: member.state === 'Offline' ? 'Idle' : 'Active',
      lastSeen: member.state === 'Offline' ? '17m ago' : 'now',
    }))
}

function buildWorkers(canisters: CanisterSnapshot[]): ControlCenterWorker[] {
  const running = canisters.filter((entry) => entry.status?.status === 'running').length
  const stopped = canisters.filter((entry) => entry.status?.status === 'stopped').length
  const errors = canisters.filter((entry) => entry.status?.status === 'error').length

  const workers: ControlCenterWorker[] = [
    {
      name: 'packager-1',
      role: 'WASM Build',
      status: running > 0 ? 'Running' : 'Idle',
      uptime: running > 0 ? 'live' : '0m',
    },
    {
      name: 'deployer-7',
      role: 'Canister Ops',
      status: stopped > 0 ? 'Paused' : 'Running',
      uptime: stopped > 0 ? 'holding' : 'live',
    },
    {
      name: 'guardrail-2',
      role: 'Policy Check',
      status: errors > 0 ? 'Running' : 'Idle',
      uptime: errors > 0 ? 'alerting' : 'standby',
    },
  ]

  return workers
}

function buildActivity(deployments: Deployment[]): ControlCenterActivity[] {
  return deployments.slice(0, 10).map((deployment, index) => ({
    id: `a-${index + 1}`,
    message: `${capitalize(deployment.status)} deployment for ${deployment.agentId}`,
    age: relativeTime(deployment.createdAt),
  }))
}

function buildMail(
  networksCount: number,
  activeNetworks: number,
  escalations: ControlCenterEscalation[],
  deployments: Deployment[]
): ControlCenterMail[] {
  const failedDeployments = deployments.filter((deployment) => deployment.status === 'failed').length
  const completedDeployments = deployments.filter((deployment) => deployment.status === 'completed').length

  return [
    {
      id: 'mail-1',
      from: 'Ops',
      subject: `${completedDeployments} deployments completed`,
      age: 'now',
    },
    {
      id: 'mail-2',
      from: 'Network',
      subject: `${activeNetworks}/${networksCount || 1} networks active`,
      age: 'now',
    },
    {
      id: 'mail-3',
      from: 'Watchtower',
      subject: `${failedDeployments} failed deploys · ${escalations.length} escalations`,
      age: 'now',
    },
  ]
}

function buildMergeQueue(deployments: Deployment[]): ControlCenterMergeItem[] {
  const items = deployments.slice(0, 6).map((deployment, index) => ({
    pr: `#${20 - index}`,
    repo: 'AgentVault',
    title: `${deployment.agentId} ${deployment.status} deployment`,
    ci:
      deployment.status === 'completed'
        ? ('Pass' as const)
        : deployment.status === 'failed'
          ? ('Fail' as const)
          : ('Pending' as const),
  }))

  if (items.length > 0) {
    return items
  }

  return [
    {
      pr: '#0',
      repo: 'AgentVault',
      title: 'No active merge items',
      ci: 'Pending',
    },
  ]
}

function buildEscalations(agents: Agent[], canisters: CanisterSnapshot[]): ControlCenterEscalation[] {
  const items: ControlCenterEscalation[] = []

  for (const agent of agents) {
    if (agent.status === 'error') {
      items.push({
        id: `E-${items.length + 1}`,
        severity: 'P1',
        title: `Agent ${agent.id} reported error state`,
        owner: agent.id,
      })
    }
  }

  for (const canister of canisters) {
    if (canister.status?.status === 'stopped') {
      items.push({
        id: `E-${items.length + 1}`,
        severity: 'P2',
        title: `Canister for ${canister.agent.id} is stopped`,
        owner: canister.agent.id,
      })
    }
  }

  return items.slice(0, 8)
}

function buildRigs(agents: Agent[], crew: ControlCenterCrewMember[]): ControlCenterRig[] {
  return agents.slice(0, 8).map((agent) => {
    const crewCount = crew.filter((member) => member.rig === agent.name).length
    return {
      name: agent.name,
      polecats: agent.canisterId ? 1 : 0,
      crew: crewCount,
      agents: agent.canisterId ? '🛰️ 🤖' : '👤',
    }
  })
}

function buildDogs(crew: ControlCenterCrewMember[]): ControlCenterDog[] {
  return crew.slice(0, 8).map((member, index) => ({
    name: `Dog-${index + 1}`,
    handler: member.name,
    status: member.state === 'Offline' ? 'In Kennel' : 'Deployed',
  }))
}

function buildWorkItems(deployments: Deployment[], escalations: ControlCenterEscalation[]): ControlCenterWorkItem[] {
  const deploymentItems = deployments.slice(0, 8).map((deployment, index) => ({
    priority:
      deployment.status === 'failed'
        ? ('P1' as const)
        : deployment.status === 'deploying'
          ? ('P2' as const)
          : ('P3' as const),
    id: `wk-${index + 1}`,
    title: `${deployment.agentId} ${deployment.status} rollout`,
    status:
      deployment.status === 'failed'
        ? ('BLOCKED' as const)
        : deployment.status === 'deploying'
          ? ('IN PROGRESS' as const)
          : ('READY' as const),
    age: relativeTime(deployment.createdAt),
  }))

  const escalationItems = escalations.slice(0, 3).map((item, index) => ({
    priority: item.severity,
    id: `esc-${index + 1}`,
    title: item.title,
    status: item.severity === 'P1' ? ('BLOCKED' as const) : ('IN PROGRESS' as const),
    age: 'now',
  }))

  return [...deploymentItems, ...escalationItems].slice(0, 10)
}

function buildHooks(agents: Agent[], deployments: Deployment[]): ControlCenterHook[] {
  const deployedAgents = agents.filter((agent) => !!agent.canisterId).length
  return [
    {
      name: 'deploy-sync',
      target: `${deployedAgents} deployed agents`,
      status: deployedAgents > 0 ? 'Bound' : 'Muted',
      lastRun: 'now',
    },
    {
      name: 'convoy-watch',
      target: `${deployments.length} recent convoys`,
      status: deployments.length > 0 ? 'Bound' : 'Muted',
      lastRun: 'now',
    },
    {
      name: 'heartbeat-check',
      target: 'Crew heartbeat',
      status: agents.some((agent) => agent.status === 'active') ? 'Bound' : 'Muted',
      lastRun: 'now',
    },
  ]
}

function flattenDeployments(agents: Agent[]): Deployment[] {
  const deployments = agents.flatMap((agent) => buildDeploymentModels(agent.id))
  return deployments.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

export async function GET() {
  try {
    const model = cloneControlCenterFallback()
    const agents = listAgentModels()
    const deployments = flattenDeployments(agents)
    const networks = await listNetworkConfigs().catch(() => [])
    const activeNetworks = networks.filter((network) => network.status === 'running').length

    const canisterSnapshots: CanisterSnapshot[] = await Promise.all(
      agents
        .filter((agent) => !!agent.canisterId)
        .map(async (agent) => ({
          agent,
          status: await getCanisterStatusSafe(agent.canisterId!),
        }))
    )

    if (agents.length === 0) {
      return NextResponse.json({
        success: true,
        data: {
          ...model,
          updatedAt: new Date().toISOString(),
        },
      })
    }

    const crew = buildCrewFromAgents(agents, deployments)
    const convoys = buildConvoys(deployments)
    const sessions = buildSessions(crew)
    const escalations = buildEscalations(agents, canisterSnapshots)
    const workers = buildWorkers(canisterSnapshots)
    const workItems = buildWorkItems(deployments, escalations)
    const hooks = buildHooks(agents, deployments)
    const rigs = buildRigs(agents, crew)
    const dogs = buildDogs(crew)
    const activity = buildActivity(deployments)
    const mergeQueue = buildMergeQueue(deployments)
    const inbox = buildMail(networks.length, activeNetworks, escalations, deployments)
    const p1p2 = workItems.filter((item) => item.priority === 'P1' || item.priority === 'P2').length

    const response: ControlCenterData = {
      ...model,
      mayor: {
        name: process.env.USER || model.mayor.name,
        status: activeNetworks > 0 ? 'Connected' : 'Detached',
      },
      stats: {
        heartbeat: crew.some((member) => member.session === 'Yes'),
        workers: workers.length,
        hooks: hooks.length,
        work: workItems.length,
        convoys: convoys.length,
        escalations: escalations.length,
        p1p2,
        autoRefreshSeconds: model.stats.autoRefreshSeconds,
      },
      convoys: convoys.length > 0 ? convoys : model.convoys,
      crew: crew.length > 0 ? crew : model.crew,
      workers,
      sessions,
      activity: activity.length > 0 ? activity : model.activity,
      inbox,
      mergeQueue,
      escalations,
      rigs,
      dogs,
      workItems,
      hooks,
      updatedAt: new Date().toISOString(),
    }

    return NextResponse.json({
      success: true,
      data: response,
    })
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}
