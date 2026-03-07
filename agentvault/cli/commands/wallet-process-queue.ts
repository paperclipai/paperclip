/**
 * Wallet Process Queue Command (Phase 5B/5D)
 *
 * CLI command to process pending transactions from canister queue.
 * Part of Phase 5B: Agent-Initiated Transactions.
 * Phase 5D: VetKeys threshold signing support.
 */

import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import type { SignedTransaction, TransactionRequest } from '../../src/wallet/types.js';
import { createWalletProvider } from '../../src/wallet/index.js';
import type { QueuedTransaction } from '../../src/wallet/transaction-queue.js';

/**
 * Handle process-queue command
 */
export async function handleProcessQueue(agentId: string, canisterId: string): Promise<void> {
  console.log(chalk.bold('\n🔄 Process Transaction Queue\n'));
  console.log(chalk.yellow('[Experimental] This feature is under active development and may change.\n'));

  const { createActor, createAnonymousAgent } = await import('../../src/canister/actor.js');

  const spinner = ora('Connecting to canister...').start();

  try {
    const agent = createAnonymousAgent();
    const actor = createActor(canisterId, agent);

    spinner.succeed('Connected to canister');

    const stats = await actor.getTransactionQueueStats();

    if (stats.total === 0) {
      console.log(chalk.yellow('No transactions in queue'));
      return;
    }

    console.log();
    console.log(chalk.cyan('Queue Statistics:'));
    console.log(`  Total:     ${stats.total}`);
    console.log(`  Pending:   ${stats.pending}`);
    console.log(`  Queued:    ${stats.queued}`);
    console.log(`  Signed:     ${stats.signed}`);
    console.log(`  Completed:  ${stats.completed}`);
    console.log(`  Failed:     ${stats.failed}`);
    console.log();

    const pending = await actor.getPendingTransactions();

    if (pending.length === 0) {
      console.log(chalk.yellow('No pending transactions to process'));
      return;
    }

    console.log(chalk.cyan(`Found ${pending.length} pending transaction(s)\n`));

    const { processAll } = await inquirer.prompt<{ processAll: boolean }>([
      {
        type: 'confirm',
        name: 'processAll',
        message: `Process all ${pending.length} pending transactions?`,
        default: false,
      },
    ]);

    if (!processAll) {
      console.log(chalk.yellow('\nProcessing cancelled'));
      return;
    }

    spinner.start('Processing transactions...');

    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const tx of pending) {
      const result = await processTransaction(tx, agentId, actor);

      processed++;
      if (result.success) {
        succeeded++;
        spinner.text = `Processed ${processed}/${pending.length} transactions...`;
      } else {
        failed++;
        spinner.warn(`Transaction ${tx.id} failed: ${result.error}`);
      }
    }

    spinner.succeed(`Processed ${processed} transactions (${succeeded} succeeded, ${failed} failed)`);

    console.log();
    console.log(chalk.green('✓ Queue processing complete'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Processing failed: ${message}`);
  }
}

/**
 * Process a single transaction with VetKeys threshold signing
 */
async function processTransaction(
  tx: QueuedTransaction,
  agentId: string,
  actor: any
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const { getWallet } = await import('../../src/wallet/wallet-manager.js');
    const wallet = getWallet(agentId, tx.action.walletId);

    if (!wallet) {
      await actor.markTransactionFailed(tx.id, 'Wallet not found');
      return { success: false, error: 'Wallet not found' };
    }

    const action = mapActionToRequest(tx.action);

    // Phase 5D: VetKeys threshold signing for transactions with threshold > 1
    const threshold = tx.action.threshold ? Number(tx.action.threshold) : 1;

    if (threshold > 1) {
      console.log(chalk.yellow(`Transaction ${tx.id} requires threshold signatures (${threshold} of ${tx.action.threshold ? Number(tx.action.threshold) : 3})...`));

      const { createVetKeysAdapter } = await import('../../src/wallet/vetkeys-adapter.js');
      const vetKeys = createVetKeysAdapter({
        threshold: threshold,
        totalParties: 3,
        encryptionAlgorithm: 'aes-256-gcm',
      });

      const thresholdResult = await vetKeys.initiateThresholdSignature(
        tx.id,
        wallet,
        action
      );

      if (!thresholdResult.success) {
        await actor.markTransactionFailed(tx.id, thresholdResult.error);
        return {
          success: false,
          error: thresholdResult.error,
        };
      }

      await actor.markTransactionSigned(tx.id, thresholdResult.signature || '');

      console.log(chalk.green(`✓ Threshold signature completed for ${tx.id}`));

      return {
        success: true,
      txHash: 'threshold-signed',
      };
    } else {
      // Normal signing (threshold = 1)
      const signed = await signTransaction(wallet, action);

      if (!signed) {
        await actor.markTransactionFailed(tx.id, 'Signing failed');
        return { success: false, error: 'Signing failed' };
      }

      await actor.markTransactionSigned(tx.id, signed.signature || '');

      const provider = createProvider(wallet.chain);

      const txResult = await provider.sendTransaction(wallet.address, action);

      await actor.markTransactionCompleted(tx.id, txResult.hash);

      return {
        success: true,
        txHash: txResult.hash,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    await actor.markTransactionFailed(tx.id, message);

    return {
      success: false,
      error: message,
    };
  }
}

/**
 * Map canister action to transaction request
 */
function mapActionToRequest(action: QueuedTransaction['action']): TransactionRequest {
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
 * Sign transaction with wallet
 */
async function signTransaction(
  wallet: any,
  action: TransactionRequest
): Promise<SignedTransaction | null> {
  try {
    const provider = createProvider(wallet.chain);

    const signed = await provider.signTransaction(
      {
        to: action.to,
        amount: action.amount,
        chain: action.chain,
      },
      wallet.privateKey
    );

    return signed;
  } catch (error) {
    console.error('Failed to sign transaction:', error);
    return null;
  }
}

/**
 * Create blockchain provider
 */
function createProvider(chain: string): any {
  return createWalletProvider(chain, { isTestnet: false });
}

/**
 * Export handler for use by wallet.ts
 */
export async function handleProcessQueueWithArgs(args: { agentId: string; canisterId: string }): Promise<void> {
  await handleProcessQueue(args.agentId, args.canisterId);
}
