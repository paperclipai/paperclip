/**
 * Deploy command - Deploy agent WASM to ICP canister
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import * as path from 'node:path';
import {
  deployAgent,
  getDeploySummary,
  type DeployOptions,
  type DeployResult,
  type NetworkType,
} from '../../src/deployment/index.js';

export interface DeployCommandOptions {
  network?: NetworkType;
  canisterId?: string;
  yes?: boolean;
  dryRun?: boolean;
  env?: string;
  identity?: string;
  cycles?: string;
  mode?: 'auto' | 'install' | 'reinstall' | 'upgrade';
}

/**
 * Format cycles for display
 */
function formatCycles(cycles: bigint): string {
  if (cycles >= BigInt(1_000_000_000_000)) {
    return `${(Number(cycles) / 1_000_000_000_000).toFixed(2)} T`;
  }
  if (cycles >= BigInt(1_000_000_000)) {
    return `${(Number(cycles) / 1_000_000_000).toFixed(2)} B`;
  }
  if (cycles >= BigInt(1_000_000)) {
    return `${(Number(cycles) / 1_000_000).toFixed(2)} M`;
  }
  return `${cycles.toString()}`;
}

/**
 * Format file size for display
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Display deployment preview (dry-run)
 */
export function displayPreview(wasmPath: string, options: DeployCommandOptions): void {
  const summary = getDeploySummary({
    wasmPath: path.resolve(wasmPath),
    network: options.network ?? 'local',
    canisterId: options.canisterId,
    skipConfirmation: options.yes,
  });

  console.log(chalk.bold('\nDeployment Preview\n'));
  console.log(chalk.cyan('Agent:'));
  console.log(`  Name:      ${chalk.bold(summary.agentName)}`);
  console.log(`  WASM:      ${summary.wasmPath}`);
  console.log(`  Size:      ${formatSize(summary.wasmSize)}`);
  if (summary.wasmHash) {
    console.log(`  Hash:      ${summary.wasmHash.substring(0, 16)}...`);
  }

  console.log();
  console.log(chalk.cyan('Target:'));
  console.log(`  Network:   ${chalk.bold(summary.network)}`);
  console.log(`  Operation: ${summary.isUpgrade ? chalk.yellow('Upgrade') : chalk.green('New Deploy')}`);
  if (summary.canisterId) {
    console.log(`  Canister:  ${summary.canisterId}`);
  }

  console.log();

  if (summary.validation.warnings.length > 0) {
    console.log(chalk.yellow('Warnings:'));
    for (const warning of summary.validation.warnings) {
      console.log(chalk.yellow(`  ⚠ ${warning}`));
    }
    console.log();
  }

  if (summary.validation.errors.length > 0) {
    console.log(chalk.red('Errors:'));
    for (const error of summary.validation.errors) {
      console.log(chalk.red(`  ✖ ${error.message}`));
    }
    console.log();
  }
}

/**
 * Display deployment result
 */
export function displayResult(result: DeployResult): void {
  console.log();
  console.log(chalk.green('✓'), 'Agent deployed successfully!');
  console.log();
  console.log(chalk.cyan('Canister Info:'));
  console.log(`  Canister ID: ${chalk.bold(result.canister.canisterId)}`);
  console.log(`  Network:     ${result.canister.network}`);
  console.log(`  Agent:       ${result.canister.agentName}`);
  console.log(`  Deployed:    ${result.canister.deployedAt.toISOString()}`);
  if (result.canister.wasmHash) {
    console.log(`  WASM Hash:   ${result.canister.wasmHash.substring(0, 16)}...`);
  }
  if (result.cyclesUsed) {
    console.log(`  Cycles Used: ${formatCycles(result.cyclesUsed)}`);
  }
  if (result.deployTool) {
    console.log(`  Deploy Tool: ${result.deployTool}`);
  }

  if (result.warnings.length > 0) {
    console.log();
    console.log(chalk.yellow('Warnings:'));
    for (const warning of result.warnings) {
      console.log(chalk.yellow(`  ⚠ ${warning}`));
    }
  }

  console.log();
  console.log(chalk.cyan('Next steps:'));
  if (result.canister.network === 'local') {
    console.log('  1. Test your agent locally with dfx');
    console.log('  2. Deploy to IC mainnet with', chalk.bold('--network ic'));
  } else {
    console.log('  1. Interact with your canister at:');
    console.log(`     ${chalk.bold(`https://${result.canister.canisterId}.ic0.app`)}`);
    console.log('  2. Monitor cycles balance with', chalk.bold('dfx canister status'));
  }
}

/**
 * Prompt for deployment confirmation
 */
async function confirmDeployment(
  network: NetworkType,
  isUpgrade: boolean
): Promise<boolean> {
  const action = isUpgrade ? 'upgrade' : 'deploy';
  const networkLabel = network === 'ic' ? 'IC mainnet' : 'local network';

  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: 'confirm',
      name: 'confirmed',
      message: `${action.charAt(0).toUpperCase() + action.slice(1)} to ${networkLabel}?`,
      default: network === 'local',
    },
  ]);

  return confirmed;
}

/**
 * Execute the deploy command
 */
export async function executeDeploy(
  wasmPath: string,
  options: DeployCommandOptions
): Promise<DeployResult | null> {
  const resolvedPath = path.resolve(wasmPath);
  const network = options.network ?? 'local';

  // Handle dry-run mode
  if (options.dryRun) {
    displayPreview(resolvedPath, options);
    return null;
  }

  // Confirm deployment unless --yes flag
  if (!options.yes) {
    const confirmed = await confirmDeployment(network, !!options.canisterId);
    if (!confirmed) {
      console.log(chalk.yellow('\nDeployment cancelled.'));
      return null;
    }
  }

  const spinner = ora('Deploying agent to ICP...').start();

  try {
    // Prepare deploy options
    const deployOptions: DeployOptions = {
      wasmPath: resolvedPath,
      network,
      canisterId: options.canisterId,
      skipConfirmation: options.yes,
      environment: options.env,
      identity: options.identity,
      cycles: options.cycles,
      mode: options.mode,
    };

    // Execute deployment
    const result = await deployAgent(deployOptions);

    const action = result.isUpgrade ? 'upgraded' : 'deployed';
    spinner.succeed(`Agent '${result.canister.agentName}' ${action} successfully!`);
    displayResult(result);

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Deployment failed: ${message}`);
    throw error;
  }
}

/**
 * Create the deploy command
 */
export function deployCommand(): Command {
  const command = new Command('deploy');

  command
    .description('Deploy agent WASM to ICP canister')
    .argument('<wasm>', 'path to compiled WASM file')
    .option('-n, --network <network>', 'target network (local or ic)', 'local')
    .option('-e, --env <environment>', 'named environment from icp.yaml (e.g. dev, staging, production)')
    .option('-c, --canister-id <id>', 'existing canister ID (for upgrades)')
    .option('-y, --yes', 'skip confirmation prompts')
    .option('--dry-run', 'show what would be deployed without executing')
    .option('--identity <name>', 'identity name for icp-cli')
    .option('--cycles <amount>', 'cycles allocation (e.g. 100T)')
    .option('--mode <mode>', 'deploy mode: auto, install, reinstall, upgrade')
    .action(async (wasm: string, options: DeployCommandOptions) => {
      console.log(chalk.bold('\n🚀 AgentVault Deploy\n'));

      try {
        await executeDeploy(wasm, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(chalk.red(`\nError: ${message}`));
        process.exit(1);
      }
    });

  return command;
}
