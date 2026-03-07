'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Plus, Wallet, ArrowUp, ArrowDown, ExternalLink } from 'lucide-react'
import { useWallets } from '@/hooks/useWallets'
import { useTransactions } from '@/hooks/useTransactions'
import { LoadingSpinner } from '@/components/common/LoadingSpinner'
import { formatCycles, formatTimestamp, truncatePrincipal } from '@/lib/utils'

export default function WalletsPage() {
  const { wallets, isLoading, error } = useWallets()
  const { transactions } = useTransactions()
  const [sendModal, setSendModal] = useState<{ open: boolean; walletId: string } | null>(null)
  const [receiveModal, setReceiveModal] = useState<{ open: boolean; walletId: string } | null>(null)

  const handleSend = (walletId: string) => {
    setSendModal({ open: true, walletId })
  }

  const handleReceive = (walletId: string) => {
    setReceiveModal({ open: true, walletId })
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Wallets</h1>
          <p className="text-muted-foreground">
            Manage your ICP wallets and cycles
          </p>
        </div>
        <Link
          href="/wallets/new"
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
        >
          <Plus className="w-4 h-4" />
          Connect Wallet
        </Link>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center min-h-[400px]">
          <LoadingSpinner size="lg" />
        </div>
      ) : error ? (
        <div className="flex items-center justify-center min-h-[400px]">
          <p className="text-red-500">{error.message}</p>
        </div>
      ) : wallets.length === 0 ? (
        <div className="flex flex-col items-center justify-center min-h-[400px] text-gray-500">
          <Wallet className="w-16 h-16 mb-4" />
          <p className="text-lg font-medium">No wallets connected</p>
          <p className="text-sm">Connect a wallet to get started</p>
          <Link
            href="/wallets/new"
            className="mt-4 flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
          >
            <Plus className="w-4 h-4" />
            Connect Wallet
          </Link>
        </div>
      ) : (
        <>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {wallets.map((wallet) => (
              <div key={wallet.id} className="border rounded-lg p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Wallet className="w-5 h-5 text-blue-500" />
                    <span className="font-semibold capitalize">{wallet.type} Wallet</span>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded ${
                    wallet.status === 'connected' 
                      ? 'bg-green-100 text-green-700' 
                      : 'bg-gray-100 text-gray-600'
                  }`}>
                    {wallet.status || 'Connected'}
                  </span>
                </div>
                <div className="space-y-2">
                  <p className="text-2xl font-bold">{formatCycles(wallet.balance)}</p>
                  <p className="text-sm text-gray-600 font-mono">
                    {truncatePrincipal(wallet.principal)}
                  </p>
                  {wallet.address && (
                    <p className="text-xs text-gray-500 font-mono">
                      {wallet.address.slice(0, 10)}...{wallet.address.slice(-8)}
                    </p>
                  )}
                  <p className="text-xs text-gray-500">
                    Created {formatTimestamp(wallet.createdAt)}
                  </p>
                </div>
                <div className="mt-4 pt-4 border-t flex gap-2">
                  <button 
                    onClick={() => handleSend(wallet.id)}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-50 text-blue-600 rounded hover:bg-blue-100 transition"
                  >
                    <ArrowUp className="w-4 h-4" />
                    Send
                  </button>
                  <button 
                    onClick={() => handleReceive(wallet.id)}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm bg-green-50 text-green-600 rounded hover:bg-green-100 transition"
                  >
                    <ArrowDown className="w-4 h-4" />
                    Receive
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Recent Transactions</h2>
            {transactions.length === 0 ? (
              <div className="border rounded-lg p-8 text-center text-gray-500">
                <p>No transactions yet</p>
              </div>
            ) : (
              <div className="border rounded-lg divide-y">
                {transactions.slice(0, 10).map((tx) => (
                  <div key={tx.id} className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-full ${tx.type === 'receive' ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'}`}>
                        {tx.type === 'receive' ? <ArrowDown className="w-4 h-4" /> : <ArrowUp className="w-4 h-4" />}
                      </div>
                      <div>
                        <p className="font-medium capitalize">{tx.type} {formatCycles(tx.amount)}</p>
                        <p className="text-sm text-gray-500">
                          {tx.type === 'receive' ? `From ${truncatePrincipal(tx.from || '')}` : `To ${truncatePrincipal(tx.to || '')}`}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-gray-500">{formatTimestamp(tx.timestamp)}</p>
                      <Link href={`/transactions/${tx.id}`} className="text-xs text-blue-500 flex items-center gap-1 hover:underline">
                        View <ExternalLink className="w-3 h-3" />
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {sendModal?.open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">Send Cycles</h3>
            <p className="text-sm text-gray-600 mb-4">Feature coming soon. Use the CLI to send cycles.</p>
            <button 
              onClick={() => setSendModal(null)}
              className="w-full px-4 py-2 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {receiveModal?.open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">Receive Cycles</h3>
            <p className="text-sm text-gray-600 mb-4">Your wallet principal can receive cycles from any ICP wallet.</p>
            <button 
              onClick={() => setReceiveModal(null)}
              className="w-full px-4 py-2 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
