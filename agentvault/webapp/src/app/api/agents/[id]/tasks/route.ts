import { NextRequest, NextResponse } from 'next/server'

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const tasks = []
    return NextResponse.json({ success: true, data: tasks })
  } catch (_error) {
    return NextResponse.json({ success: false, error: { message: 'Failed to fetch tasks' } }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const body = await request.json()
    return NextResponse.json({ success: true, data: { id: 'task-1', ...body } })
  } catch (_error) {
    return NextResponse.json({ success: false, error: { message: 'Failed to create task' } }, { status: 500 })
  }
}
