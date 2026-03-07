import { NextResponse } from 'next/server'
import { getCanisterStatusSafe } from '@/lib/server/canister-status'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(
  _request: Request,
  context: RouteContext,
) {
  try {
    const { id } = await context.params
    const parsed = await getCanisterStatusSafe(id)
    const now = new Date().toISOString()

    if (!parsed) {
      return NextResponse.json({
        success: false,
        error: `Canister '${id}' not reachable`,
      }, { status: 404 })
    }

    return NextResponse.json({
      success: true,
      data: {
        id,
        name: id,
        status: parsed.status,
        cycles: parsed.cycles,
        memory: parsed.memory,
        controller: parsed.controller,
        createdAt: now,
        updatedAt: now,
      },
    })
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}
