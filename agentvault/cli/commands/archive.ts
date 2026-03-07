import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  prepareArchive,
  listArchives,
  getArchive,
  deleteArchive,
  verifyArchive,
  getArchiveStats,
  type ManagerArchiveResult as ArchiveResult,
} from '../../src/archival/index.js';

const archiveCmd = new Command('archive');

archiveCmd
  .description('[Experimental] Archive agent data to permanent storage (Arweave)')
  .action(async () => {
    console.log(chalk.yellow('[Experimental] This feature is under active development and may change.'));
    console.log(chalk.yellow('Please specify a subcommand: prepare, list, delete, verify, or stats'));
    console.log(chalk.gray(`\nExamples:
  ${chalk.cyan('agentvault archive prepare <agent-name> <version>')}${chalk.gray('    Prepare agent data for archival')}
  ${chalk.cyan('agentvault archive list')}${chalk.gray('                 List all archives')}
  ${chalk.cyan('agentvault archive stats <agent-name>')}${chalk.gray('     Get archive statistics')}
  ${chalk.cyan('agentvault archive delete <archive-id>')}${chalk.gray('      Delete an archive')}
  ${chalk.cyan('agentvault archive verify <archive-id>')}${chalk.gray('       Verify archive integrity')}`));
  });

archiveCmd
  .command('prepare')
  .description('Prepare agent data for archival (local storage)')
  .argument('<agent-name>', 'Agent name to archive')
  .argument('<version>', 'Agent version')
  .option('--include-config', 'Include agent configuration', true)
  .option('--include-logs', 'Include logs', false)
  .option('--include-metrics', 'Include metrics', false)
  .option('--tag <key=value>', 'Add metadata tag (can be used multiple times)', [])
  .action(async (agentName, version, options) => {
    const spinner = ora(`Preparing archive for ${agentName} v${version}...`).start();

    try {
      const data: Record<string, any> = {
        agentName,
        version,
        timestamp: new Date().toISOString(),
      };

      if (options.includeConfig) {
        data.config = { included: true };
      }

      if (options.includeLogs) {
        data.logs = { included: true, sample: ['Sample log entry'] };
      }

      if (options.includeMetrics) {
        data.metrics = { included: true };
      }

      const tags: Record<string, string> = {};
      if (options.tag) {
        for (const tag of options.tag) {
          const parts = tag.split('=');
          if (parts.length === 2) {
            tags[parts[0]] = parts[1];
          }
        }
      }

      const result: ArchiveResult = prepareArchive(agentName, version, data, {
        includeConfig: options.includeConfig,
        includeLogs: options.includeLogs,
        includeMetrics: options.includeMetrics,
        tags,
      });

      if (result.success && result.archiveId) {
        spinner.succeed(chalk.green(`Archive prepared: ${result.archiveId}`));
        console.log(chalk.gray(`Agent: ${agentName}`));
        console.log(chalk.gray(`Version: ${version}`));
      } else {
        spinner.fail(chalk.red('Failed to prepare archive'));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to prepare archive'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

archiveCmd
  .command('list')
  .description('List all archives')
  .option('--agent <name>', 'Filter by agent name')
  .option('--status <status>', 'Filter by status (pending, uploading, confirmed, failed)')
  .action(async (options) => {
    const spinner = ora('Loading archives...').start();

    try {
      const archives = listArchives(options.agent);

      spinner.succeed(chalk.green(`Found ${archives.length} archive(s)`));

      if (archives.length === 0) {
        console.log(chalk.gray('No archives found'));
        return;
      }

      let filtered = archives;
      if (options.status) {
        filtered = archives.filter((a) => a.status === options.status);
      }

      for (const archive of filtered) {
        const statusColor = {
          pending: chalk.yellow,
          uploading: chalk.blue,
          confirmed: chalk.green,
          failed: chalk.red,
        }[archive.status] || chalk.gray;

        console.log(`\n${chalk.bold(archive.id)}`);
        console.log(`  Agent: ${archive.agentName}`);
        console.log(`  Status: ${statusColor(archive.status)}`);
        console.log(`  Size: ${archive.sizeBytes} bytes`);
        console.log(`  Timestamp: ${archive.timestamp.toLocaleString()}`);
        if (archive.transactionId) {
          console.log(`  Transaction: ${archive.transactionId}`);
        }
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to list archives'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

archiveCmd
  .command('stats')
  .description('Get archive statistics')
  .option('--agent <name>', 'Filter by agent name')
  .action(async (options) => {
    try {
      const stats = getArchiveStats(options.agent);

      console.log(chalk.bold('\nArchive Statistics:'));
      console.log(`  Total archives: ${stats.total}`);
      console.log(`  Confirmed: ${chalk.green(stats.confirmed)}`);
      console.log(`  Pending: ${chalk.yellow(stats.pending)}`);
      console.log(`  Failed: ${chalk.red(stats.failed)}`);
      console.log(`  Total size: ${(stats.totalBytes / 1024 / 1024).toFixed(2)} MB`);
    } catch (error) {
      console.error(chalk.red('Failed to get stats'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

archiveCmd
  .command('delete')
  .description('Delete an archive (local storage only)')
  .argument('<archive-id>', 'Archive ID to delete')
  .action(async (archiveId) => {
    const spinner = ora(`Deleting archive ${archiveId}...`).start();

    try {
      const success = deleteArchive(archiveId);

      if (success) {
        spinner.succeed(chalk.green(`Archive deleted: ${archiveId}`));
      } else {
        spinner.fail(chalk.red('Failed to delete archive'));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to delete archive'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

archiveCmd
  .command('verify')
  .description('Verify archive integrity')
  .argument('<archive-id>', 'Archive ID to verify')
  .action(async (archiveId) => {
    const spinner = ora(`Verifying archive ${archiveId}...`).start();

    try {
      const archive = getArchive(archiveId);

      if (!archive) {
        spinner.fail(chalk.red('Archive not found'));
        process.exit(1);
      }

      const isValid = verifyArchive(archiveId);

      if (isValid) {
        spinner.succeed(chalk.green(`Archive verified: ${archiveId}`));
        console.log(chalk.gray(`Checksum: ${archive.checksum}`));
      } else {
        spinner.fail(chalk.red('Archive verification failed'));
        process.exit(1);
      }
    } catch (error) {
      spinner.fail(chalk.red('Failed to verify archive'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });

export { archiveCmd };
