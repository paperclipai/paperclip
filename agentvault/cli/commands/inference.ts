import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  BittensorClient,
  getCachedInference,
  setCachedInference,
  clearCache,
  getCacheStats,
  formatInferenceTime,
  type InferenceConfig,
} from '../../src/inference/index.js';

const inferenceCmd = new Command('inference');

inferenceCmd
  .description('[Experimental] Query AI inference services (Bittensor network)')
  .action(async () => {
    console.log(chalk.yellow('[Experimental] This feature is under active development and may change.'));
    console.log(chalk.yellow('Please specify a subcommand: query, subnets, modules, cache, or stats'));
    console.log(chalk.gray(`\nExamples:
  ${chalk.cyan('agentvault inference query <netuid> <inputs>')}${chalk.gray('    Query inference')}
  ${chalk.cyan('agentvault inference subnets')}${chalk.gray('               List Bittensor subnets')}
  ${chalk.cyan('agentvault inference modules <netuid>')}${chalk.gray('         List subnet modules')}
  ${chalk.cyan('agentvault inference cache clear')}${chalk.gray('           Clear inference cache')}
  ${chalk.cyan('agentvault inference cache stats')}${chalk.gray('           Show cache statistics')}`));
  });

inferenceCmd
  .command('query')
  .description('Query AI inference from Bittensor network')
  .argument('<netuid>', 'Subnet UID')
  .argument('<inputs>', 'Inference inputs (JSON string)')
  .option('--uid <number>', 'Module UID (defaults to best module)')
  .option('--batch <number>', 'Query multiple modules (default: 1)', '1')
  .option('--timeout <ms>', 'Request timeout', '30000')
  .option('--no-cache', 'Disable caching', false)
  .action(async (netuidArg, inputsArg, options) => {
    const spinner = ora(`Querying subnet ${netuidArg}...`).start();

    try {
      const netuid = parseInt(netuidArg, 10);
      if (isNaN(netuid)) {
        spinner.fail(chalk.red('Invalid netuid'));
        process.exit(1);
      }

      const inputs = JSON.parse(inputsArg);
      const config: InferenceConfig = {
        netuid,
        uid: options.uid ? parseInt(options.uid, 10) : undefined,
        batchSize: parseInt(options.batch, 10),
        timeout: parseInt(options.timeout, 10),
        enableCache: !options.noCache,
      };

      const client = new BittensorClient();

      if (!options.noCache) {
        const cached = getCachedInference(netuid, inputs);
        if (cached) {
          spinner.succeed(chalk.green('Using cached result'));
          console.log(chalk.gray(`Cached at: ${cached.timestamp.toLocaleString()}`));
          console.log(chalk.gray(`Expires: ${cached.expiresAt.toLocaleString()}`));
          console.log(JSON.stringify(cached.result, null, 2));
          return;
        }
      }

      const batchSize = config.batchSize || 1;
      const startTime = Date.now();

      const inference = async () => {
        if (config.uid) {
          return client.infer({ netuid, uid: config.uid, inputs });
        } else if (batchSize > 1) {
          const results = await client.batchInfer({ netuid, inputs }, batchSize);
          return {
            success: results.length > 0,
            data: results[0]?.data,
            metadata: results[0]?.metadata,
          };
        } else {
          const bestModule = await client.findBestModule(netuid);
          if (!bestModule) {
            return { success: false, error: 'No modules found' };
          }
          return client.infer({ netuid, uid: bestModule.uid, inputs });
        }
      };

      const response = await inference();
      const responseTime = Date.now() - startTime;

      if (response.success) {
        spinner.succeed(chalk.green(`Inference complete (${formatInferenceTime(responseTime)})`));
        console.log(JSON.stringify(response.data, null, 2));

        if (response.metadata) {
          console.log(chalk.gray(`\nModule: ${response.metadata.name} (${response.metadata.uid})`));
          console.log(chalk.gray(`Response time: ${formatInferenceTime(response.metadata.responseTime)}`));
        }

        if (!options.noCache && response.data) {
          setCachedInference(netuid, inputs, response.data, 3600000);
        }
      } else {
        spinner.fail(chalk.red('Inference failed'));
        if (response.error) {
          console.error(chalk.red(response.error));
        }
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Inference query failed'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

inferenceCmd
  .command('subnets')
  .description('List Bittensor subnets')
  .action(async () => {
    const spinner = ora('Loading subnets...').start();

    try {
      const client = new BittensorClient();
      const subnets = await client.getSubnets();

      spinner.succeed(chalk.green(`Found ${subnets.length} subnet(s)`));

      if (subnets.length === 0) {
        console.log(chalk.gray('No subnets found'));
        return;
      }

      for (const subnet of subnets) {
        console.log(`\n${chalk.bold(`NetUID: ${subnet.netuid}`)}`);
        console.log(`  Name: ${subnet.name}`);
        console.log(`  Modality: ${subnet.modality}`);
        console.log(`  Registered: ${subnet.registered} modules`);
        console.log(`  Tempo: ${subnet.tempo}`);
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to list subnets'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

inferenceCmd
  .command('modules')
  .description('List modules for a subnet')
  .argument('<netuid>', 'Subnet UID')
  .action(async (netuidArg) => {
    const spinner = ora(`Loading modules for subnet ${netuidArg}...`).start();

    try {
      const client = new BittensorClient();
      const netuid = parseInt(netuidArg, 10);
      const modules = await client.getModules(netuid);

      spinner.succeed(chalk.green(`Found ${modules.length} module(s)`));

      if (modules.length === 0) {
        console.log(chalk.gray('No modules found'));
        return;
      }

      const sorted = modules.sort((a, b) => b.rank - a.rank);

      for (const module of sorted.slice(0, 20)) {
        const status = module.validator_permit ? chalk.green('✓') : chalk.gray('○');
        console.log(`${status} ${chalk.bold(`UID ${module.uid}`)}: ${module.name || 'Unnamed'} (Rank: ${module.rank})`);
      }

      if (modules.length > 20) {
        console.log(chalk.gray(`\n... and ${modules.length - 20} more`));
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to list modules'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

inferenceCmd
  .command('cache')
  .description('Manage inference cache')
  .argument('<action>', 'Action: clear or stats')
  .action(async (action) => {
    switch (action) {
      case 'clear': {
        const spinner = ora('Clearing cache...').start();
        clearCache();
        spinner.succeed(chalk.green('Cache cleared'));
        break;
      }

      case 'stats':
        try {
          const stats = getCacheStats();
          console.log(chalk.bold('\nCache Statistics:'));
          console.log(`  Total entries: ${stats.total}`);
          console.log(`  Expired: ${stats.expired}`);
          console.log(`  Size: ${(stats.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
        } catch (error) {
          console.error(chalk.red('Failed to get cache stats'));
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error(chalk.red(message));
          process.exit(1);
        }
        break;

      default:
        console.log(chalk.red('Invalid action. Use "clear" or "stats"'));
        process.exit(1);
    }
  });

inferenceCmd
  .command('health')
  .description('Check Bittensor API health')
  .action(async () => {
    const spinner = ora('Checking API health...').start();

    try {
      const client = new BittensorClient();
      const status = await client.getApiStatus();

      if (status.online) {
        spinner.succeed(chalk.green('Bittensor API is online'));
        if (status.version) {
          console.log(chalk.gray(`API version: ${status.version}`));
        }
      } else {
        spinner.fail(chalk.red('Bittensor API is offline'));
        if (status.error) {
          console.error(chalk.red(status.error));
        }
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to check API health'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

export { inferenceCmd };
