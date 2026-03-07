'use client'

import { TrendingUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ComplianceScore } from '@/lib/types'

interface ComplianceScoreCardProps {
  compliance: ComplianceScore
}

function ScoreSegment({
  label,
  value,
  contribution,
  weight,
  color,
}: {
  label: string
  value: number
  contribution: number
  weight: number
  color: string
}) {
  return (
    <div className="flex items-center gap-3">
      <div className={cn('w-2.5 h-2.5 rounded-full shrink-0', color)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between text-xs mb-1">
          <span className="text-muted-foreground truncate">
            {label}
            <span className="ml-1 opacity-50">×{(weight * 100).toFixed(0)}%</span>
          </span>
          <span className="font-mono font-semibold ml-2">{value.toFixed(0)}%</span>
        </div>
        <div className="h-1 w-full rounded-full bg-white/10 overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all duration-700', color.replace('bg-', 'bg-'))}
            style={{ width: `${value}%` }}
          />
        </div>
      </div>
      <span className="text-xs font-mono text-muted-foreground/70 w-7 text-right shrink-0">
        +{contribution}
      </span>
    </div>
  )
}

export function ComplianceScoreCard({ compliance }: ComplianceScoreCardProps) {
  const { score, grade, meetsStandard, standardThreshold, details, coverageWeight, vetKeyWeight, arweaveWeight } = compliance

  const gradeColor = {
    A: 'text-emerald-400',
    B: 'text-cyan-400',
    C: 'text-yellow-400',
    D: 'text-orange-400',
    F: 'text-red-400',
  }[grade]

  const ringColor = meetsStandard
    ? 'stroke-emerald-400'
    : score >= 60
    ? 'stroke-yellow-400'
    : 'stroke-red-400'

  // SVG ring math
  const r = 38
  const circ = 2 * Math.PI * r
  const dash = (score / 100) * circ

  return (
    <div className="retro-surface rounded-xl p-5 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">
            Compliance Score
          </h3>
          <p className="mt-1 text-xs text-muted-foreground/70">
            Weighted composite · CTO standard {standardThreshold}%
          </p>
        </div>
        <TrendingUp className="w-5 h-5 text-muted-foreground" />
      </div>

      {/* Donut + grade */}
      <div className="flex items-center gap-6">
        <div className="relative w-24 h-24 shrink-0">
          <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
            <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="10" />
            <circle
              cx="50"
              cy="50"
              r={r}
              fill="none"
              className={ringColor}
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${circ}`}
              style={{ transition: 'stroke-dasharray 0.8s ease' }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl font-bold tabular-nums">{score}</span>
            <span className="text-xs text-muted-foreground">/ 100</span>
          </div>
        </div>

        <div className="flex-1 space-y-1.5">
          <div className="flex items-baseline gap-2">
            <span className={cn('text-5xl font-black', gradeColor)}>{grade}</span>
            <span className="text-sm text-muted-foreground">
              {meetsStandard ? '✓ Compliant' : '✗ Below threshold'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground/60">
            {meetsStandard
              ? `${score - standardThreshold}% above minimum requirement`
              : `${standardThreshold - score}% below minimum requirement`}
          </p>
        </div>
      </div>

      {/* Score breakdown */}
      <div className="space-y-3 pt-2 border-t border-white/10">
        <p className="text-xs text-muted-foreground/60 uppercase tracking-widest">Breakdown</p>
        <ScoreSegment
          label="Test Coverage"
          value={compliance.details.coverageContribution / coverageWeight}
          contribution={details.coverageContribution}
          weight={coverageWeight}
          color="bg-emerald-400"
        />
        <ScoreSegment
          label="VetKey Signatures"
          value={compliance.details.vetKeyContribution / vetKeyWeight}
          contribution={details.vetKeyContribution}
          weight={vetKeyWeight}
          color="bg-cyan-400"
        />
        <ScoreSegment
          label="Arweave Anchor"
          value={compliance.details.arweaveContribution / arweaveWeight}
          contribution={details.arweaveContribution}
          weight={arweaveWeight}
          color="bg-violet-400"
        />
      </div>
    </div>
  )
}
