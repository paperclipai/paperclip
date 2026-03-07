/**
 * Package command - Compile agent to WASM for deployment
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'node:path';
import { packageAgent, getPackageSummary } from '../../src/packaging/index.js';
import type { PackageOptions, PackageResult } from '../../src/packaging/index.js';

export interface PackageCommandOptions {
  output?: string;
  force?: boolean;
  skipValidation?: boolean;
  dryRun?: boolean;
  target?: 'wasmedge' | 'motoko' | 'pure-wasm';
  debug?: boolean;
  optimize?: number;
  icWasmOptimize?: boolean;
  icWasmShrink?: boolean;
  validate?: string;
  memoryLimit?: string;
  computeQuota?: string;
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
 * Display package preview (dry-run)
 */
export function displayPreview(sourcePath: string): void {
  const { config, validation } = getPackageSummary(sourcePath);

  console.log(chalk.bold('\nPackage Preview\n'));
  console.log(chalk.cyan('Agent Configuration:'));
  console.log(`  Name:        ${chalk.bold(config.name)}`);
  console.log(`  Type:        ${chalk.bold(config.type)}`);
  console.log(`  Source:      ${config.sourcePath}`);
  console.log(`  Entry Point: ${config.entryPoint ?? chalk.yellow('not detected')}`);
  console.log(`  Version:     ${config.version ?? chalk.yellow('not specified')}`);
  
  // Display agent settings for Clawdbot agents if available
  if (config.type === 'clawdbot' && 'settings' in config) {
    const settings = config.settings as Record<string, unknown>;
    console.log();
    console.log(chalk.cyan('Agent Settings:'));
    if (settings.model) {
      console.log(`  Model: ${chalk.bold(settings.model)}`);
    }
    if (settings.temperature !== undefined) {
      console.log(`  Temperature: ${chalk.bold(String(settings.temperature))}`);
    }
    if (settings.maxTokens !== undefined) {
      console.log(`  Max Tokens: ${chalk.bold(String(settings.maxTokens))}`);
    }
  }

  console.log();

  if (validation.warnings.length > 0) {
    console.log(chalk.yellow('Warnings:'));
    for (const warning of validation.warnings) {
      console.log(chalk.yellow(`  ⚠ ${warning}`));
    }
    console.log();
  }

  if (validation.errors.length > 0) {
    console.log(chalk.red('Errors:'));
    for (const error of validation.errors) {
      console.log(chalk.red(`  ✖ ${error.message}`));
    }
    console.log();
  }

  console.log(chalk.cyan('Output Files:'));
  console.log(`  ${config.name}.wasm      - Compiled WebAssembly module`);
  console.log(`  ${config.name}.wat       - WebAssembly text format`);
  console.log(`  ${config.name}.state.json - Initial agent state`);
}

/**
 * Display package result
 */
export function displayResult(result: PackageResult): void {
  console.log();
  console.log(chalk.green('✓'), 'Agent packaged successfully!');
  console.log();
  console.log(chalk.cyan('Compilation:'));
  console.log(`  Target:    ${chalk.bold(result.target.toUpperCase())}`);
  console.log(`  Duration:  ${result.duration ? `${result.duration}ms` : 'N/A'}`);
  console.log();
  console.log(chalk.cyan('Output Files:'));
  console.log(`  WASM:     ${result.wasmPath} (${formatSize(result.wasmSize)})`);
  console.log(`  WAT:      ${result.watPath}`);
  console.log(`  State:    ${result.statePath}`);
  if (result.jsBundlePath) {
    console.log(`  JS Bundle: ${result.jsBundlePath}`);
  }
  if (result.sourceMapPath) {
    console.log(`  Source Map: ${result.sourceMapPath}`);
  }
  if (result.manifestPath) {
    console.log(`  Manifest:  ${result.manifestPath}`);
  }
  // Display optimization results if available
  if (result.originalWasmSize !== undefined) {
    console.log(chalk.cyan('Optimization:'));
    console.log(`  Original: ${formatSize(result.originalWasmSize)}`);
    console.log(`  Optimized: ${formatSize(result.wasmSize)}`);
    if (result.optimizationReductionPercent !== undefined) {
      console.log(`  Reduction: ${result.optimizationReductionPercent}%`);
    }
    if (result.candidValidationPassed !== undefined) {
      const status = result.candidValidationPassed
        ? chalk.green('passed')
        : chalk.red('failed');
      console.log(`  Candid Validation: ${status}`);
    }
    if (result.optimizationWarnings && result.optimizationWarnings.length > 0) {
      for (const warning of result.optimizationWarnings) {
        console.log(chalk.yellow(`  Warning: ${warning}`));
      }
    }
    console.log();
  }

  console.log(chalk.cyan('Next steps:'));
  console.log('  1. Review the generated files');
  console.log('  2. Run', chalk.bold('agentvault deploy'), 'to upload to ICP');
}

/**
 * Execute the package command
 */
export async function executePackage(
  sourcePath: string,
  options: PackageCommandOptions
): Promise<PackageResult | null> {
  // Handle dry-run mode
  if (options.dryRun) {
    displayPreview(sourcePath);
    return null;
  }

  const spinner = ora('Packaging agent...').start();

  try {
    // Prepare package options
    const packageOptions: PackageOptions = {
      sourcePath,
      outputPath: options.output ? path.resolve(options.output) : undefined,
      force: options.force,
      skipValidation: options.skipValidation,
      target: options.target,
      debug: options.debug,
      optimize: options.optimize,
      icWasmOptimize: options.icWasmOptimize,
      icWasmShrink: options.icWasmShrink,
      candidInterface: options.validate,
      memoryLimit: options.memoryLimit,
      computeQuota: options.computeQuota,
    };

    // Execute packaging
    const result = await packageAgent(packageOptions);

    spinner.succeed(`Agent '${result.config.name}' packaged successfully!`);
    displayResult(result);

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Packaging failed: ${message}`);
    throw error;
  }
}

/**
 * Create the package command
 */
export function packageCommand(): Command {
  const command = new Command('package');

  command
    .description('Compile agent to WASM for deployment to ICP')
    .argument('[source]', 'path to agent source directory', '.')
    .option('-o, --output <path>', 'output directory for compiled files')
    .option('-f, --force', 'overwrite existing output files')
    .option('--skip-validation', 'skip validation checks')
    .option('--dry-run', 'show what would be packaged without executing')
    .option('-t, --target <target>', 'compilation target (wasmedge|motoko|pure-wasm)', 'wasmedge')
    .option('--debug', 'enable debugging features (source maps, verbose output)')
    .option('--optimize <level>', 'optimization level (0-3)', '2')
    .option('--ic-wasm-optimize', 'optimize WASM with ic-wasm (requires ic-wasm)')
    .option('--ic-wasm-shrink', 'shrink WASM with ic-wasm (requires ic-wasm)')
    .option('--validate <did-file>', 'validate WASM endpoints against Candid .did file')
    .option('--memory-limit <limit>', 'set canister memory limit (e.g. 4GiB)')
    .option('--compute-quota <quota>', 'set canister compute quota')
    .action(async (source: string, options: PackageCommandOptions) => {
      console.log(chalk.bold('\n📦 AgentVault Package\n'));

      try {
        await executePackage(source, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(chalk.red(`\nError: ${message}`));
        process.exit(1);
      }
    });

  return command;
}
