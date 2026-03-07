'use client'

import { useEffect, useState } from 'react'
import type { Network } from '@/lib/types'
import { apiClient } from '@/lib/api-client'

export function useNetworks() {
  const [networks, setNetworks] = useState<Network[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const fetchNetworks = async () => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await apiClient.get<Network[]>('/networks')
      if (response.success && response.data) {
        setNetworks(response.data)
      } else {
        setError(new Error(response.error?.message || 'Failed to fetch networks'))
      }
    } catch (_err) {
      setError(_err as Error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchNetworks()
  }, [])

  return { networks, isLoading, error, refetch: fetchNetworks }
}
