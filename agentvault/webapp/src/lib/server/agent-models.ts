import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Agent, Deployment } from '@/lib/types'
import { getAllDeployments } from '@/deployment/promotion.js'
import { listAgents, readAgentConfig } from '@/packaging/config-persistence.js'
import type { ParsedAgentConfig } from '@/packaging/config-schemas.js'

type AgentConfigRecord = ParsedAgentConfig & Record<string, unknown>

interface DeploymentHistoryLike {
  agentName: string
  environment: string
  canisterId: string
  wasmHash: string
  timestamp: Date | string
  version: number
  success: boolean
}

const DEFAULT_ENTRY_POINT = 'src/index.ts'
const DEFAULT_MEMORY_MB = 256
const DEFAULT_COMPUTE_CLASS = 'medium'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return undefined
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed
    }
  }

  return undefined
}

function toIso(value: unknown): string | undefined {
  const parsed = asDate(value)
  return parsed?.toISOString()
}

function getAgentConfig(agentId: string): AgentConfigRecord | null {
  return readAgentConfig<AgentConfigRecord>(agentId)
}

function getSortedHistory(agentId: string): DeploymentHistoryLike[] {
  const history = getAllDeployments(agentId) as DeploymentHistoryLike[]
  return [...history].sort((a, b) => {
    const aTime = asDate(a.timestamp)?.getTime() ?? 0
    const bTime = asDate(b.timestamp)?.getTime() ?? 0
    return bTime - aTime
  })
}

function deriveAgentStatus(
  hasDeployments: boolean,
  latestSuccess: DeploymentHistoryLike | undefined
): Agent['status'] {
  if (!hasDeployments) {
    return 'inactive'
  }

  return latestSuccess ? 'active' : 'error'
}

export function buildAgentModel(agentId: string): Agent | null {
  const config = getAgentConfig(agentId)
  if (!config) {
    return null
  }

  const history = getSortedHistory(agentId)
  const latest = history[0]
  const latestSuccess = history.find((entry) => entry.success)

  const name = asString(config.name) ?? agentId
  const entry = asString(config.entry) ?? asString(config.entryPoint) ?? DEFAULT_ENTRY_POINT
  const memory = asNumber(config.memory) ?? DEFAULT_MEMORY_MB
  const compute = asString(config.compute) ?? DEFAULT_COMPUTE_CLASS

  const createdAt =
    toIso(config.createdAt) ??
    toIso(config.created) ??
    toIso(latest?.timestamp) ??
    new Date().toISOString()

  const updatedAt =
    toIso(config.updatedAt) ??
    toIso(latest?.timestamp) ??
    createdAt

  return {
    id: agentId,
    name,
    status: deriveAgentStatus(history.length > 0, latestSuccess),
    canisterId: latestSuccess?.canisterId,
    config: {
      entry,
      memory,
      compute,
    },
    createdAt,
    updatedAt,
  }
}

export function listAgentModels(): Agent[] {
  const agentIds = listAgents()
  const models = agentIds
    .map((agentId) => buildAgentModel(agentId))
    .filter((agent): agent is Agent => agent !== null)

  return models.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

export function buildDeploymentModels(agentId: string): Deployment[] {
  const history = getSortedHistory(agentId)

  return history.map((entry, index) => {
    const timestamp = asDate(entry.timestamp) ?? new Date()
    const isoTimestamp = timestamp.toISOString()
    const status: Deployment['status'] = entry.success ? 'completed' : 'failed'

    return {
      id: `${agentId}-${entry.version}-${timestamp.getTime()}-${index}`,
      agentId,
      status,
      canisterId: entry.canisterId,
      createdAt: isoTimestamp,
      completedAt: status === 'completed' ? isoTimestamp : undefined,
      error: status === 'failed' ? 'Deployment failed' : undefined,
    }
  })
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function resolveCandidatePath(value: string): string | null {
  const baseRoots = unique([
    process.cwd(),
    path.resolve(process.cwd(), '..'),
  ])

  const candidates = path.isAbsolute(value)
    ? [value]
    : baseRoots.map((root) => path.resolve(root, value))

  for (const candidate of unique(candidates)) {
    if (!fs.existsSync(candidate)) {
      continue
    }

    if (!fs.statSync(candidate).isDirectory()) {
      continue
    }

    return candidate
  }

  return null
}

function looksLikeAgentSource(sourcePath: string): boolean {
  const markers = [
    'agent.json',
    'agent.yaml',
    'agent.yml',
    'goose.yaml',
    'goose.yml',
    'clawdbot.json',
    'cline.json',
    'cline.config.json',
    'index.ts',
    'index.js',
    'main.ts',
    'main.js',
    'agent.ts',
    'agent.js',
    path.join('src', 'index.ts'),
    path.join('src', 'index.js'),
  ]

  return markers.some((marker) => fs.existsSync(path.join(sourcePath, marker)))
}

export function resolveAgentSourcePath(
  agentId: string,
  config: AgentConfigRecord | null,
  requestedSourcePath?: string
): string | null {
  const configRecord = asRecord(config)

  const configuredSourcePath = asString(configRecord?.sourcePath)
  const configuredWorkingDirectory = asString(configRecord?.workingDirectory)
  const sanitizedWorkingDirectory =
    configuredWorkingDirectory && configuredWorkingDirectory !== '.' && configuredWorkingDirectory !== './'
      ? configuredWorkingDirectory
      : undefined

  const candidates = [
    requestedSourcePath,
    configuredSourcePath,
    sanitizedWorkingDirectory,
    path.join('examples', 'agents', agentId),
    agentId,
  ]
    .map((candidate) => asString(candidate))
    .filter((candidate): candidate is string => !!candidate)

  for (const candidate of candidates) {
    const resolved = resolveCandidatePath(candidate)
    if (!resolved) {
      continue
    }

    if (looksLikeAgentSource(resolved)) {
      return resolved
    }
  }

  return null
}

export function resolveProjectRoot(startPath: string): string {
  let current = path.resolve(startPath)

  while (true) {
    const hasProjectMarkers =
      fs.existsSync(path.join(current, 'icp.yaml')) ||
      fs.existsSync(path.join(current, 'dfx.json'))

    if (hasProjectMarkers) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  const fallbackRoots = [process.cwd(), path.resolve(process.cwd(), '..')]
  for (const root of fallbackRoots) {
    const hasProjectMarkers =
      fs.existsSync(path.join(root, 'icp.yaml')) ||
      fs.existsSync(path.join(root, 'dfx.json'))
    if (hasProjectMarkers) {
      return root
    }
  }

  return process.cwd()
}

export function readAgentConfigRecord(agentId: string): AgentConfigRecord | null {
  return getAgentConfig(agentId)
}
