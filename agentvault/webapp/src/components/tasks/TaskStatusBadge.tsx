'use client'

interface TaskStatusBadgeProps {
  status: 'pending' | 'running' | 'completed' | 'failed'
  className?: string
  showDot?: boolean
}

export function TaskStatusBadge({ status, className, showDot = true }: TaskStatusBadgeProps) {
  const getStatusIcon = () => {
    switch (status) {
      case 'pending':
        return <Clock className="w-4 h-4 text-yellow-500" />
      case 'running':
        return null
      case 'completed':
        return <CheckCircle2 className="w-4 h-4 text-green-500" />
      case 'failed':
        return <XCircle className="w-4 h-4 text-red-500" />
    }
  }

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full ${className}`}>
      {showDot && getStatusIcon()}
      <span className="capitalize">{status}</span>
    </span>
  )
}
