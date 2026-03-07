import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { createMemoryRepoActor, createAnonymousAgent } from '@/canister/memory-repo-actor.js'

const MEMORY_REPO_CANISTER_ID = process.env.MEMORY_REPO_CANISTER_ID

interface CommitRequest {
  branch: string
  message: string
  entries: Array<{
    key: string
    data: string
    tags?: string[]
  }>
}

interface CommitResponse {
  sha: string
  branch: string
  author: string
  timestamp: string
  message: string
  entries: Array<{ key: string }>
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
    const body: CommitRequest = await request.json()
    
    if (!body.branch || !body.message || !Array.isArray(body.entries)) {
      return NextResponse.json(
        { success: false, error: { message: 'Missing required fields: branch, message, entries', code: 'BAD_REQUEST' } },
        { status: 400 }
      )
    }

    const actor = await getActor()
    
    const switchResult = await actor.switchBranch(body.branch)
    if ('err' in switchResult) {
      const createResult = await actor.createBranch(body.branch)
      if ('err' in createResult) {
        return NextResponse.json(
          { success: false, error: { message: `Failed to create branch: ${createResult.err}`, code: 'BRANCH_ERROR' } },
          { status: 400 }
        )
      }
    }
    
    const diff = JSON.stringify(body.entries)
    const tags = body.entries.flatMap(e => e.tags ?? [])
    
    const commitResult = await actor.commit(body.message, diff, tags)
    
    if ('err' in commitResult) {
      return NextResponse.json(
        { success: false, error: { message: `Commit failed: ${commitResult.err}`, code: 'COMMIT_ERROR' } },
        { status: 400 }
      )
    }
    
    const sha = commitResult.ok
    const commits = await actor.log([body.branch])
    const latestCommit = commits.length > 0 ? commits[0] : null
    
    const response: CommitResponse = {
      sha,
      branch: body.branch,
      author: latestCommit?.branch ?? 'unknown',
      timestamp: latestCommit ? new Date(Number(latestCommit.timestamp) / 1_000_000).toISOString() : new Date().toISOString(),
      message: body.message,
      entries: body.entries.map(e => ({ key: e.key })),
    }
    
    return NextResponse.json({ success: true, data: response })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { success: false, error: { message, code: 'INTERNAL_ERROR' } },
      { status: 500 }
    )
  }
}
