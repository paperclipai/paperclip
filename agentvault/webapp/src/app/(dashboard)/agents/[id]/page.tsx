'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Activity, Play, Settings, StopCircle, RefreshCw } from 'lucide-react'
import { StatusBadge } from '@/components/common/StatusBadge'
import { useCanisterStatus } from '@/hooks/useCanisterStatus'
import { useDeployments } from '@/hooks/useDeployments'
import { useAgent } from '@/hooks/useAgent'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { apiClient } from '@/lib/api-client'
import { formatBytes, formatCycles, formatTimestamp } from '@/lib/utils'

export default function AgentDetailPage({ params }: { params: { id: string } }) {
  const { agent, isLoading: agentLoading, error: agentError, refetch: refetchAgent } = useAgent(params.id)
  const { data: canister, isLoading: canisterLoading, error: canisterError } = useCanisterStatus(agent?.canisterId || '')
  const { deployments, isLoading: deploymentsLoading, refetch: refetchDeployments } = useDeployments({ agentId: params.id })
  const [isDeploying, setIsDeploying] = useState(false)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [deploySuccess, setDeploySuccess] = useState<string | null>(null)

  const handleDeploy = async () => {
    if (!agent) return

    setDeployError(null)
    setDeploySuccess(null)
    setIsDeploying(true)
    try {
      const response = await apiClient.post<{
        deployment: { canisterId?: string }
      }>('/deployments', {
        agentId: agent.id,
        canisterId: agent.canisterId,
        mode: agent.canisterId ? 'upgrade' : 'auto',
      })

      if (!response.success) {
        throw new Error(response.error?.message || 'Failed to deploy agent')
      }

      setDeploySuccess(
        response.data?.deployment?.canisterId
          ? `Deployment completed: ${response.data.deployment.canisterId}`
          : 'Deployment completed successfully'
      )

      await Promise.all([refetchAgent(), refetchDeployments()])
    } catch (error) {
      setDeployError(error instanceof Error ? error.message : 'Failed to deploy agent')
    } finally {
      setIsDeploying(false)
    }
  }

  const handleStop = async () => {
    setIsDeploying(true)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    setIsDeploying(false)
  }

  if (agentLoading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (agentError || !agent) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/agents" className="text-gray-500 hover:text-gray-700">
            <ArrowLeft className="w-6 h-6" />
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Agent Not Found</h1>
            <p className="text-muted-foreground">
              {agentError?.message || 'The requested agent could not be found.'}
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/agents" className="text-gray-500 hover:text-gray-700">
            <ArrowLeft className="w-6 h-6" />
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{agent.name}</h1>
            <p className="text-muted-foreground">
              ID: {agent.id}
            </p>
          </div>
          <StatusBadge status={agent.status} />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleDeploy}
            disabled={isDeploying}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 transition"
          >
            {isDeploying ? <LoadingSpinner size="sm" /> : <Play className="w-4 h-4" />}
            {agent.status === 'active' ? '1-Click Redeploy' : '1-Click Deploy'}
          </button>
          {agent.status === 'active' && (
            <button
              onClick={handleStop}
              disabled={isDeploying}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 transition"
            >
              {isDeploying ? <LoadingSpinner size="sm" /> : <StopCircle className="w-4 h-4" />}
              Stop
            </button>
          )}
          <Link
            href={`/agents/${agent.id}/config`}
            className="flex items-center gap-2 px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700 transition"
          >
            <Settings className="w-4 h-4" />
            Configure
          </Link>
        </div>
      </div>

      {deploySuccess && (
        <div className="rounded border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {deploySuccess}
        </div>
      )}

      {deployError && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {deployError}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Activity className="w-5 h-5" />
            Status
          </h2>
          {canisterLoading ? (
            <LoadingSpinner />
          ) : canisterError ? (
            <p className="text-red-500">Failed to load canister status</p>
          ) : canister ? (
            <div className="border rounded-lg p-4 space-y-2">
              <p className="flex justify-between">
                <span className="text-gray-600">Canister ID:</span>
                <span className="font-mono">{canister.id}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-gray-600">Status:</span>
                <StatusBadge status={canister.status} />
              </p>
              <p className="flex justify-between">
                <span className="text-gray-600">Cycles:</span>
                <span>{formatCycles(canister.cycles)}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-gray-600">Memory:</span>
                <span>{formatBytes(canister.memory)}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-gray-600">Controller:</span>
                <span className="font-mono">{canister.controller.slice(0, 8)}...</span>
              </p>
            </div>
          ) : (
            <p className="text-gray-500">Canister not deployed</p>
          )}
        </div>

        <div className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <RefreshCw className="w-5 h-5" />
            Metrics
          </h2>
          <div className="border rounded-lg p-4 space-y-2">
            <p className="flex justify-between">
              <span className="text-gray-600">Requests:</span>
              <span>{agent.metrics?.requests.toLocaleString() ?? 'N/A'}</span>
            </p>
            <p className="flex justify-between">
              <span className="text-gray-600">Errors:</span>
              <span className="text-red-500">{agent.metrics?.errors ?? 'N/A'}</span>
            </p>
            <p className="flex justify-between">
              <span className="text-gray-600">Avg Latency:</span>
              <span>{agent.metrics?.avgLatency ? `${agent.metrics.avgLatency}ms` : 'N/A'}</span>
            </p>
            <p className="flex justify-between">
              <span className="text-gray-600">Uptime:</span>
              <span>{agent.metrics?.uptime ? `${agent.metrics.uptime}%` : 'N/A'}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Configuration</h2>
        <div className="border rounded-lg p-4 space-y-2">
          <p className="flex justify-between">
            <span className="text-gray-600">Entry Point:</span>
            <span className="font-mono">{agent.config.entry}</span>
          </p>
          <p className="flex justify-between">
            <span className="text-gray-600">Memory:</span>
            <span>{agent.config.memory} MB</span>
          </p>
          <p className="flex justify-between">
            <span className="text-gray-600">Compute:</span>
            <span>{agent.config.compute}</span>
          </p>
          <p className="flex justify-between">
            <span className="text-gray-600">Created:</span>
            <span>{formatTimestamp(agent.createdAt)}</span>
          </p>
          <p className="flex justify-between">
            <span className="text-gray-600">Updated:</span>
            <span>{formatTimestamp(agent.updatedAt)}</span>
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Recent Deployments</h2>
        {deploymentsLoading ? (
          <LoadingSpinner />
        ) : deployments.length === 0 ? (
          <p className="text-gray-500">No deployments yet</p>
        ) : (
          <div className="border rounded-lg divide-y">
            {deployments.slice(0, 5).map((deployment) => (
              <div key={deployment.id} className="p-4 flex items-center justify-between">
                <div>
                  <StatusBadge status={deployment.status} />
                  <span className="ml-2 text-sm text-gray-600">{formatTimestamp(deployment.createdAt)}</span>
                  {deployment.error && (
                    <p className="mt-1 text-xs text-red-500">{deployment.error}</p>
                  )}
                </div>
                {deployment.canisterId && (
                  <span className="font-mono text-sm">{deployment.canisterId.slice(0, 8)}...</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
