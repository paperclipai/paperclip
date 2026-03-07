'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Plus, Search } from 'lucide-react'
import { StatusBadge } from '@/components/common/StatusBadge'
import { formatTimestamp } from '@/lib/utils'
import type { Agent } from '@/lib/types'

const mockAgents: Agent[] = [
  {
    id: 'agent-1',
    name: 'Chat Assistant',
    status: 'active',
    canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai',
    config: { entry: 'src/index.ts', memory: 256, compute: 'medium' },
    createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'agent-2',
    name: 'Code Analyzer',
    status: 'inactive',
    canisterId: 'be2us-64aaa-aaaaa-qaaca-cai',
    config: { entry: 'src/index.ts', memory: 512, compute: 'high' },
    createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  },
]

export function AgentList({ agents = mockAgents }: { agents?: Agent[] }) {
  const [searchQuery, setSearchQuery] = useState('')

  const filteredAgents = agents.filter((agent) =>
    agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    agent.id.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Search className="w-5 h-5 text-gray-500" />
          <input
            type="text"
            placeholder="Search agents..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="px-4 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <Link
          href="/agents/new"
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
        >
          <Plus className="w-4 h-4" />
          New Agent
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filteredAgents.length === 0 ? (
          <div className="col-span-full text-center py-12 text-gray-500">
            No agents found
          </div>
        ) : (
          filteredAgents.map((agent) => (
            <Link
              key={agent.id}
              href={`/agents/${agent.id}`}
              className="block border rounded-lg p-4 hover:border-blue-500 transition"
            >
              <div className="flex items-start justify-between mb-3">
                <h3 className="font-semibold">{agent.name}</h3>
                <StatusBadge status={agent.status} />
              </div>
              <div className="space-y-1 text-sm text-gray-600">
                <p>ID: {agent.id.slice(0, 8)}...</p>
                <p>Canister: {agent.canisterId ? agent.canisterId.slice(0, 8) + '...' : 'Not deployed'}</p>
                <p>Memory: {agent.config.memory} MB</p>
                <p>Created: {formatTimestamp(agent.createdAt)}</p>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  )
}
