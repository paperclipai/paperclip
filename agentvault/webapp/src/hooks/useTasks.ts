'use client'

import { useEffect, useState } from 'react'
import type { Task } from '@/lib/types'
import { apiClient } from '@/lib/api-client'

export function useTasks(filter?: { status?: string }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const fetchTasks = async () => {
    setIsLoading(true)
    setError(null)

    try {
      const params: Record<string, string> = {}
      if (filter?.status && filter.status !== 'all') {
        params.status = filter.status
      }
      const query = Object.keys(params).length > 0 ? `?${new URLSearchParams(params)}` : ''
      const response = await apiClient.get<Task[]>(`/tasks${query}`)
      if (response.success && response.data) {
        setTasks(response.data)
      } else {
        setError(new Error(response.error?.message || 'Failed to fetch tasks'))
      }
    } catch (_err) {
      setError(_err as Error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchTasks()
  }, [filter?.status])

  return { tasks, isLoading, error, refetch: fetchTasks }
}
