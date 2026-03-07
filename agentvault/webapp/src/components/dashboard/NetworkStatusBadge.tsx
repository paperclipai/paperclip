'use client'

import { Wifi, WifiOff, Loader2 } from 'lucide-react'
import clsx from 'clsx'

export function NetworkStatusBadge() {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card px-4 py-2">
      <div className="flex items-center gap-2 text-sm">
        <Wifi className="h-4 w-4 text-green-500" />
        <span className="text-muted-foreground">Connected to</span>
        <span className="font-medium">Local</span>
        <div className="flex items-center gap-1 text-xs text-green-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Ping: 12ms</span>
        </div>
      </div>
    </div>
  )
}
