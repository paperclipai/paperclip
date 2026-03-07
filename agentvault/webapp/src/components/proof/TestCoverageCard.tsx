'use client'

import { GitCommit, CheckCircle2, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CoverageReport } from '@/lib/types'

interface TestCoverageCardProps {
  coverage: CoverageReport
}

function CoverageBar({ label, value, threshold }: { label: string; value: number; threshold: number }) {
  const passes = value >= threshold
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn('font-mono font-semibold', passes ? 'text-emerald-400' : 'text-red-400')}>
          {value}%
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-700',
            passes ? 'bg-emerald-400' : 'bg-red-400'
          )}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  )
}

export function TestCoverageCard({ coverage }: TestCoverageCardProps) {
  const { overall, lines, branches, functions, statements, threshold, passesThreshold, commitHash, fileCount, generatedAt } = coverage

  return (
    <div className="retro-surface rounded-xl p-5 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
            Test Coverage
          </h3>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              className={cn(
                'text-4xl font-bold tabular-nums',
                passesThreshold ? 'text-emerald-400' : 'text-red-400'
              )}
            >
              {overall}%
            </span>
            <span className="text-muted-foreground text-sm">/ {threshold}% required</span>
          </div>
        </div>
        {passesThreshold ? (
          <CheckCircle2 className="w-8 h-8 text-emerald-400 shrink-0" />
        ) : (
          <XCircle className="w-8 h-8 text-red-400 shrink-0" />
        )}
      </div>

      <div className="space-y-2.5">
        <CoverageBar label="Lines" value={lines} threshold={threshold} />
        <CoverageBar label="Branches" value={branches} threshold={threshold} />
        <CoverageBar label="Functions" value={functions} threshold={threshold} />
        <CoverageBar label="Statements" value={statements} threshold={threshold} />
      </div>

      <div className="pt-2 border-t border-white/10 space-y-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <GitCommit className="w-3.5 h-3.5" />
          <span className="font-mono">{commitHash.slice(0, 12)}</span>
          <span className="opacity-50">·</span>
          <span>{fileCount} files</span>
        </div>
        <p className="text-xs text-muted-foreground/60">
          Generated {new Date(generatedAt).toLocaleString()}
        </p>
      </div>
    </div>
  )
}
