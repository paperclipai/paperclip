'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, RefreshCw, ShieldCheck, Clock } from 'lucide-react'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { ComplianceBadge } from '@/components/proof/ComplianceBadge'
import { ComplianceScoreCard } from '@/components/proof/ComplianceScoreCard'
import { TestCoverageCard } from '@/components/proof/TestCoverageCard'
import { VetKeyChain } from '@/components/proof/VetKeyChain'
import { ArweaveAnchorCard } from '@/components/proof/ArweaveAnchorCard'
import { ShareProofButton } from '@/components/proof/ShareProofButton'
import { useProof } from '@/hooks/useProof'

export default function VaultProofPage({ params }: { params: { id: string } }) {
  const { proof, isLoading, error, lastRefreshed, refetch, shareProof } = useProof(params.id)
  const [pulseRefresh, setPulseRefresh] = useState(false)

  // Flash the refresh icon on each update
  useEffect(() => {
    if (lastRefreshed) {
      setPulseRefresh(true)
      const t = setTimeout(() => setPulseRefresh(false), 800)
      return () => clearTimeout(t)
    }
  }, [lastRefreshed])

  if (isLoading && !proof) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-3">
          <LoadingSpinner size="lg" />
          <p className="text-sm text-muted-foreground">Loading compliance proof…</p>
        </div>
      </div>
    )
  }

  if (error && !proof) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center gap-3">
          <Link href="/agents" className="text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <h1 className="text-2xl font-bold">Proof Not Available</h1>
        </div>
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error.message}
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 print:p-4 print:space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <Link
            href="/agents"
            className="mt-1 text-muted-foreground hover:text-foreground transition-colors print:hidden"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-cyan-400" />
              <h1 className="text-2xl font-bold tracking-tight">Proof of Compliance</h1>
            </div>
            {proof && (
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{proof.agentName}</span>
                {proof.taskDescription && (
                  <> · {proof.taskDescription}</>
                )}
              </p>
            )}
            {proof && (
              <div className="pt-1">
                <ComplianceBadge compliance={proof.compliance} size="sm" />
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 print:hidden">
          {/* Real-time refresh indicator */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground/60">
            <Clock className="w-3.5 h-3.5" />
            {lastRefreshed
              ? `Updated ${lastRefreshed.toLocaleTimeString()}`
              : 'Waiting for first update…'}
          </div>
          <button
            type="button"
            onClick={refetch}
            disabled={isLoading}
            className="p-2 rounded-lg hover:bg-white/10 transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
            title="Refresh proof"
          >
            <RefreshCw
              className={`w-4 h-4 transition-transform ${pulseRefresh ? 'rotate-180' : ''} ${isLoading ? 'animate-spin' : ''}`}
            />
          </button>
          {proof && (
            <ShareProofButton onShare={shareProof} vaultId={params.id} />
          )}
        </div>
      </div>

      {/* Print-only metadata */}
      {proof && (
        <div className="hidden print:block text-xs text-gray-500 border-b pb-3 mb-3">
          <p>Vault ID: {proof.vaultId} · Agent: {proof.agentId}</p>
          <p>Commit: {proof.commitHash.slice(0, 12)} · Generated: {new Date(proof.updatedAt).toLocaleString()}</p>
        </div>
      )}

      {proof && (
        <>
          {/* Top row: Compliance Score + Coverage */}
          <div className="grid gap-5 lg:grid-cols-2">
            <ComplianceScoreCard compliance={proof.compliance} />
            <TestCoverageCard coverage={proof.coverage} />
          </div>

          {/* VetKey Chain */}
          <VetKeyChain signatures={proof.vetKeyChain} />

          {/* Arweave Anchor */}
          {proof.arweaveAnchor ? (
            <ArweaveAnchorCard anchor={proof.arweaveAnchor} />
          ) : (
            <div className="retro-surface rounded-xl p-5">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-widest mb-2">
                Arweave Anchor
              </h3>
              <p className="text-sm text-muted-foreground/60">
                Arweave anchoring is optional — no transaction has been submitted for this vault entry yet.
              </p>
            </div>
          )}

          {/* Proof metadata footer */}
          <div className="retro-surface rounded-xl p-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground/60">
            <span>Vault: <code className="font-mono text-muted-foreground">{proof.vaultId}</code></span>
            <span>Agent: <code className="font-mono text-muted-foreground">{proof.agentId}</code></span>
            {proof.taskId && (
              <span>Task: <code className="font-mono text-muted-foreground">{proof.taskId}</code></span>
            )}
            <span>Commit: <code className="font-mono text-muted-foreground">{proof.commitHash.slice(0, 12)}</code></span>
            <span>
              Proof ID: <code className="font-mono text-muted-foreground">{proof.id}</code>
            </span>
            <span>
              Generated: <span className="text-muted-foreground">{new Date(proof.createdAt).toLocaleString()}</span>
            </span>
          </div>
        </>
      )}
    </div>
  )
}
