'use client'

import { useState } from 'react'
import { CheckCircle2, Clock, XCircle, Filter } from 'lucide-react'
import { StatusBadge } from '@/components/common/StatusBadge'
import { TimeAgo } from '@/components/common/TimeAgo'
import { useTasks } from '@/hooks/useTasks'
import { DataTable } from '@/components/common/DataTable'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import type { Column } from '@/components/common/DataTable'
import type { Task } from '@/lib/types'

const columns: Column<Task>[] = [
  {
    key: 'type',
    label: 'Type',
    render: (value) => (
      <span className="capitalize">{String(value)}</span>
    ),
  },
  {
    key: 'status',
    label: 'Status',
    render: (value, row) => (
      <div className="flex items-center gap-2">
        {row.status === 'running' && <Clock className="w-4 h-4 text-blue-500" />}
        {row.status === 'completed' && <CheckCircle2 className="w-4 h-4 text-green-500" />}
        {row.status === 'failed' && <XCircle className="w-4 h-4 text-red-500" />}
        {row.status === 'pending' && <Clock className="w-4 h-4 text-yellow-500" />}
        <StatusBadge status={row.status} />
      </div>
    ),
  },
  {
    key: 'progress',
    label: 'Progress',
    render: (value, row) => (
      <div className="w-full">
        <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all"
            style={{ width: `${row.progress}%` }}
          />
        </div>
        <span className="text-xs text-gray-600">{row.progress}%</span>
      </div>
    ),
  },
  {
    key: 'message',
    label: 'Message',
    render: (value) => (
      <span className="text-sm text-gray-600">{String(value)}</span>
    ),
  },
  {
    key: 'createdAt',
    label: 'Started',
    render: (value) => (
      <TimeAgo timestamp={String(value)} />
    ),
  },
]

export default function TasksPage() {
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const { tasks, isLoading, error } = useTasks({ status: statusFilter })

  const filteredTasks = statusFilter === 'all'
    ? tasks
    : tasks.filter((task) => task.status === statusFilter)

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Task Queue</h1>
        <p className="text-muted-foreground">
          Monitor background tasks and operations
        </p>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Filter className="w-5 h-5 text-gray-500" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-4 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center min-h-[400px]">
          <LoadingSpinner size="lg" />
        </div>
      ) : error ? (
        <div className="flex items-center justify-center min-h-[400px]">
          <p className="text-red-500">{error.message}</p>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={filteredTasks}
          emptyMessage="No tasks found"
        />
      )}
    </div>
  )
}
