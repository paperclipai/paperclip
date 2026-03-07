import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'
import { createMemoryRepoActor, createAnonymousAgent, type Commit } from '@/canister/memory-repo-actor.js'

const MEMORY_REPO_CANISTER_ID = process.env.MEMORY_REPO_CANISTER_ID

interface MemoryEntry {
  key: string
  contentType: string
  data: string
  tags: string[]
  metadata: Record<string, unknown>
}

interface BranchResponse {
  branch: string
  headSha: string | null
  entries: MemoryEntry[]
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

function parseDiffToEntries(diff: string): MemoryEntry[] {
  const entries: MemoryEntry[] = []
  
  try {
    const parsed = JSON.parse(diff)
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === 'object') {
          entries.push({
            key: item.key ?? '',
            contentType: item.contentType ?? 'application/json',
            data: item.data ?? '',
            tags: Array.isArray(item.tags) ? item.tags : [],
            metadata: item.metadata ?? {},
          })
        }
      }
    }
  } catch {
    // If diff is not JSON, return empty entries
  }
  
  return entries
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ branch: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  const { branch } = await params

  try {
    const actor = await getActor()
    
    const switchResult = await actor.switchBranch(branch)
    if ('err' in switchResult) {
      return NextResponse.json(
        { success: false, error: { message: switchResult.err, code: 'BRANCH_NOT_FOUND' } },
        { status: 404 }
      )
    }
    
    const commits = await actor.log([branch])
    const headSha = commits.length > 0 ? commits[0]?.id ?? null : null
    
    let entries: MemoryEntry[] = []
    if (commits.length > 0) {
      const latestCommit = commits[0]
      if (latestCommit) {
        entries = parseDiffToEntries(latestCommit.diff)
      }
    }
    
    const response: BranchResponse = {
      branch,
      headSha,
      entries,
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
