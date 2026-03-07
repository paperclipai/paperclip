'use client'

import { useEffect, useState } from 'react'
import type { Canister } from '@/lib/types'
import { apiClient } from '@/lib/api-client'

export function useCanisterStatus(canisterId?: string) {
  const [data, setData] = useState<Canister | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!canisterId) return

    const fetchCanister = async () => {
      setIsLoading(true)
      setError(null)

      try {
        const response = await apiClient.get<Canister>(`/canisters/${canisterId}`)
        if (response.success && response.data) {
          setData(response.data)
        } else {
          setError(new Error(response.error?.message || 'Failed to fetch canister'))
        }
      } catch (_err) {
        setError(_err as Error)
      } finally {
        setIsLoading(false)
      }
    }

    fetchCanister()
  }, [canisterId])

  return { data, isLoading, error }
}
