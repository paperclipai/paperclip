import { CheckCircle2, Clock, XCircle, RefreshCw } from 'lucide-react'

export interface Task {
  id: string
  type: 'deploy' | 'backup' | 'restore' | 'upgrade'
  status: 'pending' | 'running' | 'completed' | 'failed'
  progress: number
  message: string
  createdAt: string
  completedAt?: string
  error?: string
}

interface TaskQueueTableProps {
  tasks: Task[]
  emptyMessage?: string
  isLoading?: boolean
}

function TimeAgo({ timestamp }: { timestamp: string }) {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffDays > 0) return <span className="text-xs text-gray-500">{diffDays}d ago</span>
  if (diffHours > 0) return <span className="text-xs text-gray-500">{diffHours}h ago</span>
  if (diffMins > 0) return <span className="text-xs text-gray-500">{diffMins}m ago</span>
  return <span className="text-xs text-gray-500">just now</span>
}

export function TaskQueueTable({ tasks, emptyMessage = 'No tasks found', isLoading = false }: TaskQueueTableProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-8 h-8 text-gray-400 animate-spin" />
      </div>
    )
  }

  if (tasks.length === 0) {
    return (
      <div className="py-12 text-center text-gray-500">
        {emptyMessage}
      </div>
    )
  }

  const getStatusIcon = (status: Task['status']) => {
    switch (status) {
      case 'running':
        return <RefreshCw className="w-5 h-5 text-blue-500 animate-spin" />
      case 'completed':
        return <CheckCircle2 className="w-5 h-5 text-green-500" />
      case 'failed':
        return <XCircle className="w-5 h-5 text-red-500" />
      case 'pending':
      default:
        return <Clock className="w-5 h-5 text-yellow-500" />
    }
  }

  return (
    <div className="border rounded-lg divide-y">
      {tasks.map((task) => (
        <div key={task.id} className="p-4 hover:bg-gray-50">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              {getStatusIcon(task.status)}
              <div className="font-medium capitalize">{task.type}</div>
            </div>
            <TimeAgo timestamp={task.createdAt} />
          </div>
          <div className="text-sm text-gray-600 mb-2">{task.message}</div>
          <div className="flex items-center gap-4">
            <div className="flex-1 h-2 bg-gray-200 rounded-full">
              <div
                className="h-full bg-blue-500 rounded-full transition-all"
                style={{ width: `${task.progress}%` }}
              />
            </div>
            <span className="text-xs text-gray-500 w-10 text-right">{task.progress}%</span>
          </div>
          {task.error && (
            <div className="mt-2 text-sm text-red-600 bg-red-50 px-2 py-1 rounded">
              {task.error}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
