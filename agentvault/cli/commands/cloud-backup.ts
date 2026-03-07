import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  detectProviders,
  detectAvailableProviders,
  createCustomProvider,
  resolveCloudBackupDir,
  archiveToCloud,
  listCloudArchives,
  restoreFromCloud,
  verifyCloudArchive,
} from '../../src/cloud-storage/index.js';
import { formatBackupSize } from '../../src/backup/index.js';

const cloudBackupCmd = new Command('cloud-backup');

cloudBackupCmd
  .description(
    'Archive and restore AgentVault data using cloud storage (Google Drive, iCloud, Dropbox, etc.)',
  )
  .action(async () => {
    console.log(
      chalk.yellow(
        'Please specify a subcommand: providers, archive, restore, list, or verify',
      ),
    );
    console.log(
      chalk.gray(`
Examples:
  ${chalk.cyan('agentvault cloud-backup providers')}              List detected cloud providers
  ${chalk.cyan('agentvault cloud-backup archive --provider dropbox')}  Archive vault to Dropbox
  ${chalk.cyan('agentvault cloud-backup list --provider dropbox')}     List archives in Dropbox
  ${chalk.cyan('agentvault cloud-backup restore <archive-path>')}      Restore from archive
  ${chalk.cyan('agentvault cloud-backup verify <archive-path>')}       Verify archive integrity`),
    );
  });

// --- providers ---

cloudBackupCmd
  .command('providers')
  .description('Detect available cloud storage providers on this machine')
  .action(async () => {
    const spinner = ora('Scanning for cloud storage providers...').start();
    const providers = detectProviders();
    spinner.stop();

    const available = providers.filter((p) => p.available);
    const unavailable = providers.filter((p) => !p.available);

    if (available.length > 0) {
      console.log(chalk.green(`Found ${available.length} available provider(s):\n`));
      for (const p of available) {
        console.log(`  ${chalk.cyan(p.label)}`);
        console.log(`    Path: ${chalk.gray(p.path)}`);
        console.log(`    ID:   ${chalk.gray(p.provider)}`);
        console.log();
      }
    } else {
      console.log(
        chalk.yellow(
          'No cloud storage providers detected. Use --path to specify a custom directory.',
        ),
      );
    }

    if (unavailable.length > 0) {
      console.log(chalk.gray('Not detected:'));
      for (const p of unavailable) {
        console.log(chalk.gray(`  - ${p.label}`));
      }
    }
  });

// --- archive ---

cloudBackupCmd
  .command('archive')
  .description('Archive AgentVault data to a cloud storage provider')
  .option(
    '-p, --provider <name>',
    'Cloud provider (google-drive, icloud-drive, dropbox, onedrive)',
  )
  .option('--path <directory>', 'Custom directory path (overrides --provider)')
  .option('-a, --agent <name>', 'Archive a specific agent only')
  .option('--no-configs', 'Exclude agent configurations')
  .option('--no-wallets', 'Exclude wallet data')
  .option('--no-backups', 'Exclude existing backups')
  .option('--no-networks', 'Exclude network configurations')
  .option('--subdirectory <name>', 'Subdirectory name inside provider', 'AgentVault-Backups')
  .action(async (options) => {
    // Resolve provider path
    let providerPath: string;
    let providerLabel: string;

    if (options.path) {
      const custom = createCustomProvider(options.path);
      providerPath = custom.path;
      providerLabel = `Custom (${options.path})`;
    } else if (options.provider) {
      const providers = detectProviders();
      const match = providers.find(
        (p) => p.provider === options.provider,
      );

      if (!match) {
        console.error(
          chalk.red(
            `Unknown provider "${options.provider}". Use "agentvault cloud-backup providers" to see available options.`,
          ),
        );
        process.exit(1);
        return;
      }

      if (!match.available) {
        console.error(
          chalk.red(
            match.label + ' is not available on this machine. Expected path: ' + match.path,
          ),
        );
        process.exit(1);
        return;
      }

      providerPath = match.path;
      providerLabel = match.label;
    } else {
      // Auto-detect: use first available
      const available = detectAvailableProviders();
      if (available.length === 0) {
        console.error(
          chalk.red(
            'No cloud provider detected. Use --provider or --path to specify a destination.',
          ),
        );
        process.exit(1);
        return;
      }

      const first = available[0]!;
      providerPath = first.path;
      providerLabel = first.label;
      console.log(
        chalk.gray(`Auto-detected provider: ${providerLabel}`),
      );
    }

    const spinner = ora(
      `Archiving to ${providerLabel}...`,
    ).start();

    const result = archiveToCloud(providerPath, {
      agentName: options.agent,
      includeConfigs: options.configs !== false,
      includeWallets: options.wallets !== false,
      includeBackups: options.backups !== false,
      includeNetworks: options.networks !== false,
    }, options.subdirectory);

    if (result.success) {
      spinner.succeed(
        chalk.green(`Archive created in ${providerLabel}`),
      );
      console.log(chalk.gray(`  Path:  ${result.archivePath}`));
      console.log(
        chalk.gray(
          `  Files: ${result.fileCount} (${formatBackupSize(result.totalBytes || 0)})`,
        ),
      );
      console.log(
        chalk.gray(
          '\nYour cloud provider will sync this automatically.',
        ),
      );
    } else {
      spinner.fail(chalk.red('Archive failed'));
      console.error(chalk.red(result.error || 'Unknown error'));
      process.exit(1);
    }
  });

// --- list ---

cloudBackupCmd
  .command('list')
  .description('List available archives in a cloud storage directory')
  .option(
    '-p, --provider <name>',
    'Cloud provider (google-drive, icloud-drive, dropbox, onedrive)',
  )
  .option('--path <directory>', 'Custom directory path')
  .option('--subdirectory <name>', 'Subdirectory name inside provider', 'AgentVault-Backups')
  .action(async (options) => {
    let providerPath: string;

    if (options.path) {
      providerPath = options.path;
    } else if (options.provider) {
      const providers = detectProviders();
      const match = providers.find(
        (p) => p.provider === options.provider,
      );

      if (!match || !match.available) {
        console.error(
          chalk.red(
            `Provider "${options.provider}" not available. Run "agentvault cloud-backup providers".`,
          ),
        );
        process.exit(1);
        return;
      }

      providerPath = match.path;
    } else {
      const available = detectAvailableProviders();
      if (available.length === 0) {
        console.error(
          chalk.red('No cloud provider detected. Use --provider or --path.'),
        );
        process.exit(1);
        return;
      }

      const first = available[0]!;
      providerPath = first.path;
      console.log(
        chalk.gray('Auto-detected provider: ' + first.label),
      );
    }

    const spinner = ora('Scanning for archives...').start();
    const archives = listCloudArchives(providerPath, options.subdirectory);
    spinner.stop();

    if (archives.length === 0) {
      console.log(chalk.yellow('No archives found.'));
      console.log(
        chalk.gray(
          `Looked in: ${resolveCloudBackupDir(providerPath, options.subdirectory)}`,
        ),
      );
      return;
    }

    console.log(
      chalk.green(`Found ${archives.length} archive(s):\n`),
    );

    for (const archive of archives) {
      const m = archive.manifest;
      const totalSize = m.files.reduce((s, f) => s + f.sizeBytes, 0);
      const dateStr = new Date(m.createdAt).toLocaleString();
      const nameStr = m.agentName || 'full-vault';

      console.log(
        '  ' + chalk.cyan(nameStr) + ' ' + chalk.gray('(' + dateStr + ')'),
      );
      console.log(
        chalk.gray('    Components: ' + m.components.join(', ')),
      );
      console.log(
        chalk.gray('    Files: ' + String(m.files.length) + ' (' + formatBackupSize(totalSize) + ')'),
      );
      console.log(
        chalk.gray('    Path: ' + archive.archivePath),
      );
      console.log();
    }
  });

// --- restore ---

cloudBackupCmd
  .command('restore')
  .description('Restore AgentVault data from a cloud archive')
  .argument('<archive-path>', 'Path to the archive directory')
  .option('--overwrite', 'Overwrite existing files', false)
  .action(async (archivePath: string, options) => {
    const spinner = ora('Restoring from archive...').start();

    const result = restoreFromCloud(archivePath, options.overwrite);

    if (result.success) {
      spinner.succeed(
        chalk.green(
          `Restored ${result.restoredFiles} file(s)`,
        ),
      );
      if (result.components && result.components.length > 0) {
        console.log(
          chalk.gray(
            `  Components: ${result.components.join(', ')}`,
          ),
        );
      }
    } else {
      spinner.fail(chalk.red('Restore failed'));
      console.error(chalk.red(result.error || 'Unknown error'));
    }

    if (result.warnings.length > 0) {
      console.log(chalk.yellow('\nWarnings:'));
      for (const w of result.warnings) {
        console.log(chalk.yellow(`  - ${w}`));
      }
    }

    if (!result.success) {
      process.exit(1);
    }
  });

// --- verify ---

cloudBackupCmd
  .command('verify')
  .description('Verify integrity of a cloud archive')
  .argument('<archive-path>', 'Path to the archive directory')
  .action(async (archivePath: string) => {
    const spinner = ora('Verifying archive integrity...').start();

    const result = verifyCloudArchive(archivePath);

    if (result.valid) {
      spinner.succeed(chalk.green('Archive integrity verified'));
    } else {
      spinner.fail(chalk.red('Archive integrity check failed'));
      for (const err of result.errors) {
        console.error(chalk.red(`  - ${err}`));
      }
      process.exit(1);
    }
  });

export { cloudBackupCmd };
