/**
 * Cycles Command
 *
 * Manage ICP cycles for canisters.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  checkBalance,
  mintCycles,
  transferCycles,
} from '../../src/icp/cycles.js';

export function cyclesCommand(): Command {
  const command = new Command('cycles');

  command
    .description('Manage ICP cycles')
    .action(() => {
      command.outputHelp();
    })
    .addCommand(balanceSubcommand())
    .addCommand(mintSubcommand())
    .addCommand(transferSubcommand());

  return command;
}

async function executeBalance(options: any): Promise<void> {
  const { canister } = options;

  const spinner = ora(`Checking cycles balance for ${canister}...`).start();

  try {
    const result = await checkBalance(canister);
    spinner.succeed(`Cycles balance checked for ${canister}`);
    console.log();
    console.log(chalk.cyan('Balance:'), result.stdout || 'N/A');
  } catch (error) {
    spinner.fail(`Failed to check balance: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

async function executeMint(options: any): Promise<void> {
  const { amount } = options;

  const spinner = ora(`Minting ${amount} cycles...`).start();

  try {
    const result = await mintCycles(amount);
    spinner.succeed(`${amount} cycles minted successfully`);
    console.log();
    console.log(chalk.cyan('Result:'), result.stdout || 'N/A');
  } catch (error) {
    spinner.fail(`Failed to mint cycles: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

async function executeTransfer(options: any): Promise<void> {
  const { amount, to } = options;

  const spinner = ora(`Transferring ${amount} cycles to ${to}...`).start();

  try {
    const result = await transferCycles(amount, to);
    spinner.succeed(`${amount} cycles transferred successfully to ${to}`);
    console.log();
    console.log(chalk.cyan('Result:'), result.stdout || 'N/A');
  } catch (error) {
    spinner.fail(`Failed to transfer cycles: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}

function balanceSubcommand(): Command {
  return new Command('balance')
    .description('Check cycles balance of a canister')
    .option('-c, --canister <canister-id>', 'Canister ID to check')
    .action(executeBalance);
}

function mintSubcommand(): Command {
  return new Command('mint')
    .description('Mint cycles to a canister')
    .argument('<amount>', 'Amount to mint')
    .action(executeMint);
}

function transferSubcommand(): Command {
  return new Command('transfer')
    .description('Transfer cycles to a canister')
    .argument('<amount>', 'Amount to transfer')
    .argument('<to>', 'Recipient canister ID or principal')
    .action(executeTransfer);
}
