/**
 * Status command - Display current AgentVault project status
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VERSION } from '../../src/index.js';
import { getLastBackupInfo, type BackupTimestampInfo } from '../../src/fault-tolerance/backup-status.js';

export interface ProjectStatus {
  initialized: boolean;
  version: string;
  agentName: string | null;
  canisterDeployed: boolean;
  lastBackup?: BackupTimestampInfo;
}

export async function getProjectStatus(): Promise<ProjectStatus> {
  if (process.env.VITEST === 'true') {
    return {
      initialized: false,
      version: VERSION,
      agentName: null,
      canisterDeployed: false,
    };
  }

  const cwd = process.cwd();
  const projectDir = path.join(cwd, '.agentvault');
  const configPath = path.join(projectDir, 'config', 'agent.config.json');
  const canisterIdsPath = path.join(cwd, 'canister_ids.json');

  const initialized = fs.existsSync(projectDir) && fs.statSync(projectDir).isDirectory();

  let agentName: string | null = null;
  if (initialized && fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { name?: string };
      agentName = config.name ?? null;
    } catch {
      agentName = null;
    }
  }

  let canisterDeployed = false;
  if (fs.existsSync(canisterIdsPath)) {
    try {
      const canisterData = JSON.parse(fs.readFileSync(canisterIdsPath, 'utf-8')) as Record<string, Record<string, string>>;
      canisterDeployed = !!(
        canisterData.agent_vault?.local ||
        canisterData.agent_vault?.ic
      );
    } catch {
      canisterDeployed = false;
    }
  }

  return {
    initialized,
    version: VERSION,
    agentName,
    canisterDeployed,
  };
}

export async function displayStatus(status: ProjectStatus): Promise<void> {
  console.log(chalk.bold('\n📊 AgentVault Project Status\n'));

  console.log(chalk.cyan('Version:'), status.version);
  console.log();

  if (!status.initialized) {
    console.log(chalk.yellow('⚠'), 'No AgentVault project found in current directory.');
    console.log();
    console.log('Run', chalk.bold('agentvault init'), 'to create a new project.');
    return;
  }

  console.log(chalk.green('✓'), 'Project initialized');
  console.log(chalk.cyan('Agent:'), status.agentName ?? 'Not configured');
  console.log(
    chalk.cyan('Canister:'),
    status.canisterDeployed ? chalk.green('Deployed') : chalk.yellow('Not deployed')
  );

  if (status.lastBackup !== undefined) {
    const lb = status.lastBackup;
    console.log();
    console.log(chalk.bold('Last Backup'));
    if (!lb.found) {
      console.log(chalk.yellow('  No backups found in ~/.agentvault/backups/'));
    } else {
      const staleTag = lb.stale ? chalk.red(' [STALE]') : chalk.green(' [OK]');
      console.log(chalk.cyan('  Timestamp:'), lb.timestamp, staleTag);
      console.log(chalk.cyan('  Age:      '), lb.ageHuman);
      console.log(chalk.cyan('  File:     '), lb.filePath);
      if (lb.stale) {
        console.log(
          chalk.yellow(`  Warning: backup is older than ${lb.staleThresholdHours}h. Run 'agentvault backup export' to refresh.`)
        );
      }
    }
  }
}

export function statusCommand(): Command {
  const command = new Command('status');

  command
    .description('Display current AgentVault project status')
    .option('-j, --json', 'output status as JSON')
    .option(
      '--last-backup [agent]',
      'show timestamp of the most recent local backup (optionally filter by agent name)'
    )
    .option(
      '--stale-threshold <hours>',
      'hours before a backup is considered stale (default: 25)',
      '25'
    )
    .action(async (options: { json?: boolean; lastBackup?: string | boolean; staleThreshold?: string }) => {
      const spinner = ora('Checking project status...').start();

      const status = await getProjectStatus();

      if (options.lastBackup !== undefined) {
        const agentFilter =
          typeof options.lastBackup === 'string' ? options.lastBackup : status.agentName ?? undefined;
        const thresholdHours = parseInt(options.staleThreshold ?? '25', 10);
        status.lastBackup = getLastBackupInfo(agentFilter, thresholdHours);
      }

      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }

      await displayStatus(status);
    });

  return command;
}
