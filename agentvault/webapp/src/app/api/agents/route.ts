import { NextResponse } from 'next/server'
import { listAgentModels } from '@/lib/server/agent-models'

export async function GET() {
  try {
    const agents = listAgentModels()
    return NextResponse.json({
      success: true,
      data: agents,
    })
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}
