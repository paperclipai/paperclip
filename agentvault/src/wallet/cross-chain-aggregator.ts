/**
 * Cross-Chain Aggregator (Phase 5C)
 *
 * Executes multiple blockchain transactions in parallel.
 * Supports independent execution (no atomic rollback) as per user preference.
 */

import type { WalletData, TransactionRequest, Transaction, ChainType } from './types.js';
import { ChainDispatcher } from './chain-dispatcher.js';

/**
 * Multi-chain action
 */
export interface MultiChainAction {
  walletId: string;
  chain: ChainType;
  request: TransactionRequest;
  priority?: 'low' | 'normal' | 'high';
}

/**
 * Cross-chain execution result
 */
export interface CrossChainResult {
  action: MultiChainAction;
  success: boolean;
  txHash?: string;
  error?: string;
  executedAt: number;
  duration?: number;
}

/**
 * Aggregated execution results
 */
export interface AggregatedResults {
  total: number;
  succeeded: number;
  failed: number;
  results: CrossChainResult[];
  duration: number;
}

/**
 * Cross-chain aggregator options
 */
export interface AggregatorOptions {
  maxConcurrency?: number;
  timeout?: number;
  continueOnError?: boolean;
}

/**
 * Cross-chain aggregator
 *
 * Executes transactions across multiple blockchains in parallel.
 * Independent execution: No rollback on partial failure.
 */
export class CrossChainAggregator {
  private dispatcher: ChainDispatcher;
  private options: AggregatorOptions;

  constructor(options?: AggregatorOptions) {
    this.dispatcher = new ChainDispatcher();
    this.options = {
      maxConcurrency: options?.maxConcurrency ?? 5,
      timeout: options?.timeout ?? 30000,
      continueOnError: options?.continueOnError ?? true,
    };
  }

  /**
   * Execute multiple cross-chain actions
   *
   * @param actions - Array of multi-chain actions
   * @returns Aggregated results
   */
  async execute(actions: MultiChainAction[]): Promise<AggregatedResults> {
    const startTime = Date.now();

    if (actions.length === 0) {
      return {
        total: 0,
        succeeded: 0,
        failed: 0,
        results: [],
        duration: 0,
      };
    }

    console.log(`Executing ${actions.length} cross-chain actions...`);

    const results = await this.executeParallel(actions);

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    const duration = Date.now() - startTime;

    console.log(
      `Execution complete: ${succeeded} succeeded, ${failed} failed (${duration}ms)`
    );

    return {
      total: results.length,
      succeeded,
      failed,
      results,
      duration,
    };
  }

  /**
   * Execute actions in parallel with concurrency limit
   */
  private async executeParallel(
    actions: MultiChainAction[]
  ): Promise<CrossChainResult[]> {
    const results: CrossChainResult[] = [];

    const chunks = this.chunkArray(
      actions,
      this.options.maxConcurrency ?? 5
    );

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map((action) => this.executeAction(action))
      );

      results.push(...chunkResults);

      if (!this.options.continueOnError) {
        const hasFailure = chunkResults.some((r) => !r.success);
        if (hasFailure) {
          console.log('Stopping due to failure (continueOnError = false)');
          break;
        }
      }
    }

    return results;
  }

  /**
   * Execute a single cross-chain action
   */
  private async executeAction(
    action: MultiChainAction
  ): Promise<CrossChainResult> {
    const startTime = Date.now();

    try {
      const { getWallet } = await import('./wallet-manager.js');
      const wallet = getWallet('', action.walletId);

      if (!wallet) {
        throw new Error(`Wallet not found: ${action.walletId}`);
      }

      const tx = await this.dispatcher.dispatchTransaction(
        wallet,
        action.request
      );

      const duration = Date.now() - startTime;

      return {
        action,
        success: true,
        txHash: tx.hash,
        executedAt: Date.now(),
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const message = error instanceof Error ? error.message : 'Unknown error';

      return {
        action,
        success: false,
        error: message,
        executedAt: Date.now(),
        duration,
      };
    }
  }

  /**
   * Split array into chunks
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }

    return chunks;
  }

  /**
   * Get balances across multiple chains
   *
   * @param wallets - Array of wallets to query
   * @returns Array of balances
   */
  async getBalances(
    wallets: WalletData[]
  ): Promise<Array<{ wallet: WalletData; amount: string; denomination: string }>> {
    const results = await Promise.all(
      wallets.map(async (wallet) => {
        try {
          const balance = await this.dispatcher.getBalance(wallet);
          return {
            wallet,
            amount: balance.amount,
            denomination: balance.denomination,
            success: true,
          };
        } catch (error) {
          return {
            wallet,
            amount: '0',
            denomination: 'N/A',
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      })
    );

    return results;
  }

  /**
   * Get transaction history across multiple chains
   *
   * @param wallets - Array of wallets to query
   * @param limit - Maximum transactions per wallet
   * @returns Array of transactions
   */
  async getMultiChainHistory(
    wallets: WalletData[],
    limit: number = 20
  ): Promise<Transaction[]> {
    const results = await Promise.all(
      wallets.map(async (wallet) => {
        try {
          return await this.dispatcher.getTransactionHistory(wallet, limit);
        } catch (error) {
          console.error(
            `Failed to get history for ${wallet.id}:`,
            error
          );
          return [];
        }
      })
    );

    return results.flat().slice(0, wallets.length * limit);
  }

  /**
   * Estimate fees across multiple chains
   *
   * @param actions - Array of actions to estimate
   * @returns Array of fee estimates
   */
  async estimateFees(
    actions: MultiChainAction[]
  ): Promise<Array<{ action: MultiChainAction; fee: string }>> {
    const results = await Promise.all(
      actions.map(async (action) => {
        try {
          const { getWallet } = await import('./wallet-manager.js');
          const wallet = getWallet('', action.walletId);

          if (!wallet) {
            throw new Error(`Wallet not found: ${action.walletId}`);
          }

          const fee = await this.dispatcher.estimateFee(wallet, action.request);

          return {
            action,
            fee,
            success: true,
          };
        } catch (error) {
          return {
            action,
            fee: 'N/A',
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      })
    );

    return results;
  }

  /**
   * Create cross-chain batch summary
   *
   * @param results - Aggregated execution results
   * @returns Formatted summary
   */
  createSummary(results: AggregatedResults): string {
    const lines: string[] = [];

    lines.push('Cross-Chain Execution Summary');
    lines.push('============================');
    lines.push(`Total Actions:    ${results.total}`);
    lines.push(`Succeeded:         ${results.succeeded}`);
    lines.push(`Failed:            ${results.failed}`);
    lines.push(`Success Rate:      ${results.total > 0 ? ((results.succeeded / results.total) * 100).toFixed(2) : 0}%`);
    lines.push(`Total Duration:    ${results.duration}ms`);

    if (results.failed > 0) {
      lines.push('');
      lines.push('Failed Actions:');
      results.results
        .filter((r) => !r.success)
        .forEach((r) => {
          lines.push(`  [${r.action.chain}] ${r.action.walletId}`);
          lines.push(`    Error: ${r.error}`);
        });
    }

    return lines.join('\n');
  }
}

/**
 * Create cross-chain aggregator
 *
 * @param options - Aggregator options
 * @returns Cross-chain aggregator instance
 */
export function createCrossChainAggregator(
  options?: AggregatorOptions
): CrossChainAggregator {
  return new CrossChainAggregator(options);
}
