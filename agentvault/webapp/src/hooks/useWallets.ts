'use client'

import { useEffect, useState } from 'react'
import type { Wallet } from '@/lib/types'
import { apiClient } from '@/lib/api-client'

export function useWallets() {
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const fetchWallets = async () => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await apiClient.get<Wallet[]>('/wallets')
      if (response.success && response.data) {
        setWallets(response.data)
      } else {
        setError(new Error(response.error?.message || 'Failed to fetch wallets'))
      }
    } catch (_err) {
      setError(_err as Error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchWallets()
  }, [])

  return { wallets, isLoading, error, refetch: fetchWallets }
}
