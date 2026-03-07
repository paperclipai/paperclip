'use client'

import { useState } from 'react'
import { X, Check, AlertCircle } from 'lucide-react'
import { StatusBadge } from '@/components/common/StatusBadge'
import type { Agent, Canister } from '@/lib/types'

interface DeployDialogProps {
  agent: Agent
  canister?: Canister
  isOpen: boolean
  onClose: () => void
  onDeploy: (config: { canisterId?: string; cycles?: bigint }) => void
  deployStatus?: 'idle' | 'deploying' | 'success' | 'error'
  deployError?: string
}

export function DeployDialog({ agent, canister, isOpen, onClose, onDeploy, deployStatus, deployError }: DeployDialogProps) {
  const [canisterId, setCanisterId] = useState(canister?.id || '')
  const [cycles, setCycles] = useState<string>('1000000000000')

  if (!isOpen) return null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onDeploy({
      canisterId: canisterId || undefined,
      cycles: cycles ? BigInt(cycles) : undefined,
    })
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Deploy Agent</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700"
            disabled={deployStatus === 'deploying'}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {deployStatus === 'success' ? (
          <div className="text-center py-6">
            <Check className="w-12 h-12 text-green-500 mx-auto mb-4" />
            <p className="font-semibold mb-2">Deployment Successful</p>
            <p className="text-sm text-gray-600 mb-4">Your agent has been deployed successfully.</p>
            <button
              onClick={onClose}
              className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-4 mb-4">
              <div>
                <p className="text-sm font-medium text-gray-700">Agent</p>
                <p className="font-semibold">{agent.name}</p>
                <p className="text-sm text-gray-500">{agent.id}</p>
              </div>

              {canister && (
                <div className="bg-gray-50 p-3 rounded">
                  <p className="text-sm font-medium text-gray-700 mb-1">Current Canister</p>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm">{canister.id}</span>
                    <StatusBadge status={canister.status} />
                  </div>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Canister ID (optional for new deployment)
                  </label>
                  <input
                    type="text"
                    value={canisterId}
                    onChange={(e) => setCanisterId(e.target.value)}
                    className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="rrkah-fqaaa-aaaaa-aaaaq-cai"
                    disabled={deployStatus === 'deploying'}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Initial Cycles
                  </label>
                  <input
                    type="text"
                    value={cycles}
                    onChange={(e) => setCycles(e.target.value)}
                    className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="1000000000000"
                    disabled={deployStatus === 'deploying'}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Recommended: 1T cycles minimum
                  </p>
                </div>

                {deployError && (
                  <div className="bg-red-50 border border-red-200 p-3 rounded">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-5 h-5 text-red-500 mt-0.5" />
                      <p className="text-sm text-red-700">{deployError}</p>
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-3 pt-4">
                  <button
                    type="submit"
                    disabled={deployStatus === 'deploying'}
                    className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition"
                  >
                    {deployStatus === 'deploying' ? 'Deploying...' : 'Deploy'}
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={deployStatus === 'deploying'}
                    className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 disabled:opacity-50 transition"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
