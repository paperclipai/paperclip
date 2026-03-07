'use client'

import Link from 'next/link'
import { ShieldCheck, ArrowRight } from 'lucide-react'
import { useAgentList } from '@/hooks/useAgentList'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { StatusBadge } from '@/components/common/StatusBadge'

export default function VaultIndexPage() {
  const { agents, isLoading, error } = useAgentList()

  return (
    <div className="p-6 space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-cyan-400" />
          <h1 className="text-2xl font-bold tracking-tight">Vault Proofs</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Mathematical proof of compliance for every agent — test coverage, VetKey signatures, and Arweave anchors.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center min-h-[200px]">
          <LoadingSpinner size="lg" />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error.message}
        </div>
      ) : agents.length === 0 ? (
        <div className="retro-surface rounded-xl p-8 text-center space-y-2">
          <ShieldCheck className="w-10 h-10 text-muted-foreground/40 mx-auto" />
          <p className="text-muted-foreground">No agents found. Deploy an agent to see its compliance proof.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <Link
              key={agent.id}
              href={`/vault/${agent.id}/proof`}
              className="retro-surface rounded-xl p-5 space-y-3 hover:bg-white/5 transition-all hover:shadow-[0_0_20px_rgba(107,225,255,0.18)] group"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-0.5 min-w-0">
                  <p className="font-semibold truncate">{agent.name}</p>
                  <p className="text-xs font-mono text-muted-foreground/70 truncate">{agent.id}</p>
                </div>
                <StatusBadge status={agent.status} showDot />
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ShieldCheck className="w-3.5 h-3.5 text-cyan-400" />
                  <span>View proof</span>
                </div>
                <ArrowRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-cyan-400 group-hover:translate-x-1 transition-all" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
