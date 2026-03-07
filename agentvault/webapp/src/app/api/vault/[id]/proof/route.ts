import { NextRequest, NextResponse } from 'next/server'
import type { ProofRecord } from '@/lib/types'

// Deterministic mock data seeded from vaultId so the dashboard looks consistent
function generateProofRecord(vaultId: string): ProofRecord {
  const seed = vaultId.charCodeAt(0) + vaultId.charCodeAt(vaultId.length - 1)
  const coverage = 72 + (seed % 27) // 72-98%
  const threshold = 80
  const vetKeyCount = 3 + (seed % 4)
  const now = new Date()

  const vetKeyChain = Array.from({ length: vetKeyCount }, (_, i) => {
    const actions = [
      'task_orchestrate',
      'code_merge',
      'canister_upgrade',
      'config_change',
      'deployment_approval',
      'secret_rotation',
    ]
    const action = actions[i % actions.length]
    return {
      id: `sig-${vaultId}-${i}`,
      actionId: `act-${i.toString().padStart(4, '0')}`,
      actionType: action,
      actionDescription: `${action.replace(/_/g, ' ')} executed by agent ${vaultId.slice(0, 6)}`,
      publicKey: `04${Array.from({ length: 64 }, (_, k) => ((seed * (i + 1) * (k + 1)) % 16).toString(16)).join('')}`,
      signature: `3045${Array.from({ length: 70 }, (_, k) => ((seed * (i + 3) * (k + 7)) % 16).toString(16)).join('')}`,
      message: JSON.stringify({ actionId: `act-${i.toString().padStart(4, '0')}`, timestamp: now.toISOString() }),
      signerPrincipal: `${vaultId.slice(0, 5)}-${i}aaa-bbbb-cccc-ddddddddd`,
      timestamp: new Date(now.getTime() - (vetKeyCount - i) * 3_600_000).toISOString(),
      verified: true,
    }
  })

  const commitShort = Array.from({ length: 40 }, (_, k) => ((seed * (k + 1)) % 16).toString(16)).join('')

  const arweaveTxId = `${Array.from({ length: 43 }, (_, k) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[(seed * (k + 3)) % 64]).join('')}`

  const coverageScore = coverage
  const vetKeyScore = (vetKeyChain.filter((s) => s.verified).length / vetKeyChain.length) * 100
  const arweaveScore = 100
  const score = Math.round(0.5 * coverageScore + 0.3 * vetKeyScore + 0.2 * arweaveScore)

  const grade =
    score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F'

  return {
    id: `proof-${vaultId}`,
    vaultId,
    agentId: `agent-${vaultId}`,
    agentName: `Vault Agent #${vaultId.slice(0, 6)}`,
    taskId: `task-${vaultId}`,
    taskDescription: 'Orchestrate multi-step deployment with compliance gating',
    commitHash: commitShort,
    coverage: {
      overall: coverage,
      lines: coverage + 1,
      branches: coverage - 3,
      functions: coverage + 2,
      statements: coverage,
      threshold,
      passesThreshold: coverage >= threshold,
      generatedAt: new Date(now.getTime() - 7_200_000).toISOString(),
      commitHash: commitShort,
      fileCount: 42 + (seed % 20),
    },
    vetKeyChain,
    arweaveAnchor: {
      txId: arweaveTxId,
      permalink: `https://arweave.net/${arweaveTxId}`,
      blockHeight: 1_200_000 + seed * 137,
      blockHash: `${Array.from({ length: 64 }, (_, k) => ((seed * (k + 11)) % 16).toString(16)).join('')}`,
      timestamp: new Date(now.getTime() - 3_600_000).toISOString(),
      dataSize: 1024 + seed * 512,
      contentHash: `sha256-${Array.from({ length: 64 }, (_, k) => ((seed * (k + 5)) % 16).toString(16)).join('')}`,
      status: 'confirmed',
    },
    compliance: {
      score,
      grade,
      coverageWeight: 0.5,
      vetKeyWeight: 0.3,
      arweaveWeight: 0.2,
      details: {
        coverageContribution: Math.round(0.5 * coverageScore),
        vetKeyContribution: Math.round(0.3 * vetKeyScore),
        arweaveContribution: Math.round(0.2 * arweaveScore),
      },
      meetsStandard: score >= 80,
      standardThreshold: 80,
    },
    createdAt: new Date(now.getTime() - 7_200_000).toISOString(),
    updatedAt: now.toISOString(),
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const proof = generateProofRecord(params.id)
    return NextResponse.json({ success: true, data: proof })
  } catch (_error) {
    return NextResponse.json(
      { success: false, error: { message: 'Failed to fetch proof record' } },
      { status: 500 }
    )
  }
}
