/**
 * Wallet Sign Command
 *
 * Sign transactions with wallet's private key.
 */

import type { BaseWalletProvider } from '../../src/wallet/providers/base-provider.js';
import { createWalletProvider, getWallet, listAgentWallets } from '../../src/wallet/index.js';
import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Format address for display
 */
function formatAddress(address: string, length = 10): string {
  if (address.length <= length * 2) return address;
  return `${address.slice(0, length)}...${address.slice(-length)}`;
}

/**
 * Create provider for chain
 */
function createProvider(chain: string): BaseWalletProvider {
  return createWalletProvider(chain, { isTestnet: false });
}

/**
 * Display signed transaction
 */
function displaySignedTransaction(signedTx: any, chain: string): void {
  console.log();
  console.log(chalk.cyan('Signed Transaction:'));
  console.log(`  Chain:       ${chain.toUpperCase()}`);
  console.log(`  Hash:        ${signedTx.txHash}`);
  console.log(`  Signature:   ${signedTx.signature || 'Included in tx'}`);
  console.log(`  Recipient:   ${formatAddress(signedTx.request.to)}`);
  console.log(`  Amount:      ${signedTx.request.amount}`);
}

/**
 * Save signed transaction to file
 */
function saveSignedTransaction(
  signedTx: any,
  agentId: string,
  chain: string
): string {
  const outputDir = path.join(process.cwd(), '.agentvault', 'signed-txs');

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = Date.now();
  const filename = `signed-tx-${agentId}-${chain}-${timestamp}.json`;
  const filepath = path.join(outputDir, filename);

  const data = JSON.stringify(signedTx, null, 2);
  fs.writeFileSync(filepath, data, 'utf-8');

  return filepath;
}

/**
 * Handle wallet sign command
 */
export async function handleSign(agentId: string, options: { output?: string; json?: boolean } = {}): Promise<void> {
  console.log(chalk.bold('\n✍️  Sign Transaction\n'));

  const wallets = listAgentWallets(agentId);

  if (wallets.length === 0) {
    console.log(chalk.yellow('No wallets found for this agent'));
    return;
  }

  const { walletId } = await inquirer.prompt<{ walletId: string }>([
    {
      type: 'list',
      name: 'walletId',
      message: 'Select wallet to sign with:',
      choices: wallets,
    },
  ]);

  const wallet = getWallet(agentId, walletId);

  if (!wallet) {
    console.log(chalk.red('Wallet not found'));
    return;
  }

  const chain = wallet.chain;

  const txDetails: any = await inquirer.prompt([
    {
      type: 'input',
      name: 'to',
      message: 'Recipient address:',
      validate: (input: string) => input.length > 0,
    },
    {
      type: 'input',
      name: 'amount',
      message: 'Amount to send:',
      validate: (input: string) => parseFloat(input) > 0,
    },
  ]);

  if (chain === 'cketh' || chain === 'polkadot') {
    const gasDetails = await inquirer.prompt([
      {
        type: 'input',
        name: 'gasPrice',
        message: 'Gas price (optional, leave empty for auto):',
        default: '',
      },
      {
        type: 'input',
        name: 'gasLimit',
        message: 'Gas limit (optional, leave empty for auto):',
        default: '',
      },
    ]);

    if (gasDetails.gasPrice) txDetails.gasPrice = gasDetails.gasPrice;
    if (gasDetails.gasLimit) txDetails.gasLimit = gasDetails.gasLimit;
  } else if (chain === 'solana') {
    const { memo } = await inquirer.prompt([
      {
        type: 'input',
        name: 'memo',
        message: 'Memo (optional):',
        default: '',
      },
    ]);

    if (memo) txDetails.memo = memo;
  }

  const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Sign transaction to send ${txDetails.amount} to ${formatAddress(txDetails.to)}?`,
      default: false,
    },
  ]);

  if (!confirm) {
    console.log(chalk.yellow('\nTransaction signing cancelled'));
    return;
  }

  const spinner = ora('Signing transaction...').start();

  try {
    const provider = createProvider(chain);
    await provider.connect();

    if (!wallet.privateKey) {
      throw new Error('Wallet has no private key available for signing');
    }

    const txRequest = {
      to: txDetails.to,
      amount: txDetails.amount,
      chain: chain as any,
      ...(txDetails.gasPrice && { gasPrice: txDetails.gasPrice }),
      ...(txDetails.gasLimit && { gasLimit: txDetails.gasLimit }),
      ...(txDetails.memo && { memo: txDetails.memo }),
    };

    const signedTx = await provider.signTransaction(txRequest, wallet.privateKey);

    spinner.succeed('Transaction signed');

    if (options.json) {
      console.log(JSON.stringify(signedTx, null, 2));
    } else {
      displaySignedTransaction(signedTx, chain);
    }

    if (options.output || await shouldSaveFile()) {
      const filepath = saveSignedTransaction(signedTx, agentId, chain);
      console.log();
      console.log(chalk.green('✓'), `Signed transaction saved to: ${filepath}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Failed to sign transaction: ${message}`);
  }
}

/**
 * Prompt user to save file
 */
async function shouldSaveFile(): Promise<boolean> {
  const { save } = await inquirer.prompt<{ save: boolean }>([
    {
      type: 'confirm',
      name: 'save',
      message: 'Save signed transaction to file?',
      default: true,
    },
  ]);

  return save;
}
