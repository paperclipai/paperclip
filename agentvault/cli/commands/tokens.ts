/**
 * Tokens Command
 *
 * Manage ICP and ICRC-1/ICRC-2 tokens.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  checkBalance,
  transferTokens,
} from '../../src/icp/tokens.js';

export function tokensCommand(): Command {
  const command = new Command('tokens');

  command
    .description('Manage ICP and ICRC-1/ICRC-2 tokens')
    .action(() => {
      command.outputHelp();
    })
    .addCommand(balanceSubcommand())
    .addCommand(transferSubcommand());

  return command;
}

async function executeBalance(options: any): Promise<void> {
  const { canister } = options;

  const spinner = ora(`Checking token balance for ${canister}...`).start();

  try {
    const result = await checkBalance(canister);
    spinner.succeed(`Token balance checked for ${canister}`);
    console.log();
    console.log(chalk.cyan('Balance:'), result.stdout || 'N/A');
  } catch (error) {
    spinner.fail(`Failed to check balance: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

async function executeTransfer(options: any): Promise<void> {
  const { amount, to } = options;

  const spinner = ora(`Transferring ${amount} tokens to ${to}...`).start();

  try {
    const result = await transferTokens(amount, to);
    spinner.succeed(`${amount} tokens transferred successfully to ${to}`);
    console.log();
    console.log(chalk.cyan('Result:'), result.stdout || 'N/A');
  } catch (error) {
    spinner.fail(`Failed to transfer tokens: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

function balanceSubcommand(): Command {
  return new Command('balance')
    .description('Check token balance')
    .option('-c, --canister <canister-id>', 'Token canister ID')
    .action(executeBalance);
}

function transferSubcommand(): Command {
  return new Command('transfer')
    .description('Transfer tokens to a recipient')
    .argument('<amount>', 'Amount to transfer')
    .argument('<to>', 'Recipient principal or account')
    .action(executeTransfer);
}
