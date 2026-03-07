'use client'

import { Wallet, ArrowUp, ArrowDown, Copy, Check } from 'lucide-react'
import { useState } from 'react'
import { formatCycles, truncatePrincipal } from '@/lib/utils'
import type { Wallet as WalletType } from '@/lib/types'

interface BalanceCardProps {
  wallet: WalletType
  onSend?: () => void
  onReceive?: () => void
}

export function BalanceCard({ wallet, onSend, onReceive }: BalanceCardProps) {
  const [copied, setCopied] = useState(false)

  const handleCopyPrincipal = () => {
    navigator.clipboard.writeText(wallet.principal)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="border rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Wallet className="w-5 h-5 text-blue-500" />
          <span className="font-semibold capitalize">{wallet.type} Wallet</span>
        </div>
        <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded">
          Connected
        </span>
      </div>

      <div className="space-y-3">
        <p className="text-2xl font-bold">{formatCycles(wallet.balance)}</p>

        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600 font-mono flex-1 truncate">
            {truncatePrincipal(wallet.principal)}
          </span>
          <button
            onClick={handleCopyPrincipal}
            className="p-1 hover:bg-gray-100 rounded transition"
            title="Copy principal"
          >
            {copied ? (
              <Check className="w-4 h-4 text-green-500" />
            ) : (
              <Copy className="w-4 h-4 text-gray-500" />
            )}
          </button>
        </div>

        {wallet.address && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600 font-mono flex-1 truncate">
              {wallet.address}
            </span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(wallet.address!)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
              className="p-1 hover:bg-gray-100 rounded transition"
              title="Copy address"
            >
              {copied ? (
                <Check className="w-4 h-4 text-green-500" />
              ) : (
                <Copy className="w-4 h-4 text-gray-500" />
              )}
            </button>
          </div>
        )}

        <p className="text-xs text-gray-500">
          Created {new Date(wallet.createdAt).toLocaleDateString()}
        </p>
      </div>

      <div className="mt-4 pt-4 border-t flex gap-2">
        <button
          onClick={onSend}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-sm bg-blue-50 text-blue-600 rounded hover:bg-blue-100 transition"
        >
          <ArrowUp className="w-4 h-4" />
          Send
        </button>
        <button
          onClick={onReceive}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-sm bg-green-50 text-green-600 rounded hover:bg-green-100 transition"
        >
          <ArrowDown className="w-4 h-4" />
          Receive
        </button>
      </div>
    </div>
  )
}
