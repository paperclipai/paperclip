'use client'

import { useState } from 'react'
import { Plus, ArrowUp, ArrowDown, Copy, Check, Wallet as WalletIcon } from 'lucide-react'
import { formatCycles, formatTimestamp } from '@/lib/utils'
import { Wallet as WalletType } from '@/lib/types'

interface WalletOverviewProps {
  wallets: WalletType[]
  onConnectWallet?: () => void
}

interface BalanceCardProps {
  wallet: WalletType
  onSend?: () => void
  onReceive?: () => void
}

export function WalletOverview({ wallets, onConnectWallet }: WalletOverviewProps) {
  const totalCycles = wallets.reduce((sum, wallet) => sum + wallet.balance, 0n)

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-3">
        <div className="border rounded-lg p-6">
          <div className="flex items-center gap-2 mb-4">
            <WalletIcon className="w-8 h-8 text-blue-500" />
            <span className="font-semibold">Total Balance</span>
          </div>
          <p className="text-3xl font-bold">{formatCycles(totalCycles)}</p>
          <p className="text-sm text-gray-600">Across all wallets</p>
        </div>

        <div className="border rounded-lg p-6">
          <div className="flex items-center gap-2 mb-4">
            <Check className="w-8 h-8 text-green-500" />
            <span className="font-semibold">Connected Wallets</span>
          </div>
          <p className="text-sm text-gray-600">{wallets.length} active connections</p>
        </div>

        <div className="border rounded-lg p-6">
          <div className="flex items-center gap-2 mb-4">
            <WalletIcon className="w-8 h-8 text-yellow-500" />
            <span className="font-semibold">Status</span>
          </div>
          <p className="text-sm text-gray-600">All systems operational</p>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={onConnectWallet}
          className="flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
        >
          <Plus className="w-4 h-4" />
          Connect New Wallet
        </button>
      </div>
    </div>
  )
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
          <WalletIcon className="w-8 h-8 text-blue-500" />
          <span className="font-semibold capitalize">{wallet.type} Wallet</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded">
            {wallet.status === 'connected' ? 'Connected' : 'Disconnected'}
          </span>
          <button
            onClick={handleCopyPrincipal}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            title={copied ? 'Copied!' : 'Copy to clipboard'}
          >
            {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>
      </div>

      <div className="mb-4">
        <p className="text-3xl font-bold">{formatCycles(wallet.balance)}</p>
        <p className="text-sm text-gray-600">Balance</p>
      </div>

      {wallet.address && (
        <div className="mb-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-gray-600">Address:</span>
            <span className="text-gray-600 font-mono">{wallet.address.slice(0, 12)}...{wallet.address.slice(-4)}</span>
            <button
              onClick={handleCopyPrincipal}
              className="text-gray-400 hover:text-gray-600"
            >
              <Copy className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-gray-600 mb-4">
        Created {formatTimestamp(wallet.createdAt)}
      </p>

      <div className="pt-4 border-t flex gap-2">
        <button
          onClick={onSend}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-blue-50 text-blue-600 rounded hover:bg-blue-100 transition"
        >
          <ArrowUp className="w-4 h-4" />
          Send
        </button>
        <button
          onClick={onReceive}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-green-50 text-green-600 rounded hover:bg-green-100 transition"
        >
          <ArrowDown className="w-4 h-4" />
          Receive
        </button>
      </div>
    </div>
  )
}
