'use client'

import { AlertTriangle, CheckCircle2, XCircle, Bell } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

type AlertSeverity = 'critical' | 'warning' | 'info'

interface Alert {
  id: string
  severity: AlertSeverity
  message: string
  canisterId: string
  timestamp: Date
}

export function AlertsFeed() {
  const alerts: Alert[] = [
    {
      id: '1',
      severity: 'critical',
      message: 'Canister xkb7u-4iaaa-aaaaa-qaaca-cai is offline',
      canisterId: 'xkb7u-4iaaa-aaaaa-qaaca-cai',
      timestamp: new Date(Date.now() - 5 * 60 * 1000),
    },
    {
      id: '2',
      severity: 'warning',
      message: 'Low cycles balance on rrkah-fqaaa-aaaaa-aaaaq-cai',
      canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai',
      timestamp: new Date(Date.now() - 30 * 60 * 1000),
    },
    {
      id: '3',
      severity: 'info',
      message: 'Backup completed for agent1',
      canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai',
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000),
    },
  ]

  const severityColors: Record<AlertSeverity, string> = {
    critical: 'text-red-500 bg-red-500/10',
    warning: 'text-yellow-500 bg-yellow-500/10',
    info: 'text-blue-500 bg-blue-500/10',
  }

  const severityIcons: Record<AlertSeverity, any> = {
    critical: XCircle,
    warning: AlertTriangle,
    info: CheckCircle2,
  }

  return (
    <div className="rounded-lg border bg-card p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-semibold">Recent Alerts</h3>
          <p className="text-sm text-muted-foreground">
            {alerts.length} in last 24 hours
          </p>
        </div>
        <button className="flex items-center gap-2 rounded-md border bg-muted px-3 py-1.5 text-sm hover:bg-muted/80">
          <Bell className="h-4 w-4" />
          Configure
        </button>
      </div>

      <div className="space-y-3">
        {alerts.map((alert) => {
          const Icon = severityIcons[alert.severity]
          return (
            <div
              key={alert.id}
              className="flex items-start gap-3 rounded-lg border bg-muted/50 p-4"
            >
              <div className={`mt-0.5 rounded-md p-1.5 ${severityColors[alert.severity]}`}>
                <Icon className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-sm font-medium leading-tight">
                  {alert.message}
                </p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">
                    {alert.canisterId.slice(0, 16)}...
                  </span>
                  <span>•</span>
                  <span>{formatDistanceToNow(alert.timestamp)}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
