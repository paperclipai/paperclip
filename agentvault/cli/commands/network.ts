/**
 * Network management CLI commands
 *
 * Provides commands for managing local ICP networks:
 * - create: Create a new network configuration
 * - start: Start a local network
 * - stop: Stop a running network
 * - status: Get network status
 * - list: List all networks
 * - ping: Check network connectivity
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  networkStart,
  networkStop,
  networkStatus,
  networkList,
  networkPing,
} from '../../src/icp/icpcli.js';
import {
  createNetworkConfig,
  getNetworkConfig,
  listNetworkConfigs,
  setNetworkStatus,
} from '../../src/network/network-config.js';

export const networkCmd = new Command('network');

networkCmd
  .description('Manage ICP networks');

const createCmd = new Command('create');
createCmd
  .description('Create a new network configuration')
  .option('-n, --name <name>', 'Network name (required)')
  .option('-t, --type <type>', 'Network type (local, ic)', 'local')
  .option('--nodes <count>', 'Number of nodes', '4')
  .option('--replica-count <count>', 'Replica count')
  .option('--cycles-initial <amount>', 'Initial cycles allocation', '100T')
  .option('--cycles-min <amount>', 'Minimum cycles threshold')
  .option('--auto-topup', 'Enable automatic cycles top-up', false)
  .action(async (options) => {
    if (!options.name) {
      console.error(chalk.red('Error: --name is required'));
      process.exit(1);
    }

    const spinner = ora('Creating network configuration...').start();

    try {
      const config = await createNetworkConfig({
        name: options.name,
        type: options.type as 'local' | 'ic',
        nodes: parseInt(options.nodes, 10),
        replicaCount: options.replicaCount ? parseInt(options.replicaCount, 10) : undefined,
        cycles: {
          initial: options.cyclesInitial,
          min: options.cyclesMin,
          autoTopup: options.autoTopup,
        },
      });

      spinner.succeed(chalk.green(`Network '${config.name}' created successfully`));
      console.log(chalk.gray(`Type: ${config.type}`));
      console.log(chalk.gray(`Replica count: ${config.replicaCount || config.nodes}`));
      console.log(chalk.gray(`Initial cycles: ${config.cycles?.initial}`));
    } catch (error) {
      spinner.fail(chalk.red('Failed to create network'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

const startCmd = new Command('start');
startCmd
  .description('Start a local network')
  .argument('<name>', 'Network name')
  .option('-e, --environment <env>', 'Environment name')
  .option('--project-root <path>', 'Project root directory')
  .option('--identity <name>', 'Identity to use')
  .action(async (name, options) => {
    const spinner = ora(`Starting network '${name}'...`).start();

    try {
      const config = await getNetworkConfig(name);
      if (!config) {
        spinner.fail(chalk.red(`Network '${name}' not found`));
        process.exit(1);
      }

      const result = await networkStart({
        network: name,
        environment: options.environment,
        projectRoot: options.projectRoot,
        identity: options.identity,
      });

      if (!result.success) {
        spinner.fail(chalk.red('Failed to start network'));
        console.error(chalk.red(result.stderr));
        process.exit(1);
      }

      await setNetworkStatus(name, 'running');
      spinner.succeed(chalk.green(`Network '${name}' started successfully`));
      console.log(result.stdout);
    } catch (error) {
      spinner.fail(chalk.red('Failed to start network'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

const stopCmd = new Command('stop');
stopCmd
  .description('Stop a running network')
  .argument('<name>', 'Network name')
  .option('-e, --environment <env>', 'Environment name')
  .option('--project-root <path>', 'Project root directory')
  .option('--identity <name>', 'Identity to use')
  .action(async (name, options) => {
    const spinner = ora(`Stopping network '${name}'...`).start();

    try {
      const config = await getNetworkConfig(name);
      if (!config) {
        spinner.fail(chalk.red(`Network '${name}' not found`));
        process.exit(1);
      }

      const result = await networkStop({
        network: name,
        environment: options.environment,
        projectRoot: options.projectRoot,
        identity: options.identity,
      });

      if (!result.success) {
        spinner.fail(chalk.red('Failed to stop network'));
        console.error(chalk.red(result.stderr));
        process.exit(1);
      }

      await setNetworkStatus(name, 'stopped');
      spinner.succeed(chalk.green(`Network '${name}' stopped successfully`));
      console.log(result.stdout);
    } catch (error) {
      spinner.fail(chalk.red('Failed to stop network'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

const statusCmd = new Command('status');
statusCmd
  .description('Get network status')
  .argument('<name>', 'Network name')
  .option('-e, --environment <env>', 'Environment name')
  .option('--project-root <path>', 'Project root directory')
  .option('--identity <name>', 'Identity to use')
  .action(async (name, options) => {
    const spinner = ora(`Checking network '${name}' status...`).start();

    try {
      const config = await getNetworkConfig(name);
      if (!config) {
        spinner.fail(chalk.red(`Network '${name}' not found`));
        process.exit(1);
      }

      const result = await networkStatus({
        environment: options.environment,
        projectRoot: options.projectRoot,
        identity: options.identity,
      });

      if (!result.success) {
        spinner.warn(chalk.yellow('Could not get network status'));
        console.error(chalk.red(result.stderr));
        process.exit(1);
      }

      spinner.stop();
      console.log(chalk.bold(`Network: ${name}`));
      console.log(chalk.gray(`Type: ${config.type}`));
      console.log(chalk.gray(`Status: ${config.status || 'unknown'}`));
      console.log(chalk.gray(`Created: ${config.created?.toISOString() || 'unknown'}`));
      console.log();
      console.log(result.stdout);
    } catch (error) {
      spinner.fail(chalk.red('Failed to get network status'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

const listCmd = new Command('list');
listCmd
  .description('List all networks')
  .option('-e, --environment <env>', 'Environment name')
  .option('--project-root <path>', 'Project root directory')
  .option('--identity <name>', 'Identity to use')
  .action(async (options) => {
    const spinner = ora('Listing networks...').start();

    try {
      const configs = await listNetworkConfigs();
      
      if (configs.length === 0) {
        spinner.info(chalk.yellow('No networks found'));
        return;
      }

      spinner.stop();

      for (const config of configs) {
        const statusColor = config.status === 'running' ? chalk.green : config.status === 'error' ? chalk.red : chalk.gray;
        console.log(chalk.bold(config.name));
        console.log(chalk.gray(`  Type: ${config.type}`));
        console.log(chalk.gray(`  Status: ${statusColor(config.status || 'unknown')}`));
        console.log(chalk.gray(`  Replicas: ${config.replicaCount || config.nodes}`));
        if (config.cycles) {
          console.log(chalk.gray(`  Initial cycles: ${config.cycles.initial}`));
        }
        console.log();
      }

      const result = await networkList({
        environment: options.environment,
        projectRoot: options.projectRoot,
        identity: options.identity,
      });
      
      if (result.success) {
        console.log(chalk.bold('ICP CLI networks:'));
        console.log(result.stdout);
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to list networks'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

const pingCmd = new Command('ping');
pingCmd
  .description('Check network connectivity')
  .argument('<name>', 'Network name')
  .option('-e, --environment <env>', 'Environment name')
  .option('--project-root <path>', 'Project root directory')
  .option('--identity <name>', 'Identity to use')
  .action(async (name, options) => {
    const spinner = ora(`Pinging network '${name}'...`).start();

    try {
      const config = await getNetworkConfig(name);
      if (!config) {
        spinner.fail(chalk.red(`Network '${name}' not found`));
        process.exit(1);
      }

      const result = await networkPing({
        environment: options.environment,
        projectRoot: options.projectRoot,
        identity: options.identity,
      });

      if (!result.success) {
        spinner.fail(chalk.red('Network ping failed'));
        console.error(chalk.red(result.stderr));
        process.exit(1);
      }

      spinner.succeed(chalk.green(`Network '${name}' is reachable`));
      console.log(result.stdout);
    } catch (error) {
      spinner.fail(chalk.red('Failed to ping network'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

networkCmd.addCommand(createCmd);
networkCmd.addCommand(startCmd);
networkCmd.addCommand(stopCmd);
networkCmd.addCommand(statusCmd);
networkCmd.addCommand(listCmd);
networkCmd.addCommand(pingCmd);
