/**
 * Rebuild command - Rebuild local agent from canister state
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileToWasm } from '../../src/packaging/compiler.js';

export interface RebuildCommandOptions {
  output?: string;
  force?: boolean;
  skipCompile?: boolean;
  target?: 'wasmedge' | 'motoko' | 'pure-wasm';
  debug?: boolean;
  optimize?: number;
}

export interface RebuildAnswers {
  confirm: boolean;
}

export async function executeRebuild(
  stateFile: string,
  options: RebuildCommandOptions
): Promise<void> {
  const resolvedPath = path.resolve(stateFile);

  // Validate state file exists
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`State file not found: ${resolvedPath}`);
  }

  const spinner = ora('Reading agent state...').start();

  let state: any;

  try {
    // Read and parse state
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    state = JSON.parse(content);

    spinner.succeed('Agent state loaded successfully!');

    console.log();
    console.log(chalk.cyan('Agent Configuration:'));
    console.log(`  Name:        ${chalk.bold(state.config.name)}`);
    console.log(`  Type:        ${state.config.type}`);
    console.log(`  Source:      ${state.config.sourcePath}`);
    console.log(`  Version:     ${state.config.version ?? 'N/A'}`);

    console.log();
    console.log(chalk.cyan('State Info:'));
    console.log(`  Memories:    ${state.memories?.length || 0}`);
    console.log(`  Tasks:       ${state.tasks?.length || 0}`);
    console.log(`  Context:     ${Object.keys(state.context || {}).length} entries`);

    console.log();
    console.log(chalk.yellow('Agent tasks can be resumed'));
    console.log('Context is preserved');

    spinner.stop();
  } catch (error) {
    spinner.stop();
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to parse state file: ${message}`);
  }

  // Check if source directory exists
  if (!fs.existsSync(state.config.sourcePath)) {
    console.log();
    console.log(chalk.yellow('⚠'), 'Source directory not found:', state.config.sourcePath);
    console.log();
    console.log('You need to provide a source code to rebuild agent.');
    console.log('Options:');
    console.log('  1. Clone original repository');
    console.log('  2. Provide a new source directory');

    spinner.stop();
    return;
  }

  // Confirm rebuild
  if (!options.force) {
    const { confirm } = await inquirer.prompt<RebuildAnswers>([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Rebuild agent with this configuration?',
        default: true,
      },
    ]);

    if (!confirm) {
      console.log(chalk.yellow('\nRebuild cancelled.'));
      spinner.stop();
      return;
    }
  }

  // Skip compilation if requested
  if (options.skipCompile) {
    console.log();
    console.log(chalk.green('✓'), 'Rebuild skipped compilation step.');
    console.log();
    console.log(chalk.cyan('Agent state ready for use'));
    console.log('Memories can be restored');

    spinner.stop();
    return;
  }

  // Compile agent to WASM
  const compileSpinner = ora('Compiling agent to WASM...').start();

  try {
    const compileOptions = {
      sourcePath: state.config.sourcePath,
      target: options.target ?? 'wasmedge' as const,
      debug: options.debug ?? false,
      optimize: options.optimize ?? 2,
    };

    const result = await compileToWasm(state.config, compileOptions, path.dirname(resolvedPath));

    compileSpinner.succeed(`Agent compiled successfully!`);

    console.log();
    console.log(chalk.cyan('Output Files:'));
    console.log(`  WASM:  ${result.wasmPath}`);
    console.log(`  WAT:   ${result.watPath}`);
    console.log(`  State: ${result.statePath}`);

    console.log();
    console.log(chalk.green('✓'), 'Agent rebuilt successfully!');
    console.log();
    console.log(chalk.cyan('Next steps:'));
    console.log('  1. Test rebuilt agent locally');
    console.log('  2. Deploy with:', chalk.bold('agentvault deploy'));
  } catch (error) {
    compileSpinner.fail('Compilation failed');
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Rebuild failed: ${message}`);
    throw error;
  }
}

/**
 * Create rebuild command
 */
export function rebuildCommand(): Command {
  const command = new Command('rebuild');

  command
    .description('Rebuild local agent from canister state')
    .argument('<state-file>', 'agent state file (JSON)')
    .option('-o, --output <path>', 'output directory for rebuilt agent')
    .option('-f, --force', 'skip confirmation prompts')
    .option('--skip-compile', 'skip WASM compilation')
    .option('-t, --target <target>', 'compilation target (wasmedge|motoko|pure-wasm)', 'wasmedge')
    .option('--debug', 'enable debugging features')
    .option('--optimize <level>', 'optimization level (0-3)', '2')
    .action(async (stateFile: string, options: RebuildCommandOptions) => {
      console.log(chalk.bold('\n🔧 AgentVault Rebuild\n'));

      try {
        await executeRebuild(stateFile, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(chalk.red(`\nError: ${message}`));
        process.exit(1);
      }
    });

  return command;
}
