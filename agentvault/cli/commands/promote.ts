/**
 * Promote CLI command
 *
 * Provides commands for promoting canisters between environments
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { promoteCanister, getLatestDeployment, getAllDeployments } from '../../src/deployment/promotion.js';

export const promoteCmd = new Command('promote');

promoteCmd
  .description('Promote canisters between environments')
  .argument('<agent-name>', 'Agent name to promote')
  .option('-f, --from <env>', 'Source environment')
  .option('-t, --to <env>', 'Target environment')
  .option('--target-canister <id>', 'Target canister ID (optional)')
  .option('--blue-green', 'Enable blue-green deployment', false)
  .option('-w, --wasm-path <path>', 'Path to WASM file for actual deployment')
  .option('--skip-deploy', 'Skip actual deploy, only update history')
  .action(async (agentName, options) => {
    if (!options.from) {
      console.error(chalk.red('Error: --from is required'));
      process.exit(1);
    }
    if (!options.to) {
      console.error(chalk.red('Error: --to is required'));
      process.exit(1);
    }

    const spinner = ora(`Promoting ${agentName} from ${options.from} to ${options.to}...`).start();

    try {
      const sourceDeployment = getLatestDeployment(agentName, options.from);
      if (!sourceDeployment) {
        spinner.fail(chalk.red(`No deployment found for ${agentName} in ${options.from}`));
        process.exit(1);
      }

      console.log(chalk.gray(`\nSource deployment:`));
      console.log(chalk.gray(`  Environment: ${sourceDeployment.environment}`));
      console.log(chalk.gray(`  Canister ID: ${sourceDeployment.canisterId}`));
      console.log(chalk.gray(`  WASM Hash: ${sourceDeployment.wasmHash}`));
      console.log(chalk.gray(`  Version: ${sourceDeployment.version}`));
      console.log(chalk.gray(`  Deployed: ${sourceDeployment.timestamp.toISOString()}`));
      console.log();

      const result = await promoteCanister(agentName, options.from, options.to, {
        targetCanisterId: options.targetCanister,
        blueGreen: options.blueGreen,
        wasmPath: options.wasmPath,
        skipDeploy: options.skipDeploy,
      });

      spinner.succeed(chalk.green(`Promoted ${agentName} from ${options.from} to ${options.to}`));

      console.log(chalk.bold('\nNew deployment:'));
      console.log(chalk.gray(`  Environment: ${result.environment}`));
      console.log(chalk.gray(`  Canister ID: ${result.canisterId}`));
      console.log(chalk.gray(`  WASM Hash: ${result.wasmHash}`));
      console.log(chalk.gray(`  Version: ${result.version}`));
      console.log(chalk.gray(`  Deployed: ${result.timestamp.toISOString()}`));

      if (options.blueGreen) {
        console.log(chalk.yellow('\nNote: Blue-green deployment enabled. You may need to manually switch traffic to the new canister.'));
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to promote canister'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

promoteCmd
  .command('list')
  .description('List deployment history for an agent')
  .argument('<agent-name>', 'Agent name')
  .action(async (agentName) => {
    const deployments = getAllDeployments(agentName);
    
    if (deployments.length === 0) {
      console.log(chalk.yellow(`No deployments found for ${agentName}`));
      return;
    }

    console.log(chalk.bold(`Deployment history for ${agentName}:`));
    console.log();

    for (const deployment of deployments) {
      const statusColor = deployment.success ? chalk.green : chalk.red;
      console.log(`${statusColor(deployment.success ? '✓' : '✗')} Version ${deployment.version}`);
      console.log(chalk.gray(`  Environment: ${deployment.environment}`));
      console.log(chalk.gray(`  Canister ID: ${deployment.canisterId}`));
      console.log(chalk.gray(`  WASM Hash: ${deployment.wasmHash}`));
      console.log(chalk.gray(`  Timestamp: ${deployment.timestamp.toISOString()}`));
      console.log();
    }
  });
