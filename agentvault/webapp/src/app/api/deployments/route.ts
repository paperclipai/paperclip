import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { NextResponse } from 'next/server'
import type { DeploymentHistory } from '@/icp/types.js'
import { deployAgent } from '@/deployment/index.js'
import { addDeploymentToHistory, getAllDeployments } from '@/deployment/promotion.js'
import { packageAgent } from '@/packaging/index.js'
import {
  buildAgentModel,
  buildDeploymentModels,
  readAgentConfigRecord,
  resolveAgentSourcePath,
  resolveProjectRoot,
} from '@/lib/server/agent-models'

type DeployMode = 'auto' | 'install' | 'reinstall' | 'upgrade'

interface DeployRequestBody {
  agentId?: string
  sourcePath?: string
  network?: string
  environment?: string
  canisterId?: string
  identity?: string
  cycles?: string | number
  mode?: DeployMode
  projectRoot?: string
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function toCyclesValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value))
  }
  return undefined
}

function toDeployMode(value: unknown): DeployMode | undefined {
  if (value === 'auto' || value === 'install' || value === 'reinstall' || value === 'upgrade') {
    return value
  }
  return undefined
}

function computeWasmHash(wasmPath: string): string {
  const buffer = fs.readFileSync(wasmPath)
  return createHash('sha256').update(buffer).digest('hex')
}

function nextVersion(history: DeploymentHistory[]): number {
  return history.reduce((maxVersion, entry) => {
    const version = Number(entry.version)
    return Number.isFinite(version) ? Math.max(maxVersion, version) : maxVersion
  }, 0) + 1
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const agentId = url.searchParams.get('agentId') ?? url.searchParams.get('agent')
    const status = url.searchParams.get('status')

    if (!agentId) {
      return NextResponse.json({
        success: false,
        error: 'agentId is required',
      }, { status: 400 })
    }

    if (!buildAgentModel(agentId)) {
      return NextResponse.json({
        success: false,
        error: `Agent '${agentId}' not found`,
      }, { status: 404 })
    }

    const deployments = buildDeploymentModels(agentId)
    const filtered = status
      ? deployments.filter((deployment) => deployment.status === status)
      : deployments

    return NextResponse.json({
      success: true,
      data: filtered,
    })
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const startedAt = new Date()

  try {
    const body = (await request.json()) as DeployRequestBody
    const agentId = asString(body.agentId)

    if (!agentId) {
      return NextResponse.json({
        success: false,
        error: 'agentId is required',
      }, { status: 400 })
    }

    const config = readAgentConfigRecord(agentId)
    if (!config) {
      return NextResponse.json({
        success: false,
        error: `Agent '${agentId}' not found`,
      }, { status: 404 })
    }

    const requestedSourcePath = asString(body.sourcePath)
    const sourcePath = resolveAgentSourcePath(agentId, config, requestedSourcePath)
    if (!sourcePath) {
      return NextResponse.json({
        success: false,
        error:
          'Unable to resolve agent source path. Provide sourcePath in the deploy request or set sourcePath/workingDirectory in the agent config.',
      }, { status: 400 })
    }

    const packageResult = await packageAgent({
      sourcePath,
    })

    const network = asString(body.network) ?? 'local'
    const environment = asString(body.environment)
    const canisterId = asString(body.canisterId)
    const identity = asString(body.identity)
    const cycles = toCyclesValue(body.cycles)
    const mode = toDeployMode(body.mode)
    const projectRoot = asString(body.projectRoot) ?? resolveProjectRoot(sourcePath)

    const deployResult = await deployAgent({
      wasmPath: packageResult.wasmPath,
      network,
      canisterId,
      skipConfirmation: true,
      environment,
      identity,
      cycles,
      mode,
      projectRoot,
    })

    const completedAt = new Date()
    const history = getAllDeployments(agentId) as DeploymentHistory[]

    const historyEntry: DeploymentHistory = {
      agentName: agentId,
      environment: environment ?? network,
      canisterId: deployResult.canister.canisterId,
      wasmHash: deployResult.canister.wasmHash ?? computeWasmHash(packageResult.wasmPath),
      timestamp: completedAt,
      version: nextVersion(history),
      success: true,
    }

    addDeploymentToHistory(historyEntry)

    const deployment = {
      id: `${agentId}-${historyEntry.version}-${completedAt.getTime()}`,
      agentId,
      status: 'completed' as const,
      canisterId: historyEntry.canisterId,
      createdAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    }

    return NextResponse.json({
      success: true,
      data: {
        deployment,
        agent: buildAgentModel(agentId),
        warnings: deployResult.warnings,
        deployTool: deployResult.deployTool,
        sourcePath,
        wasmPath: packageResult.wasmPath,
      },
    })
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}
