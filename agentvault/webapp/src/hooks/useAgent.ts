'use client'

import { useEffect, useState } from 'react'
import type { Agent } from '@/lib/types'
import { apiClient } from '@/lib/api-client'

export function useAgent(id: string | undefined) {
  const [agent, setAgent] = useState<Agent | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const fetchAgent = async () => {
    if (!id) {
      setAgent(null)
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const response = await apiClient.get<Agent>(`/agents/${id}`)
      if (response.success && response.data) {
        setAgent(response.data)
      } else {
        setError(new Error(response.error?.message || 'Failed to fetch agent'))
      }
    } catch (_err) {
      setError(_err as Error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchAgent()
  }, [id])

  return { agent, isLoading, error, refetch: fetchAgent }
}
