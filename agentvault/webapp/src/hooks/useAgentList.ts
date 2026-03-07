'use client'

import { useEffect, useState } from 'react'
import type { Agent } from '@/lib/types'
import { apiClient } from '@/lib/api-client'

export function useAgentList() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const fetchAgents = async () => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await apiClient.get<Agent[]>('/agents')
      if (response.success && response.data) {
        setAgents(response.data)
      } else {
        setError(new Error(response.error?.message || 'Failed to fetch agents'))
      }
    } catch (_err) {
      setError(_err as Error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchAgents()
  }, [])

  return { agents, isLoading, error, refetch: fetchAgents }
}
