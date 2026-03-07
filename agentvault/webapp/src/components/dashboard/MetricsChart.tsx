'use client'

import { Activity, ArrowDownRight, ArrowUpRight, Zap } from 'lucide-react'

export function MetricsChart() {
  return (
    <div className="rounded-lg border bg-card p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-semibold">Metrics Overview</h3>
          <p className="text-sm text-muted-foreground">
            Last 24 hours
          </p>
        </div>
        <select className="rounded-md border bg-background px-3 py-1 text-sm">
          <option>24h</option>
          <option>7d</option>
          <option>30d</option>
        </select>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border bg-muted/50 p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-primary/10 p-2">
              <Zap className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium">Cycles Balance</p>
              <p className="text-xs text-muted-foreground">
                5000000000000 ICP
              </p>
            </div>
          </div>
          <div className="text-right">
            <div className="flex items-center gap-1 text-red-500">
              <ArrowDownRight className="h-4 w-4" />
              <span className="text-sm font-medium">-12.5%</span>
            </div>
            <p className="text-xs text-muted-foreground">
              vs yesterday
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg border bg-muted/50 p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-primary/10 p-2">
              <Activity className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium">Request Rate</p>
              <p className="text-xs text-muted-foreground">
                2,847 req/h
              </p>
            </div>
          </div>
          <div className="text-right">
            <div className="flex items-center gap-1 text-green-500">
              <ArrowUpRight className="h-4 w-4" />
              <span className="text-sm font-medium">+23.4%</span>
            </div>
            <p className="text-xs text-muted-foreground">
              vs yesterday
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg border bg-muted/50 p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-primary/10 p-2">
              <Activity className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium">Error Rate</p>
              <p className="text-xs text-muted-foreground">
                0.34%
              </p>
            </div>
          </div>
          <div className="text-right">
            <div className="flex items-center gap-1 text-green-500">
              <ArrowDownRight className="h-4 w-4" />
              <span className="text-sm font-medium">-2.1%</span>
            </div>
            <p className="text-xs text-muted-foreground">
              vs yesterday
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
