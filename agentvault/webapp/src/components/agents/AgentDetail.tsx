'use client'

import { ArrowLeft, Activity, Play, Settings, StopCircle, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { StatusBadge } from '@/components/common/StatusBadge'
import { formatBytes, formatCycles, formatTimestamp } from '@/lib/utils'
import type { Agent, Canister } from '@/lib/types'

interface AgentDetailProps {
  agent: Agent
  canister?: Canister
  onDeploy?: () => void
  onStop?: () => void
  isDeploying?: boolean
}

export function AgentDetail({ agent, canister, onDeploy, onStop, isDeploying }: AgentDetailProps) {
  return (
    <div className="space-y-6">
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
          {onDeploy && (
            <button
              onClick={onDeploy}
              disabled={isDeploying}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 transition"
            >
              {isDeploying && <RefreshCw className="w-4 h-4 animate-spin" />}
              <Play className="w-4 h-4" />
              {agent.status === 'active' ? 'Restart' : 'Deploy'}
            </button>
          )}
          {agent.status === 'active' && onStop && (
            <button
              onClick={onStop}
              disabled={isDeploying}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 transition"
            >
              {isDeploying && <RefreshCw className="w-4 h-4 animate-spin" />}
              <StopCircle className="w-4 h-4" />
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

      <div className="grid gap-6 lg:grid-cols-2">
        {canister && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Activity className="w-5 h-5" />
              Status
            </h2>
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
          </div>
        )}

        {agent.metrics && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <RefreshCw className="w-5 h-5" />
              Metrics
            </h2>
            <div className="border rounded-lg p-4 space-y-2">
              <p className="flex justify-between">
                <span className="text-gray-600">Requests:</span>
                <span>{agent.metrics.requests.toLocaleString()}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-gray-600">Errors:</span>
                <span className="text-red-500">{agent.metrics.errors}</span>
              </p>
              <p className="flex justify-between">
                <span className="text-gray-600">Avg Latency:</span>
                <span>{agent.metrics.avgLatency}ms</span>
              </p>
              <p className="flex justify-between">
                <span className="text-gray-600">Uptime:</span>
                <span>{agent.metrics.uptime}%</span>
              </p>
            </div>
          </div>
        )}
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
    </div>
  )
}
