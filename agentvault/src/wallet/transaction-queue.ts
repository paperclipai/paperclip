/**
 * Transaction Queue Processor (Phase 5B)
 *
 * Advanced transaction queue with priority, retries, and scheduling.
 * Handles agent-initiated transactions queued in canister.
 */

import type {
  WalletData,
  TransactionRequest,
  SignedTransaction,
} from './types.js';

/**
 * Transaction action type
 */
export type TransactionAction = 'send_funds' | 'sign_message' | 'deploy_contract';

/**
 * Transaction priority
 */
export type TransactionPriority = 'low' | 'normal' | 'high';

/**
 * Transaction status
 */
export type TransactionStatus = 'pending' | 'queued' | 'signed' | 'completed' | 'failed';

/**
 * Queued transaction from canister
 */
export interface QueuedTransaction {
  id: string;
  action: {
    walletId: string;
    action: TransactionAction;
    parameters: [string, string][];
    priority: TransactionPriority;
    threshold?: number;
  };
  status: TransactionStatus;
  result?: string;
  retryCount: number;
  scheduledAt?: number;
  createdAt: number;
  signedAt?: number;
  completedAt?: number;
  errorMessage?: string;
}

/**
 * Queue statistics
 */
export interface QueueStats {
  total: number;
  pending: number;
  queued: number;
  signed: number;
  completed: number;
  failed: number;
}

/**
 * Process result
 */
export interface ProcessResult {
  transactionId: string;
  success: boolean;
  txHash?: string;
  error?: string;
  processedAt: number;
}

/**
 * Transaction queue processor
 */
export class TransactionQueueProcessor {
  private actor: any;
  private maxRetries: number;

  constructor(_canisterId: string, actor: any, options?: { maxRetries?: number; retryDelay?: number }) {
    this.actor = actor;
    this.maxRetries = options?.maxRetries ?? 3;
  }

  /**
   * Fetch pending transactions from canister
   */
  async fetchPendingTransactions(): Promise<QueuedTransaction[]> {
    try {
      return await this.actor.getPendingTransactions();
    } catch (error) {
      console.error('Failed to fetch pending transactions:', error);
      return [];
    }
  }

  /**
   * Process all pending transactions
   *
   * @param signCallback - Callback to sign transactions
   * @returns Processing results
   */
  async processPendingTransactions(
    signCallback: (wallet: WalletData, action: TransactionRequest) => Promise<SignedTransaction | null>
  ): Promise<ProcessResult[]> {
    const pending = await this.fetchPendingTransactions();
    const results: ProcessResult[] = [];

    for (const tx of pending) {
      const result = await this.processTransaction(tx, signCallback);
      results.push(result);
    }

    return results;
  }

  /**
   * Process a single transaction
   */
  private async processTransaction(
    tx: QueuedTransaction,
    signCallback: (wallet: WalletData, action: TransactionRequest) => Promise<SignedTransaction | null>
  ): Promise<ProcessResult> {
    const { getWallet } = await import('./wallet-manager.js');
    const wallet = getWallet('', tx.action.walletId);

    if (!wallet) {
      await this.markFailed(tx.id, 'Wallet not found');
      return {
        transactionId: tx.id,
        success: false,
        error: 'Wallet not found',
        processedAt: Date.now(),
      };
    }

    try {
      const action = this.mapActionToRequest(tx.action);

      const signed = await signCallback(wallet, action);

      if (!signed) {
        await this.markFailed(tx.id, 'Signing failed');
        return {
          transactionId: tx.id,
          success: false,
          error: 'Signing failed',
          processedAt: Date.now(),
        };
      }

      await this.markSigned(tx.id, signed.signature || '');

      return {
        transactionId: tx.id,
        success: true,
        txHash: signed.txHash,
        processedAt: Date.now(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      if (tx.retryCount < this.maxRetries) {
        await this.actor.retryTransaction(tx.id);
      } else {
        await this.markFailed(tx.id, message);
      }

      return {
        transactionId: tx.id,
        success: false,
        error: message,
        processedAt: Date.now(),
      };
    }
  }

  /**
   * Map canister action to transaction request
   */
  private mapActionToRequest(action: QueuedTransaction['action']): TransactionRequest {
    const params = new Map(action.parameters);

    return {
      to: params.get('to') || '',
      amount: params.get('amount') || '0',
      chain: (params.get('chain') || 'cketh') as any,
      memo: params.get('memo'),
      gasPrice: params.get('gasPrice'),
      gasLimit: params.get('gasLimit'),
    };
  }

  /**
   * Mark transaction as signed in canister
   */
  private async markSigned(txId: string, signature: string): Promise<void> {
    try {
      await this.actor.markTransactionSigned(txId, signature);
    } catch (error) {
      console.error('Failed to mark transaction as signed:', error);
    }
  }

  /**
   * Mark transaction as failed in canister
   */
  private async markFailed(txId: string, error: string): Promise<void> {
    try {
      await this.actor.markTransactionFailed(txId, error);
    } catch (err) {
      console.error('Failed to mark transaction as failed:', err);
    }
  }

  /**
   * Mark transaction as completed in canister
   */
  async markCompleted(txId: string, txHash: string): Promise<void> {
    try {
      await this.actor.markTransactionCompleted(txId, txHash);
    } catch (error) {
      console.error('Failed to mark transaction as completed:', error);
    }
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<QueueStats | null> {
    try {
      return await this.actor.getTransactionQueueStats();
    } catch (error) {
      console.error('Failed to get queue stats:', error);
      return null;
    }
  }

  /**
   * Schedule transaction for future execution
   */
  async scheduleTransaction(txId: string, scheduledAt: Date): Promise<{ success: boolean; error?: string }> {
    try {
      await this.actor.scheduleTransaction(txId, BigInt(scheduledAt.getTime()));
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Clear completed transactions
   */
  async clearCompleted(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.actor.clearCompletedTransactions();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

/**
 * Create transaction queue processor
 *
 * @param canisterId - Canister ID
 * @param actor - Canister actor instance
 * @returns Queue processor instance
 */
export function createQueueProcessor(
  canisterId: string,
  actor: any,
  options?: { maxRetries?: number; retryDelay?: number }
): TransactionQueueProcessor {
  return new TransactionQueueProcessor(canisterId, actor, options);
}
