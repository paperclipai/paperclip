/**
 * Wallet History Command
 *
 * Display transaction history for a wallet.
 */

import type { BaseWalletProvider } from '../../src/wallet/providers/base-provider.js';
import { createWalletProvider, getWallet, listAgentWallets } from '../../src/wallet/index.js';
import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';

/**
 * Format address for display
 */
function formatAddress(address: string, length = 8): string {
  if (address.length <= length * 2) return address;
  return `${address.slice(0, length)}...${address.slice(-length)}`;
}



/**
 * Get status color
 */
function getStatusColor(status: string): string {
  switch (status) {
    case 'confirmed':
      return chalk.green(status);
    case 'pending':
      return chalk.yellow(status);
    case 'failed':
      return chalk.red(status);
    default:
      return chalk.white(status);
  }
}

/**
 * Create provider for chain
 */
function createProvider(chain: string): BaseWalletProvider {
  return createWalletProvider(chain, { isTestnet: false });
}

/**
 * Display transaction history
 */
function displayTransactions(transactions: any[]): void {
  if (transactions.length === 0) {
    console.log(chalk.yellow('No transactions found'));
    return;
  }

  console.log();
  console.log(chalk.cyan(`Transaction History (${transactions.length} transactions):\n`));

  const table: any[] = [];

  for (const tx of transactions) {
    table.push({
      Hash: formatAddress(tx.hash),
      From: formatAddress(tx.from),
      To: formatAddress(tx.to),
      Amount: `${tx.amount}`,
      Status: getStatusColor(tx.status),
      Fee: tx.fee || 'N/A',
    });
  }

  console.table(table);
}

/**
 * Handle wallet history command
 */
export async function handleHistory(agentId: string, json = false): Promise<void> {
  console.log(chalk.bold('\n📜 Wallet History\n'));

  const wallets = listAgentWallets(agentId);

  if (wallets.length === 0) {
    console.log(chalk.yellow('No wallets found for this agent'));
    return;
  }

  const { walletId } = await inquirer.prompt<{ walletId: string }>([
    {
      type: 'list',
      name: 'walletId',
      message: 'Select wallet:',
      choices: wallets,
    },
  ]);

  const wallet = getWallet(agentId, walletId);

  if (!wallet) {
    console.log(chalk.red('Wallet not found'));
    return;
  }

  const spinner = ora('Fetching transaction history...').start();

  try {
    const provider = createProvider(wallet.chain);
    await provider.connect();

    const transactions = await provider.getTransactionHistory(wallet.address);

    spinner.succeed('Transaction history fetched');

    if (json) {
      console.log(JSON.stringify(transactions, null, 2));
    } else {
      displayTransactions(transactions);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Failed to fetch history: ${message}`);
  }
}
