/**
 * Wallet Multi-Send Command
 *
 * CLI command to send transactions across multiple chains in parallel.
 * Part of Phase 5C: Cross-Chain Actions.
 */

import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import type { WalletData, TransactionRequest, ChainType } from '../../src/wallet/types.js';
import { listAgentWallets, getWallet } from '../../src/wallet/wallet-manager.js';
import { createChainDispatcher } from '../../src/wallet/chain-dispatcher.js';
import { createCrossChainAggregator } from '../../src/wallet/cross-chain-aggregator.js';

/**
 * Multi-chain action configuration
 */
interface MultiChainAction {
  walletId: string;
  chain: ChainType;
  request: TransactionRequest;
}

/**
 * Handle multi-send command
 */
export async function handleMultiSend(agentId: string): Promise<void> {
  console.log(chalk.bold('\n💸 Multi-Chain Send\n'));
  console.log(chalk.yellow('[Experimental] This feature is under active development and may change.\n'));

  const walletIds = listAgentWallets(agentId);

  if (walletIds.length === 0) {
    console.log(chalk.yellow('No wallets found for this agent'));
    return;
  }

  const wallets: WalletData[] = [];
  for (const walletId of walletIds) {
    try {
      const wallet = getWallet(agentId, walletId);
      if (wallet) {
        wallets.push(wallet);
      }
    } catch (_error) {
      console.log(chalk.yellow(`Failed to load wallet ${walletId}`));
    }
  }

  if (wallets.length === 0) {
    console.log(chalk.yellow('No wallets could be loaded'));
    return;
  }

  console.log(chalk.cyan(`Found ${wallets.length} wallet(s)\n`));

  for (const wallet of wallets) {
    console.log(chalk.dim(`[${wallet.id} - ${wallet.chain.toUpperCase()}]`));
  }

  console.log();

  const { actionType } = await inquirer.prompt<{ actionType: string }>([
    {
      type: 'list',
      name: 'actionType',
      message: 'What would you like to do?',
      default: 'send-all',
      choices: [
        { name: 'send-all', value: 'send-all' },
        { name: 'send-specific', value: 'send-specific' },
        { name: 'balance-check', value: 'balance-check' },
        { name: 'batch-send', value: 'batch-send' },
      ],
    },
  ]);

  if (actionType === 'balance-check') {
    await checkBalances(wallets);
    return;
  }

  let selectedWallets: WalletData[];

  if (actionType === 'send-specific' || actionType === 'batch-send') {
    const { selectedIds } = await inquirer.prompt<{ selectedIds: string[] }>([
      {
        type: 'checkbox',
        name: 'selectedIds',
        message: 'Select wallets to include:',
        choices: wallets.map((w) => ({ name: w.id, value: w.id, checked: false })),
      },
    ]);

    selectedWallets = wallets.filter((w) => selectedIds.includes(w.id));

    if (selectedWallets.length === 0) {
      console.log(chalk.yellow('No wallets selected'));
      return;
    }
  } else {
    selectedWallets = wallets;
  }

  const { amount } = await inquirer.prompt<{ amount: string }>([
    {
      type: 'input',
      name: 'amount',
      message: 'Amount to send to each wallet:',
      default: '0.01',
    },
  ]);

  const { memo } = await inquirer.prompt<{ memo?: string }>([
    {
      type: 'input',
      name: 'memo',
      message: 'Memo (optional):',
      default: '',
    },
  ]);

  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Send ${selectedWallets.length} transactions (${amount}${memo ? ' + memo' : ''})?`,
      default: false,
    },
  ]);

  if (!confirm) {
    console.log(chalk.yellow('\nMulti-chain send cancelled'));
    return;
  }

  const spinner = ora('Preparing transactions...').start();

  try {
    const actions: MultiChainAction[] = [];

    for (const wallet of selectedWallets) {
      const action: MultiChainAction = {
        walletId: wallet.id,
        chain: wallet.chain,
        request: {
          to: '',
          amount,
          chain: wallet.chain,
        },
      };

      actions.push(action);
    }

    const aggregator = createCrossChainAggregator({
      maxConcurrency: 5,
      continueOnError: false,
    });

    const results = await aggregator.execute(actions);

    spinner.succeed(`Executed ${results.total} actions (${results.succeeded} succeeded, ${results.failed} failed)`);

    console.log();
    console.log(chalk.cyan('Execution Summary:'));
    console.table(
      results.results.map((r) => ({
        Chain: r.action.chain,
        Wallet: r.action.walletId,
        Success: r.success,
        TxHash: r.txHash || 'N/A',
        Error: r.error || 'N/A',
      }))
    );

    console.log();
    console.log(chalk.green('✓ Multi-chain send complete'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Execution failed: ${message}`);
  }
}

/**
 * Check balances across multiple wallets
 */
async function checkBalances(wallets: WalletData[]): Promise<void> {
  console.log(chalk.bold('\n📊 Balance Check\n'));

  const spinner = ora('Checking balances...').start();

  try {
    const dispatcher = createChainDispatcher();
    const balances: Array<{ wallet: WalletData; balance: string; error?: string }> = [];

    for (const wallet of wallets) {
      try {
        const balance = await dispatcher.getBalance(wallet);
        balances.push({
          wallet,
          balance: `${balance.amount} ${balance.denomination}`,
          error: undefined,
        });
    } catch (_error) {
        balances.push({
          wallet,
          balance: '0',
          error: _error instanceof Error ? _error.message : 'Unknown error',
        });
      }
    }

    spinner.succeed('Balance check complete');

    console.log();
    console.log(chalk.cyan('Balance Summary:'));
    console.table(
      balances.map((b) => ({
        Chain: b.wallet.chain,
        Address: b.wallet.address,
        Balance: b.balance,
        Error: b.error || 'N/A',
      }))
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Balance check failed: ${message}`);
  }
}

/**
 * Export handler for use by wallet.ts
 */
export async function handleMultiSendWithArgs(args: { agentId: string }): Promise<void> {
  await handleMultiSend(args.agentId);
}
