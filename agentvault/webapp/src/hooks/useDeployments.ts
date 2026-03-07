'use client'

import { useEffect, useState } from 'react'
import type { Deployment } from '@/lib/types'
import { apiClient } from '@/lib/api-client'

interface UseDeploymentsOptions {
  agentId?: string
  status?: 'pending' | 'deploying' | 'completed' | 'failed'
}

export function useDeployments(options: UseDeploymentsOptions = {}) {
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const fetchDeployments = async () => {
    setIsLoading(true)
    setError(null)

    try {
      const params: Record<string, string> = {}
      if (options.agentId) params.agentId = options.agentId
      if (options.status) params.status = options.status

      const response = await apiClient.get<Deployment[]>('/deployments', params)
      if (response.success && response.data) {
        setDeployments(response.data)
      } else {
        setError(new Error(response.error?.message || 'Failed to fetch deployments'))
      }
    } catch (_err) {
      setError(_err as Error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchDeployments()
  }, [options.agentId, options.status])

  return { deployments, isLoading, error, refetch: fetchDeployments }
}
