/**
 * Test CLI commands
 *
 * Provides commands for running unit, integration, and load tests against canisters
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { runTests, runLoadTests } from '../../src/testing/local-runner.js';
import type { TestRunnerOptions, TestType, TestSuite } from '../../src/testing/types.js';

export const testCmd = new Command('test');

testCmd
  .description('Run tests against canisters')
  .argument('<agent-name>', 'Agent name to test')
  .option('-n, --network <net>', 'Network to run tests against')
  .option('-t, --type <type>', 'Test type (unit, integration, load-test)', 'unit')
  .option('-w, --watch', 'Watch mode for TDD', false)
  .option('-o, --output-format <format>', 'Output format (json, junit, html)', 'json')
  .option('-v, --verbose', 'Verbose output', false)
  .option('--concurrency <num>', 'Load test concurrency')
  .option('--load-duration <seconds>', 'Load test duration in seconds')
  .option('--canister-id <id>', 'Canister ID for load test')
  .option('--method <name>', 'Method name for load test')
  .option('--args <args>', 'Arguments for load test method (Candid format)')
  .action(async (agentName, options) => {
    const testType = options.type as TestType;
    
    if (testType === 'load-test') {
      if (!options.canisterId) {
        console.error(chalk.red('Error: --canister-id is required for load tests'));
        process.exit(1);
      }
      if (!options.method) {
        console.error(chalk.red('Error: --method is required for load tests'));
        process.exit(1);
      }
      const concurrency = options.concurrency ? parseInt(options.concurrency, 10) : 10;
      const loadDuration = options.loadDuration ? parseInt(options.loadDuration, 10) : 30;

      const spinner = ora(`Running load test on ${options.canisterId}...`).start();

      try {
        const result = await runLoadTests({
          concurrency,
          duration: loadDuration,
          canisterId: options.canisterId,
          method: options.method,
          args: options.args,
        });

        spinner.succeed(chalk.green('Load test completed'));

        console.log(chalk.bold('\nLoad Test Results:'));
        console.log(chalk.gray(`  Total requests: ${result.totalRequests}`));
        console.log(chalk.gray(`  Successful: ${chalk.green(result.successfulRequests)}`));
        console.log(chalk.gray(`  Failed: ${chalk.red(result.failedRequests)}`));
        console.log(chalk.gray(`  Requests/sec: ${result.requestsPerSecond.toFixed(2)}`));
        console.log();
        console.log(chalk.bold('Response Times:'));
        console.log(chalk.gray(`  Average: ${result.avgResponseTime.toFixed(2)}ms`));
        console.log(chalk.gray(`  Min: ${result.minResponseTime}ms`));
        console.log(chalk.gray(`  Max: ${result.maxResponseTime}ms`));
        console.log();
        console.log(chalk.bold('Percentiles:'));
        console.log(chalk.gray(`  p50: ${result.percentiles.p50.toFixed(2)}ms`));
        console.log(chalk.gray(`  p90: ${result.percentiles.p90.toFixed(2)}ms`));
        console.log(chalk.gray(`  p95: ${result.percentiles.p95.toFixed(2)}ms`));
        console.log(chalk.gray(`  p99: ${result.percentiles.p99.toFixed(2)}ms`));
        
        if (Object.keys(result.errors).length > 0) {
          console.log();
          console.log(chalk.bold('Errors:'));
          for (const [error, count] of Object.entries(result.errors)) {
            console.log(chalk.red(`  ${count}x: ${error.substring(0, 100)}${error.length > 100 ? '...' : ''}`));
          }
        }
      } catch (error) {
        spinner.fail(chalk.red('Load test failed'));
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(chalk.red(message));
        process.exit(1);
      }
    } else {
      const testOptions: TestRunnerOptions = {
        agentName,
        network: options.network || 'local',
        testType,
        watch: options.watch,
        outputFormat: options.outputFormat as 'json' | 'junit' | 'html',
        verbose: options.verbose,
      };

      const spinner = ora(`Running ${testType} tests...`).start();

      try {
        const result = await runTests(testOptions);

        spinner.succeed(chalk.green('Tests completed'));

        if (typeof result === 'object' && 'total' in result) {
          const testSuite = result as TestSuite;
          console.log(chalk.bold('\nTest Summary:'));
          console.log(chalk.gray(`  Total: ${testSuite.total}`));
          console.log(chalk.gray(`  Passed: ${chalk.green(testSuite.passed)}`));
          console.log(chalk.gray(`  Failed: ${chalk.red(testSuite.failed)}`));
          console.log(chalk.gray(`  Skipped: ${chalk.yellow(testSuite.skipped)}`));
          console.log(chalk.gray(`  Duration: ${testSuite.duration}ms`));
        }
      } catch (error) {
        spinner.fail(chalk.red('Tests failed'));
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(chalk.red(message));
        process.exit(1);
      }
    }
  });
