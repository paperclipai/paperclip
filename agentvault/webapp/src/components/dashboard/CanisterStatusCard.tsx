'use client'

import { Activity, Cpu, Database, Server, MoreVertical, AlertCircle } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import clsx from 'clsx'

interface CanisterStatusCardProps {
  canisterId: string
  status: 'running' | 'stopped' | 'error'
  cycles: bigint
  memory: bigint
  lastActivity: Date
}

function formatTCycles(cycles: bigint): string {
  const tcycles = Number(cycles) / 1e12
  return `${tcycles.toFixed(2)} TC`
}

export function CanisterStatusCard({
  canisterId,
  status,
  cycles,
  memory,
  lastActivity,
}: CanisterStatusCardProps) {
  const statusColors = {
    running: 'text-green-500',
    stopped: 'text-gray-500',
    error: 'text-red-500',
  }

  const statusBgColors = {
    running: 'bg-green-500/10',
    stopped: 'bg-gray-500/10',
    error: 'bg-red-500/10',
  }

  const statusIcons = {
    running: Server,
    stopped: Database,
    error: AlertCircle,
  }

  const StatusIcon = statusIcons[status]

  const cyclesFormatted = formatTCycles(cycles)
  const memoryMB = Number(memory) / 1024 / 1024

  return (
    <div className="rounded-lg border bg-card p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <p className="font-mono text-sm text-muted-foreground">
              {canisterId.slice(0, 16)}...
            </p>
            <span className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium', statusBgColors[status], statusColors[status])}>
              <StatusIcon className="h-3 w-3" />
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Active {formatDistanceToNow(lastActivity, { addSuffix: true })}
          </p>
        </div>
        <button className="text-muted-foreground hover:text-foreground">
          <MoreVertical className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Cycles Balance</p>
          <p className="text-lg font-semibold">
            {cyclesFormatted}
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Memory Usage</p>
          <p className="text-lg font-semibold">
            {memoryMB.toFixed(2)} MB
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <Activity className="h-4 w-4 text-muted-foreground" />
        <span className="text-muted-foreground">
          Last update: {formatDistanceToNow(lastActivity)}
        </span>
      </div>
    </div>
  )
}
