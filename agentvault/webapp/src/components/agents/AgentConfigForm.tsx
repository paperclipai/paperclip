'use client'

import { useState } from 'react'
import type { AgentConfig } from '@/lib/types'

interface AgentConfigFormProps {
  config: AgentConfig
  onSave: (config: AgentConfig) => void
  onCancel: () => void
}

export function AgentConfigForm({ config, onSave, onCancel }: AgentConfigFormProps) {
  const [entry, setEntry] = useState(config.entry)
  const [memory, setMemory] = useState(config.memory)
  const [compute, setCompute] = useState(config.compute)
  const [cycles, setCycles] = useState<string>(config.cycles?.toString() || '')
  const [routing, setRouting] = useState(config.routing?.join(', ') || '')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const newConfig: AgentConfig = {
      entry,
      memory,
      compute,
      cycles: cycles ? BigInt(cycles) : undefined,
      routing: routing ? routing.split(',').map((s) => s.trim()) : undefined,
    }
    onSave(newConfig)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Entry Point
        </label>
        <input
          type="text"
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
          className="w-full px-4 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="src/index.ts"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Memory (MB)
        </label>
        <input
          type="number"
          min="128"
          max="8192"
          step="128"
          value={memory}
          onChange={(e) => setMemory(parseInt(e.target.value))}
          className="w-full px-4 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Compute
        </label>
        <select
          value={compute}
          onChange={(e) => setCompute(e.target.value)}
          className="w-full px-4 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Cycles (optional)
        </label>
        <input
          type="text"
          value={cycles}
          onChange={(e) => setCycles(e.target.value)}
          className="w-full px-4 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="1000000000000"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Routing Canisters (optional, comma-separated)
        </label>
        <input
          type="text"
          value={routing}
          onChange={(e) => setRouting(e.target.value)}
          className="w-full px-4 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="rrkah-fqaaa-aaaaa-aaaaq-cai, be2us-64aaa-aaaaa-qaaca-cai"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
        >
          Save Configuration
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-6 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
