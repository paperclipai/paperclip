'use client'

import { CheckCircle2, AlertTriangle, Clock, RefreshCw, ArrowLeft, XCircle } from 'lucide-react'
import { Task as TaskType } from '@/lib/types'

interface TaskDetailProps {
  task: {
    id: string
    type: TaskType['type']
    status: 'pending' | 'running' | 'completed' | 'failed'
    progress: number
    message: string
    createdAt: string
    completedAt?: string
    error?: string
  }
  onRetry?: () => void
  isRetrying?: boolean
}

function TimeAgo({ timestamp }: { timestamp: string }) {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffDays > 0) return <span>{diffDays}d ago</span>
  if (diffHours > 0) return <span>{diffHours}h ago</span>
  if (diffMins > 0) return <span>{diffMins}m ago</span>
  return <span>just now</span>
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-700',
    running: 'bg-blue-100 text-blue-700',
    completed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
  }

  return (
    <span className={`px-2 py-1 rounded text-xs font-medium ${colors[status] || colors.pending}`}>
      {status}
    </span>
  )
}

export function TaskDetail({ task, onRetry, isRetrying }: TaskDetailProps) {
  const getStatusIcon = () => {
    switch (task.status) {
      case 'pending':
        return <Clock className="w-6 h-6 text-yellow-500" />
      case 'running':
        return <RefreshCw className="w-6 h-6 text-blue-500 animate-spin" />
      case 'completed':
        return <CheckCircle2 className="w-6 h-6 text-green-500" />
      case 'failed':
        return <XCircle className="w-6 h-6 text-red-500" />
      default:
        return <Clock className="w-6 h-6 text-gray-500" />
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <ArrowLeft className="w-6 h-6 text-gray-500 cursor-pointer hover:text-gray-700" />
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{task.type.charAt(0).toUpperCase() + task.type.slice(1)}</h2>
          <p className="text-sm text-gray-600">{task.id}</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div>
            <h3 className="text-xl font-semibold mb-2">Status</h3>
            <div className="flex items-center gap-2">
              {getStatusIcon()}
              <StatusBadge status={task.status} />
            </div>
          </div>

          <div>
            <h4 className="text-sm font-medium mb-2">Progress</h4>
            <div className="w-full">
              <div className="h-2 bg-gray-200 rounded-full">
                <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${task.progress}%` }} />
              </div>
              <span className="text-sm text-gray-600 mt-1 block">{task.progress}%</span>
            </div>
          </div>

          <div>
            <h4 className="text-sm font-medium mb-2">Message</h4>
            <p className="text-sm">{task.message}</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <h3 className="text-xl font-semibold mb-2">Timing</h3>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-600">Created:</span>
                <TimeAgo timestamp={task.createdAt} />
              </div>
              {task.completedAt && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Completed:</span>
                  <TimeAgo timestamp={task.completedAt} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {task.error && (
        <div className="bg-red-50 border border-red-200 p-4 rounded">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 text-red-500 mt-0.5" />
            <div>
              <p className="font-medium">Error:</p>
              <p className="text-sm">{task.error}</p>
            </div>
          </div>
          {task.status === 'failed' && onRetry && (
            <button
              onClick={onRetry}
              disabled={isRetrying}
              className="flex items-center gap-2 px-4 py-2 mt-4 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {isRetrying ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              {isRetrying ? 'Retrying...' : 'Retry Task'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
