import { NextResponse } from 'next/server'
import { writeAgentConfig } from '@/packaging/config-persistence.js'
import {
  buildAgentModel,
  readAgentConfigRecord,
} from '@/lib/server/agent-models'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(
  _request: Request,
  context: RouteContext,
) {
  try {
    const { id } = await context.params
    const agent = buildAgentModel(id)
    
    if (!agent) {
      return NextResponse.json({
        success: false,
        error: `Agent '${id}' not found`,
      }, { status: 404 })
    }

    return NextResponse.json({
      success: true,
      data: agent,
    })
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}

export async function PUT(
  request: Request,
  context: RouteContext,
) {
  try {
    const { id } = await context.params
    const body = await request.json()
    const { config } = body
    
    if (!config) {
      return NextResponse.json({
        success: false,
        error: 'Config is required',
      }, { status: 400 })
    }

    const existingConfig = readAgentConfigRecord(id)
    if (!existingConfig) {
      return NextResponse.json({
        success: false,
        error: `Agent '${id}' not found`,
      }, { status: 404 })
    }

    const mergedConfig = { ...existingConfig, ...config }
    writeAgentConfig(id, mergedConfig)
    const updatedAgent = buildAgentModel(id)

    return NextResponse.json({
      success: true,
      data: updatedAgent ?? mergedConfig,
    })
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}
