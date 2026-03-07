'use client'

import { useState } from 'react'
import { Globe, CheckCircle2, XCircle, AlertTriangle, RefreshCw } from 'lucide-react'
import { StatusBadge } from '@/components/common/StatusBadge'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { useNetworks } from '@/hooks/useNetworks'
import type { Network } from '@/lib/types'

export default function NetworksPage() {
  const { networks, isLoading, error, refetch } = useNetworks()
  const [connectingTo, setConnectingTo] = useState<string | null>(null)
  const [newNetwork, setNewNetwork] = useState({ name: '', url: '' })

  const handleConnect = async (networkName: string) => {
    setConnectingTo(networkName)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    setConnectingTo(null)
    refetch()
  }

  const handleAddNetwork = async () => {
    if (!newNetwork.name || !newNetwork.url) return
    setNewNetwork({ name: '', url: '' })
  }

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Networks</h1>
          <p className="text-red-500">{error.message}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Networks</h1>
          <p className="text-muted-foreground">
            View and manage ICP network connections
          </p>
        </div>
        <button 
          onClick={() => refetch()}
          className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {networks.map((network) => (
          <div key={network.name} className="border rounded-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Globe className="w-5 h-5 text-blue-500" />
                <h3 className="font-semibold">{network.name}</h3>
              </div>
              {network.status === 'connected' && <CheckCircle2 className="w-5 h-5 text-green-500" />}
              {network.status === 'disconnected' && <XCircle className="w-5 h-5 text-gray-500" />}
              {network.status === 'degraded' && <AlertTriangle className="w-5 h-5 text-yellow-500" />}
            </div>

            <div className="space-y-3">
              <div>
                <p className="text-sm text-gray-600">Status</p>
                <StatusBadge status={network.status} />
              </div>
              <div>
                <p className="text-sm text-gray-600">URL</p>
                <p className="text-sm font-mono">{network.url}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Nodes</p>
                <p className="text-sm">{network.nodeCount}</p>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t">
              <button 
                onClick={() => handleConnect(network.name)}
                disabled={connectingTo === network.name}
                className={`w-full px-4 py-2 rounded transition ${
                  network.status === 'connected'
                    ? 'bg-green-100 text-green-700 hover:bg-green-200'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                } ${connectingTo === network.name ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {connectingTo === network.name ? 'Connecting...' : network.status === 'connected' ? 'Connected' : 'Connect'}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="border rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">Add Network</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Network Name
            </label>
            <input
              type="text"
              placeholder="My Custom Network"
              value={newNetwork.name}
              onChange={(e) => setNewNetwork(prev => ({ ...prev, name: e.target.value }))}
              className="w-full px-4 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Network URL
            </label>
            <input
              type="url"
              placeholder="https://..."
              value={newNetwork.url}
              onChange={(e) => setNewNetwork(prev => ({ ...prev, url: e.target.value }))}
              className="w-full px-4 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button 
            onClick={handleAddNetwork}
            disabled={!newNetwork.name || !newNetwork.url}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add Network
          </button>
        </div>
      </div>
    </div>
  )
}
