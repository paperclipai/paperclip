'use client'

import { useEffect, useState } from 'react'
import type { Transaction } from '@/lib/types'
import { apiClient } from '@/lib/api-client'

export function useTransactions(walletId?: string) {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const fetchTransactions = async () => {
    setIsLoading(true)
    setError(null)

    try {
      const endpoint = walletId ? `/wallets/${walletId}/transactions` : '/transactions'
      const response = await apiClient.get<Transaction[]>(endpoint)
      if (response.success && response.data) {
        setTransactions(response.data)
      } else {
        setError(new Error(response.error?.message || 'Failed to fetch transactions'))
      }
    } catch (_err) {
      setError(_err as Error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchTransactions()
  }, [walletId])

  return { transactions, isLoading, error, refetch: fetchTransactions }
}
