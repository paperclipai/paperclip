'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ControlCenterData } from '@/lib/types'
import { apiClient } from '@/lib/api-client'

interface UseControlCenterOptions {
  refreshSeconds?: number
}

export function useControlCenter(options: UseControlCenterOptions = {}) {
  const refreshSeconds = useMemo(() => options.refreshSeconds ?? 10, [options.refreshSeconds])
  const [data, setData] = useState<ControlCenterData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const fetchControlCenter = async () => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await apiClient.get<ControlCenterData>('/control-center')
      if (response.success && response.data) {
        setData(response.data)
      } else {
        setError(new Error(response.error?.message || 'Failed to fetch control center data'))
      }
    } catch (_err) {
      setError(_err as Error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchControlCenter()

    const interval = setInterval(() => {
      fetchControlCenter()
    }, refreshSeconds * 1000)

    return () => {
      clearInterval(interval)
    }
  }, [refreshSeconds])

  return { data, isLoading, error, refetch: fetchControlCenter }
}
