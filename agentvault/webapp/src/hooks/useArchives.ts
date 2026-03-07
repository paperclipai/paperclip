'use client'

import { useEffect, useState } from 'react'
import type { Archive } from '@/lib/types'
import { apiClient } from '@/lib/api-client'

export function useArchives() {
  const [archives, setArchives] = useState<Archive[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const fetchArchives = async () => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await apiClient.get<Archive[]>('/archives')
      if (response.success && response.data) {
        setArchives(response.data)
      } else {
        setError(new Error(response.error?.message || 'Failed to fetch archives'))
      }
    } catch (_err) {
      setError(_err as Error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchArchives()
  }, [])

  return { archives, isLoading, error, refetch: fetchArchives }
}
