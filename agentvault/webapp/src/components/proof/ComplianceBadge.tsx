'use client'

import { ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ComplianceScore } from '@/lib/types'

interface ComplianceBadgeProps {
  compliance: ComplianceScore
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function ComplianceBadge({ compliance, size = 'md', className }: ComplianceBadgeProps) {
  const { score, grade, meetsStandard, standardThreshold } = compliance

  const colorClass = meetsStandard
    ? 'text-emerald-400 border-emerald-400/40 bg-emerald-400/10'
    : score >= 60
    ? 'text-yellow-400 border-yellow-400/40 bg-yellow-400/10'
    : 'text-red-400 border-red-400/40 bg-red-400/10'

  const glowClass = meetsStandard
    ? 'shadow-[0_0_18px_rgba(52,211,153,0.35)]'
    : score >= 60
    ? 'shadow-[0_0_18px_rgba(250,204,21,0.30)]'
    : 'shadow-[0_0_18px_rgba(239,68,68,0.30)]'

  const Icon = meetsStandard ? ShieldCheck : score >= 60 ? ShieldAlert : ShieldX

  const sizeClass = {
    sm: 'px-2.5 py-1 text-xs gap-1.5',
    md: 'px-4 py-2 text-sm gap-2',
    lg: 'px-6 py-3 text-base gap-2.5',
  }[size]

  const iconSize = { sm: 'w-3.5 h-3.5', md: 'w-4 h-4', lg: 'w-5 h-5' }[size]

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border font-semibold tracking-wide',
        colorClass,
        glowClass,
        sizeClass,
        className
      )}
    >
      <Icon className={iconSize} />
      <span>{score}%</span>
      <span className="opacity-70">·</span>
      <span>Grade {grade}</span>
      {meetsStandard ? (
        <span className="opacity-70 font-normal">meets CTO {standardThreshold}% rule</span>
      ) : (
        <span className="opacity-70 font-normal">below {standardThreshold}% threshold</span>
      )}
    </span>
  )
}
