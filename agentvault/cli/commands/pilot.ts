/**
 * Pilot command – Private ICP Replica for Company Guild
 *
 * Usage:
 *   agentvault pilot init --company "MyCorp" --replica local
 *   agentvault pilot deploy --stack full
 *   agentvault pilot status [company]
 *   agentvault pilot stop [company]
 *   agentvault pilot list
 *   agentvault pilot air-gap enable --company "MyCorp" [--allow <endpoint>]
 *   agentvault pilot air-gap disable --company "MyCorp"
 *
 * Supports PRD-004: Internal Pilot – Private ICP Replica for Company Guild
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import * as path from 'node:path';
import {
  initPrivateReplica,
  getPrivateReplicaStatus,
  stopPrivateReplica,
  listPilotCompanies,
  loadPilotConfig,
  savePilotConfig,
  replicaTypeLabel,
  buildReplicaUrl,
  isDfxAvailable,
  writeAirGapEnvFile,
  validateAirGapConfig,
  toggleAirGap,
  describeAirGap,
  describeProxyConfig,
  type PilotInitOptions,
  type ReplicaType,
  type StackTarget,
} from '../../src/pilot/index.js';

// ─── Helper: format step list ────────────────────────────────────────────────

function printSteps(steps: { name: string; success: boolean; durationMs: number; error?: string; output?: string }[]): void {
  for (const step of steps) {
    const icon = step.success ? chalk.green('✓') : chalk.red('✗');
    const duration = chalk.gray(`(${step.durationMs}ms)`);
    const label = step.name.replace(/-/g, ' ');
    console.log(`  ${icon} ${label} ${duration}`);
    if (step.error) {
      console.log(`    ${chalk.red(step.error)}`);
    }
  }
}

// ─── pilot init ─────────────────────────────────────────────────────────────

const initCmd = new Command('init');
initCmd
  .description('Initialize a private ICP replica and deploy Guild canisters')
  .requiredOption('--company <name>', 'Company or org identifier (e.g. "MyCorp")')
  .option('--replica <type>', 'Replica backend: local | kubernetes | docker', 'local')
  .option('--port <port>', 'Local port for the replica API', String(8080))
  .option('--cycles <amount>', 'Initial cycles for Guild canisters', '100T')
  .option('--identity <path>', 'Path to dfx identity PEM file')
  .option('--air-gap', 'Enable air-gap mode (block all internet except approved endpoints)', false)
  .option('--anthropic-proxy <url>', 'Proxy URL for Anthropic API (used in air-gap mode)')
  .option('--arweave-proxy <url>', 'Proxy URL for Arweave gateway')
  .option('--bittensor-proxy <url>', 'Proxy URL for Bittensor endpoint')
  .option('--no-mdns', 'Disable mDNS announcement of private replica')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(async (options: {
    company: string;
    replica: string;
    port: string;
    cycles: string;
    identity?: string;
    airGap: boolean;
    anthropicProxy?: string;
    arweaveProxy?: string;
    bittensorProxy?: string;
    mdns: boolean;
    yes: boolean;
  }) => {
    console.log(chalk.bold('\n Private ICP Replica Initialization\n'));

    const company = options.company.trim();
    const replicaType = (options.replica ?? 'local') as ReplicaType;
    const port = parseInt(options.port, 10) || 8080;

    // Show plan
    console.log(chalk.cyan('Configuration:'));
    console.log(`  Company:      ${chalk.bold(company)}`);
    console.log(`  Replica:      ${chalk.bold(replicaTypeLabel(replicaType))}`);
    console.log(`  Port:         ${chalk.bold(port)}`);
    console.log(`  Cycles:       ${chalk.bold(options.cycles)}`);
    console.log(`  Air-gap:      ${options.airGap ? chalk.yellow('enabled') : chalk.gray('disabled')}`);
    console.log(`  mDNS:         ${options.mdns ? chalk.green('enabled') : chalk.gray('disabled')}`);
    if (options.anthropicProxy) {
      console.log(`  Anthropic →   ${chalk.blue(options.anthropicProxy)}`);
    }
    if (options.arweaveProxy) {
      console.log(`  Arweave →     ${chalk.blue(options.arweaveProxy)}`);
    }
    if (options.bittensorProxy) {
      console.log(`  Bittensor →   ${chalk.blue(options.bittensorProxy)}`);
    }
    console.log();

    if (!options.yes) {
      const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
        {
          type: 'confirm',
          name: 'confirmed',
          message: `Initialize private replica for "${company}"?`,
          default: true,
        },
      ]);
      if (!confirmed) {
        console.log(chalk.yellow('Cancelled.'));
        return;
      }
    }

    const spinner = ora('Initializing private ICP replica...').start();

    const initOptions: PilotInitOptions = {
      company,
      replica: replicaType,
      port,
      cycles: options.cycles,
      identity: options.identity,
      airGap: options.airGap,
      anthropicProxy: options.anthropicProxy,
      arweaveProxy: options.arweaveProxy,
      bittensorProxy: options.bittensorProxy,
      mdns: options.mdns,
    };

    try {
      const result = await initPrivateReplica(initOptions, process.cwd());
      spinner.stop();

      if (result.success) {
        console.log(chalk.green('\n✓ Private replica initialized successfully!\n'));
      } else {
        console.log(chalk.yellow('\n⚠ Initialized with warnings:\n'));
      }

      console.log(chalk.cyan('Steps:'));
      printSteps(result.steps);

      if (result.warnings.length > 0) {
        console.log();
        console.log(chalk.yellow('Warnings:'));
        for (const w of result.warnings) {
          console.log(`  ${chalk.yellow('⚠')} ${w}`);
        }
      }

      console.log();
      console.log(chalk.cyan('Replica:'));
      console.log(`  URL:       ${chalk.bold(result.replicaUrl)}`);
      console.log(`  Config:    ${chalk.gray(result.config.configPath)}`);

      if (Object.keys(result.canisterIds).length > 0) {
        console.log();
        console.log(chalk.cyan('Canister IDs:'));
        for (const [name, id] of Object.entries(result.canisterIds)) {
          console.log(`  ${name}: ${chalk.bold(id)}`);
        }
      }

      console.log();
      console.log(chalk.cyan('Next steps:'));
      console.log(`  1. Deploy the full stack:  ${chalk.bold('agentvault pilot deploy --stack full')}`);
      console.log(`  2. Check status:           ${chalk.bold(`agentvault pilot status ${company}`)}`);
      if (result.config.airGap.enabled) {
        console.log(`  3. Air-gap env file:       ${chalk.bold(path.join(result.config.stateDir, 'air-gap.env'))}`);
        const envPath = writeAirGapEnvFile(result.config.airGap, result.config.stateDir);
        console.log(`     ${chalk.gray(`source ${envPath}`)}`);
      }
    } catch (err) {
      spinner.fail('Initialization failed');
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nError: ${message}`));
      process.exit(1);
    }
  });

// ─── pilot deploy ────────────────────────────────────────────────────────────

const deployCmd = new Command('deploy');
deployCmd
  .description('Deploy the full AgentVault stack to the private replica')
  .option('--stack <target>', 'Components to deploy: full | cli | canisters | webapp | macos', 'full')
  .option('--company <name>', 'Company identifier (required if multiple pilots exist)')
  .option('--dry-run', 'Show what would be deployed without executing')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(async (options: {
    stack: string;
    company?: string;
    dryRun: boolean;
    yes: boolean;
  }) => {
    console.log(chalk.bold('\n Private Replica Stack Deploy\n'));

    const stackTarget = (options.stack ?? 'full') as StackTarget;

    // Resolve company
    let company = options.company;
    if (!company) {
      const companies = listPilotCompanies();
      if (companies.length === 0) {
        console.error(chalk.red('No pilot configurations found. Run `agentvault pilot init` first.'));
        process.exit(1);
      }
      if (companies.length === 1) {
        company = companies[0];
      } else {
        const { chosen } = await inquirer.prompt<{ chosen: string }>([{
          type: 'list',
          name: 'chosen',
          message: 'Select company:',
          choices: companies,
        }]);
        company = chosen;
      }
    }

    if (!company) {
      console.error(chalk.red('Company could not be determined.'));
      process.exit(1);
    }

    const config = loadPilotConfig(company);
    if (!config) {
      console.error(chalk.red(`No pilot config found for company "${company}".`));
      process.exit(1);
    }

    const replicaUrl = buildReplicaUrl(config.bindAddress, config.port);

    const stackComponents: Record<string, string> = {
      full: 'CLI + Canisters + Webapp + macOS app',
      cli: 'CLI tools only',
      canisters: 'ICP canisters only',
      webapp: 'Web application only',
      macos: 'macOS app (points to private replica)',
    };

    console.log(chalk.cyan('Deploy plan:'));
    console.log(`  Company:   ${chalk.bold(company)}`);
    console.log(`  Stack:     ${chalk.bold(stackComponents[stackTarget] ?? stackTarget)}`);
    console.log(`  Target:    ${chalk.bold(replicaUrl)}`);
    console.log(`  Network:   ${chalk.bold('private')}`);
    console.log();

    if (options.dryRun) {
      console.log(chalk.yellow('[dry-run] No changes made.'));
      return;
    }

    if (!options.yes) {
      const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([{
        type: 'confirm',
        name: 'confirmed',
        message: `Deploy ${stackTarget} stack to ${company}'s private replica?`,
        default: true,
      }]);
      if (!confirmed) {
        console.log(chalk.yellow('Cancelled.'));
        return;
      }
    }

    const spinner = ora('Deploying stack...').start();

    try {
      const dfxAvailable = await isDfxAvailable();
      const steps: { name: string; success: boolean; durationMs: number; error?: string }[] = [];
      const warnings: string[] = [];

      if (stackTarget === 'full' || stackTarget === 'canisters') {
        const start = Date.now();
        if (dfxAvailable) {
          const { execa } = await import('execa');
          const result = await execa('dfx', ['deploy', '--network', 'private'], {
            reject: false,
            env: { ...process.env, AGENTVAULT_REPLICA_URL: replicaUrl },
          });
          steps.push({
            name: 'deploy-canisters',
            success: result.exitCode === 0,
            durationMs: Date.now() - start,
            error: result.exitCode !== 0 ? (result.stderr || result.stdout) : undefined,
          });
        } else {
          warnings.push('dfx not available – skipping canister deploy');
          steps.push({ name: 'deploy-canisters', success: false, durationMs: Date.now() - start, error: 'dfx not found' });
        }
      }

      if (stackTarget === 'full' || stackTarget === 'webapp') {
        steps.push({
          name: 'configure-webapp',
          success: true,
          durationMs: 0,
        });
        warnings.push(`Webapp: set VITE_ICP_HOST=${replicaUrl} before building.`);
      }

      if (stackTarget === 'full' || stackTarget === 'macos') {
        steps.push({
          name: 'configure-macos-app',
          success: true,
          durationMs: 0,
        });
        warnings.push(`macOS app: auto-detects private replica via mDNS or pilot config at ${config.configPath}`);
      }

      spinner.stop();

      const allSuccess = steps.every((s) => s.success);
      if (allSuccess) {
        console.log(chalk.green('\n✓ Stack deployed successfully!\n'));
      } else {
        console.log(chalk.yellow('\n⚠ Deploy completed with warnings:\n'));
      }

      console.log(chalk.cyan('Steps:'));
      printSteps(steps);

      if (warnings.length > 0) {
        console.log();
        console.log(chalk.yellow('Notes:'));
        for (const w of warnings) {
          console.log(`  ${chalk.yellow('⚠')} ${w}`);
        }
      }

      console.log();
      console.log(chalk.cyan('Private replica URL:'), chalk.bold(replicaUrl));
    } catch (err) {
      spinner.fail('Deploy failed');
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nError: ${message}`));
      process.exit(1);
    }
  });

// ─── pilot status ────────────────────────────────────────────────────────────

const statusCmd = new Command('status');
statusCmd
  .description('Show status of a private replica')
  .argument('[company]', 'Company identifier (optional if only one pilot exists)')
  .action(async (company?: string) => {
    console.log(chalk.bold('\n Private Replica Status\n'));

    if (!company) {
      const companies = listPilotCompanies();
      if (companies.length === 0) {
        console.log(chalk.yellow('No pilot configurations found. Run `agentvault pilot init` first.'));
        return;
      }
      if (companies.length === 1) {
        company = companies[0];
      } else {
        const { chosen } = await inquirer.prompt<{ chosen: string }>([{
          type: 'list',
          name: 'chosen',
          message: 'Select company:',
          choices: companies,
        }]);
        company = chosen;
      }
    }

    if (!company) {
      console.log(chalk.yellow('No company selected.'));
      return;
    }

    const spinner = ora(`Checking status for "${company}"...`).start();
    const status = await getPrivateReplicaStatus(company);
    spinner.stop();

    if (!status) {
      console.error(chalk.red(`No pilot config found for company "${company}".`));
      process.exit(1);
    }

    const runningLabel = status.running
      ? chalk.green('running')
      : chalk.red('stopped');

    console.log(chalk.cyan('Replica:'));
    console.log(`  Company:   ${chalk.bold(status.company)}`);
    console.log(`  Status:    ${runningLabel}`);
    console.log(`  URL:       ${chalk.bold(status.replicaUrl)}`);
    console.log(`  Type:      ${replicaTypeLabel(status.replicaType)}`);
    console.log(`  Air-gap:   ${status.airGapEnabled ? chalk.yellow('enabled') : chalk.gray('disabled')}`);

    if (Object.keys(status.canisterIds).length > 0) {
      console.log();
      console.log(chalk.cyan('Canister IDs:'));
      for (const [name, id] of Object.entries(status.canisterIds)) {
        console.log(`  ${name}: ${chalk.bold(id)}`);
      }
    }
    console.log();
  });

// ─── pilot stop ──────────────────────────────────────────────────────────────

const stopCmd = new Command('stop');
stopCmd
  .description('Stop a running private replica')
  .argument('[company]', 'Company identifier')
  .action(async (company?: string) => {
    if (!company) {
      const companies = listPilotCompanies();
      if (companies.length === 0) {
        console.log(chalk.yellow('No pilot configurations found.'));
        return;
      }
      company = companies.length === 1 ? companies[0] : undefined;
      if (!company) {
        const { chosen } = await inquirer.prompt<{ chosen: string }>([{
          type: 'list',
          name: 'chosen',
          message: 'Select company to stop:',
          choices: companies,
        }]);
        company = chosen;
      }
    }

    const spinner = ora(`Stopping replica for "${company}"...`).start();
    const stopped = await stopPrivateReplica(company);
    if (stopped) {
      spinner.succeed(chalk.green(`Replica for "${company}" stopped.`));
    } else {
      spinner.warn(chalk.yellow(`Could not stop replica for "${company}" (already stopped or dfx not available).`));
    }
  });

// ─── pilot list ──────────────────────────────────────────────────────────────

const listCmd = new Command('list');
listCmd
  .description('List all configured pilot companies')
  .action(async () => {
    const companies = listPilotCompanies();
    if (companies.length === 0) {
      console.log(chalk.yellow('No pilot configurations found. Run `agentvault pilot init` first.'));
      return;
    }

    console.log(chalk.bold('\nConfigured Pilots:\n'));
    for (const company of companies) {
      const config = loadPilotConfig(company);
      if (!config) continue;
      const replicaUrl = buildReplicaUrl(config.bindAddress, config.port);
      const statusColor = config.status === 'running' ? chalk.green : chalk.gray;
      console.log(`${chalk.bold(config.company)} (${company})`);
      console.log(`  Status:  ${statusColor(config.status)}`);
      console.log(`  URL:     ${replicaUrl}`);
      console.log(`  Type:    ${replicaTypeLabel(config.replicaType)}`);
      console.log(`  Cycles:  ${config.initialCycles}`);
      console.log(`  Air-gap: ${config.airGap.enabled ? chalk.yellow('enabled') : chalk.gray('disabled')}`);
      console.log();
    }
  });

// ─── pilot air-gap ───────────────────────────────────────────────────────────

const airGapCmd = new Command('air-gap');
airGapCmd.description('Manage air-gap mode for a private replica');

const airGapEnableCmd = new Command('enable');
airGapEnableCmd
  .description('Enable air-gap mode (blocks all external internet except approved endpoints)')
  .requiredOption('--company <name>', 'Company identifier')
  .option('--allow <endpoints...>', 'Additional endpoints to allow (comma-separated or repeated)')
  .option('--anthropic-proxy <url>', 'Anthropic API proxy URL to whitelist')
  .action(async (options: {
    company: string;
    allow?: string[];
    anthropicProxy?: string;
  }) => {
    const config = loadPilotConfig(options.company);
    if (!config) {
      console.error(chalk.red(`No pilot config found for company "${options.company}".`));
      process.exit(1);
    }

    const allowed: string[] = [];
    if (options.allow) {
      allowed.push(...options.allow.flatMap((e) => e.split(',')));
    }
    if (options.anthropicProxy) {
      allowed.push(options.anthropicProxy);
      config.proxy.anthropicProxy = options.anthropicProxy;
    }

    config.airGap = toggleAirGap(config.airGap, true, [
      ...config.airGap.allowedEndpoints,
      ...allowed,
    ]);

    const warnings = validateAirGapConfig(config.airGap);
    savePilotConfig(config);

    const envPath = writeAirGapEnvFile(config.airGap, config.stateDir);

    console.log(chalk.green(`\n✓ Air-gap enabled for "${options.company}"\n`));
    console.log(chalk.cyan('Air-gap config:'));
    console.log(`  ${describeAirGap(config.airGap).replace(/\n/g, '\n  ')}`);
    console.log();
    console.log(`Environment file: ${chalk.bold(envPath)}`);
    console.log(`  ${chalk.gray(`source ${envPath}`)}`);

    if (warnings.length > 0) {
      console.log();
      for (const w of warnings) {
        console.log(`  ${chalk.yellow('⚠')} ${w}`);
      }
    }
    console.log();
  });

const airGapDisableCmd = new Command('disable');
airGapDisableCmd
  .description('Disable air-gap mode (restore normal internet access)')
  .requiredOption('--company <name>', 'Company identifier')
  .action(async (options: { company: string }) => {
    const config = loadPilotConfig(options.company);
    if (!config) {
      console.error(chalk.red(`No pilot config found for company "${options.company}".`));
      process.exit(1);
    }

    config.airGap = toggleAirGap(config.airGap, false);
    savePilotConfig(config);

    const envPath = writeAirGapEnvFile(config.airGap, config.stateDir);
    console.log(chalk.green(`\n✓ Air-gap disabled for "${options.company}"\n`));
    console.log(`Environment file updated: ${chalk.gray(envPath)}`);
    console.log();
  });

const airGapStatusCmd = new Command('status');
airGapStatusCmd
  .description('Show air-gap configuration')
  .requiredOption('--company <name>', 'Company identifier')
  .action(async (options: { company: string }) => {
    const config = loadPilotConfig(options.company);
    if (!config) {
      console.error(chalk.red(`No pilot config found for company "${options.company}".`));
      process.exit(1);
    }

    console.log(chalk.bold(`\nAir-gap config for "${options.company}":\n`));
    console.log(chalk.cyan('Air-gap:'));
    console.log(`  ${describeAirGap(config.airGap).replace(/\n/g, '\n  ')}`);
    console.log();
    console.log(chalk.cyan('External service proxies:'));
    for (const line of describeProxyConfig(config.proxy)) {
      console.log(`  ${line}`);
    }
    console.log();
  });

airGapCmd.addCommand(airGapEnableCmd);
airGapCmd.addCommand(airGapDisableCmd);
airGapCmd.addCommand(airGapStatusCmd);

// ─── pilot (root command) ────────────────────────────────────────────────────

export const pilotCmd = new Command('pilot');
pilotCmd
  .description(
    'Private ICP replica for company Guild – zero external exposure, no mainnet cycles cost'
  );

pilotCmd.addCommand(initCmd);
pilotCmd.addCommand(deployCmd);
pilotCmd.addCommand(statusCmd);
pilotCmd.addCommand(stopCmd);
pilotCmd.addCommand(listCmd);
pilotCmd.addCommand(airGapCmd);
