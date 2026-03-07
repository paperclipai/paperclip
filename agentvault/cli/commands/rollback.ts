/**
 * Rollback CLI command
 *
 * Provides commands for rolling back canisters to previous versions
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  getDeploymentForRollback,
  getDeploymentsByTimeRange,
  getAllDeployments,
} from '../../src/deployment/promotion.js';
import { deploy } from '../../src/icp/icpcli.js';

export const rollbackCmd = new Command('rollback');

rollbackCmd
  .description('Rollback canisters to previous versions')
  .argument('<agent-name>', 'Agent name to rollback')
  .option('-e, --env <env>', 'Environment to rollback', 'production')
  .option('-v, --version <version>', 'Version to rollback to')
  .option('-t, --to <timestamp>', 'Rollback to timestamp')
  .option('--dry-run', 'Show what would be rolled back without executing', false)
  .action(async (agentName, options) => {
    if (!options.version && !options.to) {
      console.error(chalk.red('Error: --version or --to is required'));
      process.exit(1);
    }

    const spinner = ora(`Finding deployment to rollback...`).start();

    try {
      let targetDeployment;
      
      if (options.version) {
        const version = parseInt(options.version, 10);
        targetDeployment = getDeploymentForRollback(agentName, options.env, version);
        
        if (!targetDeployment) {
          spinner.fail(chalk.red(`Version ${version} not found for ${agentName} in ${options.env}`));
          process.exit(1);
        }
      } else {
        const toTimestamp = new Date(options.to);
        const fromTimestamp = new Date(toTimestamp.getTime() - 30 * 24 * 60 * 60 * 1000);
        const deployments = getDeploymentsByTimeRange(agentName, options.env, fromTimestamp, toTimestamp);
        
        if (deployments.length === 0) {
          spinner.fail(chalk.red(`No deployments found for ${agentName} in ${options.env} before ${options.to}`));
          process.exit(1);
        }
        
        targetDeployment = deployments[0];
      }

      if (!targetDeployment) {
        spinner.fail(chalk.red('No deployment found'));
        process.exit(1);
      }

      spinner.succeed(chalk.green('Found deployment to rollback to'));

      console.log(chalk.bold('\nTarget deployment:'));
      console.log(chalk.gray(`  Environment: ${targetDeployment.environment}`));
      console.log(chalk.gray(`  Canister ID: ${targetDeployment.canisterId}`));
      console.log(chalk.gray(`  WASM Hash: ${targetDeployment.wasmHash}`));
      console.log(chalk.gray(`  Version: ${targetDeployment.version}`));
      console.log(chalk.gray(`  Timestamp: ${targetDeployment.timestamp.toISOString()}`));
      console.log();

      if (options.dryRun) {
        console.log(chalk.yellow('Dry run: No changes will be made'));
        console.log(chalk.gray(`To perform the rollback, run without --dry-run`));
        return;
      }

      const confirmSpinner = ora(`Rolling back ${agentName} to version ${targetDeployment.version}...`).start();
      
      const result = await deploy({
        environment: options.env,
        projectRoot: process.cwd(),
      });

      if (!result.success) {
        confirmSpinner.fail(chalk.red('Rollback failed'));
        console.error(chalk.red(result.stderr));
        process.exit(1);
      }

      confirmSpinner.succeed(chalk.green(`Rolled back ${agentName} to version ${targetDeployment.version}`));
      console.log(result.stdout);
    } catch (error) {
      spinner.fail(chalk.red('Failed to rollback'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

rollbackCmd
  .command('list')
  .description('List available rollback versions')
  .argument('<agent-name>', 'Agent name')
  .option('-e, --env <env>', 'Environment to list versions for', 'production')
  .action(async (agentName, options) => {
    const deployments = getAllDeployments(agentName);
    const envDeployments = deployments
      .filter((d) => d.environment === options.env && d.success)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    
    if (envDeployments.length === 0) {
      console.log(chalk.yellow(`No deployments found for ${agentName} in ${options.env}`));
      return;
    }

    console.log(chalk.bold(`Available rollback versions for ${agentName} (${options.env}):`));
    console.log();

    for (const deployment of envDeployments) {
      const relativeTime = formatRelativeTime(deployment.timestamp);
      console.log(`${chalk.gray('→')} Version ${deployment.version} ${chalk.gray(`(${relativeTime})`)}`);
      console.log(chalk.gray(`    Canister: ${deployment.canisterId}`));
      console.log(chalk.gray(`    WASM: ${deployment.wasmHash.substring(0, 16)}...`));
      console.log();
    }
  });

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}
