'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { ProofRecord, ShareProofResult } from '@/lib/types'
import { apiClient } from '@/lib/api-client'

const POLL_INTERVAL_MS = 15_000 // 15 s – simulates canister subscription

export function useProof(vaultId: string | undefined) {
  const [proof, setProof] = useState<ProofRecord | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchProof = useCallback(async () => {
    if (!vaultId) return
    setIsLoading(true)
    setError(null)
    try {
      const res = await apiClient.get<ProofRecord>(`/vault/${vaultId}/proof`)
      if (res.success && res.data) {
        setProof(res.data)
        setLastRefreshed(new Date())
      } else {
        setError(new Error(res.error?.message ?? 'Failed to fetch proof'))
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'))
    } finally {
      setIsLoading(false)
    }
  }, [vaultId])

  // Initial fetch + polling (simulates canister subscription push)
  useEffect(() => {
    if (!vaultId) return

    fetchProof()

    intervalRef.current = setInterval(() => {
      fetchProof()
    }, POLL_INTERVAL_MS)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [vaultId, fetchProof])

  const shareProof = useCallback(async (): Promise<ShareProofResult | null> => {
    if (!vaultId) return null
    try {
      const res = await apiClient.post<ShareProofResult>(`/vault/${vaultId}/proof/share`, {})
      if (res.success && res.data) return res.data
      throw new Error(res.error?.message ?? 'Failed to generate share link')
    } catch (err) {
      throw err instanceof Error ? err : new Error('Unknown error')
    }
  }, [vaultId])

  return { proof, isLoading, error, lastRefreshed, refetch: fetchProof, shareProof }
}
