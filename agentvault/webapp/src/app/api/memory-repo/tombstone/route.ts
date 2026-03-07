import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { createMemoryRepoActor, createAnonymousAgent } from '@/canister/memory-repo-actor.js'

const MEMORY_REPO_CANISTER_ID = process.env.MEMORY_REPO_CANISTER_ID

interface TombstoneRequest {
  branch: string
  key: string
}

async function getActor() {
  if (!MEMORY_REPO_CANISTER_ID) {
    throw new Error('MEMORY_REPO_CANISTER_ID environment variable is not set')
  }
  
  const host = process.env.ICP_LOCAL_URL || 'https://ic0.app'
  const agent = createAnonymousAgent(host)
  
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    await agent.fetchRootKey()
  }
  
  return createMemoryRepoActor(MEMORY_REPO_CANISTER_ID, agent)
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  try {
    const body: TombstoneRequest = await request.json()
    
    if (!body.branch || !body.key) {
      return NextResponse.json(
        { success: false, error: { message: 'Missing required fields: branch, key', code: 'BAD_REQUEST' } },
        { status: 400 }
      )
    }

    const actor = await getActor()
    
    const switchResult = await actor.switchBranch(body.branch)
    if ('err' in switchResult) {
      return NextResponse.json(
        { success: false, error: { message: `Branch not found: ${body.branch}`, code: 'BRANCH_NOT_FOUND' } },
        { status: 404 }
      )
    }
    
    const diff = JSON.stringify({ deleted: body.key })
    const commitResult = await actor.commit(`tombstone: ${body.key}`, diff, ['tombstone'])
    
    if ('err' in commitResult) {
      return NextResponse.json(
        { success: false, error: { message: `Tombstone commit failed: ${commitResult.err}`, code: 'COMMIT_ERROR' } },
        { status: 400 }
      )
    }
    
    return new NextResponse(null, { status: 204 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { success: false, error: { message, code: 'INTERNAL_ERROR' } },
      { status: 500 }
    )
  }
}
