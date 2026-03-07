'use client'

import { useEffect, useState } from 'react'
import type { ChartDataPoint } from '@/lib/types'
import { apiClient } from '@/lib/api-client'

interface UseMetricsOptions {
  canisterId?: string
  timeframe?: 'hour' | 'day' | 'week'
}

export function useMetrics(options: UseMetricsOptions = {}) {
  const [data, setData] = useState<ChartDataPoint[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const fetchMetrics = async () => {
    setIsLoading(true)
    setError(null)

    try {
      const params: Record<string, string> = {}
      if (options.canisterId) params.canisterId = options.canisterId
      if (options.timeframe) params.timeframe = options.timeframe

      const response = await apiClient.get<ChartDataPoint[]>('/metrics', params)
      if (response.success && response.data) {
        setData(response.data)
      } else {
        setError(new Error(response.error?.message || 'Failed to fetch metrics'))
      }
    } catch (_err) {
      setError(_err as Error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchMetrics()
  }, [options.canisterId, options.timeframe])

  return { data, isLoading, error, refetch: fetchMetrics }
}
