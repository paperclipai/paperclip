'use client'

import { ExternalLink, ArrowUp, ArrowDown } from 'lucide-react'
import { Transaction } from '@/lib/types'
import { formatCycles, formatTimestamp } from '@/lib/utils'

interface TransactionHistoryProps {
  transactions: Transaction[]
  emptyMessage?: string
  onViewDetails?: (txId: string) => void
}

export function TransactionHistory({ transactions, emptyMessage = 'No transactions yet', onViewDetails }: TransactionHistoryProps) {
  return (
    <div className="border rounded-lg divide-y">
      <div className="flex items-center justify-between p-4 bg-gray-50">
        <span className="font-semibold">Transaction History ({transactions.length})</span>
        <div className="flex items-center gap-2 text-sm text-blue-600 cursor-pointer hover:underline">
          <ExternalLink className="w-4 h-4" />
          <span>View all on explorer</span>
        </div>
      </div>

      {transactions.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          {emptyMessage}
        </div>
      ) : (
        <div className="divide-y">
          {transactions.map((tx) => (
            <div
              key={tx.id}
              onClick={() => onViewDetails?.(tx.id)}
              className="p-4 hover:bg-gray-50 cursor-pointer transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${tx.type === 'send' ? 'bg-red-50' : 'bg-green-50'}`}>
                    {tx.type === 'send' ? (
                      <ArrowUp className="w-4 h-4 text-red-500" />
                    ) : (
                      <ArrowDown className="w-4 h-4 text-green-500" />
                    )}
                  </div>
                  <div>
                    <span className="font-medium capitalize">{tx.type}</span>
                    <p className="text-sm text-gray-600">
                      {formatCycles(tx.amount)}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm text-gray-600">
                    {tx.type === 'send' && tx.to ? `To: ${tx.to.slice(0, 8)}...` : ''}
                    {tx.type === 'receive' && tx.from ? `From: ${tx.from.slice(0, 8)}...` : ''}
                  </p>
                  <p className="text-xs text-gray-500">
                    {formatTimestamp(tx.timestamp)}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
