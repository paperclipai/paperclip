import { cn, getStatusBgColor } from '@/lib/utils'

interface StatusBadgeProps {
  status: string
  className?: string
  showDot?: boolean
}

export function StatusBadge({ status, className, showDot = true }: StatusBadgeProps) {
  const bgColor = getStatusBgColor(status)

  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium', bgColor, className)}>
      {showDot && <span className="w-1.5 h-1.5 rounded-full bg-current" />}
      <span className="capitalize">{status}</span>
    </span>
  )
}
