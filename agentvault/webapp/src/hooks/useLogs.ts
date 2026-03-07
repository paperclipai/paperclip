'use client'

import { useEffect, useState } from 'react'
import type { LogEntry } from '@/lib/types'
import { apiClient } from '@/lib/api-client'

interface UseLogsOptions {
  canisterId?: string
  level?: 'debug' | 'info' | 'warn' | 'error'
  limit?: number
}

export function useLogs(options: UseLogsOptions = {}) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const fetchLogs = async () => {
    setIsLoading(true)
    setError(null)

    try {
      const params: Record<string, string> = {}
      if (options.canisterId) params.canisterId = options.canisterId
      if (options.level) params.level = options.level
      if (options.limit) params.limit = String(options.limit)

      const response = await apiClient.get<LogEntry[]>('/logs', params)
      if (response.success && response.data) {
        setLogs(response.data)
      } else {
        setError(new Error(response.error?.message || 'Failed to fetch logs'))
      }
    } catch (_err) {
      setError(_err as Error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchLogs()
  }, [options.canisterId, options.level, options.limit])

  return { logs, isLoading, error, refetch: fetchLogs }
}
