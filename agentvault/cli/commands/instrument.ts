/**
 * Instrument CLI command
 *
 * Provides command for instrumenting WASM files for debugging
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { instrument } from '../../src/icp/icwasm.js';

export const instrumentCmd = new Command('instrument');

instrumentCmd
  .description('Instrument WASM file for debugging')
  .argument('<input-wasm>', 'Input WASM file path')
  .option('-o, --output <path>', 'Output WASM file path')
  .action(async (inputWasm, options) => {
    const outputPath = options.output || inputWasm.replace(/\.wasm$/, '.instrumented.wasm');
    const spinner = ora(`Instrumenting ${inputWasm}...`).start();

    try {
      const result = await instrument({ input: inputWasm, output: outputPath });

      if (!result.success) {
        spinner.fail(chalk.red('Instrumentation failed'));
        console.error(chalk.red(result.stderr));
        process.exit(1);
      }

      spinner.succeed(chalk.green(`Instrumented WASM saved to ${outputPath}`));
      console.log(chalk.gray(result.stdout));
    } catch (error) {
      spinner.fail(chalk.red('Failed to instrument WASM'));
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(chalk.red(message));
      process.exit(1);
    }
  });
