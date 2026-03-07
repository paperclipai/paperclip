/**
 * Local test runner for canister testing
 *
 * Provides test execution for unit, integration, and load tests against local canisters
 */

import { execa } from 'execa';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type {
  TestRunnerOptions,
  TestSuite,
  LoadTestConfig,
  LoadTestResult,
} from './types.js';

const AGENTVAULT_DIR = path.join(os.homedir(), '.agentvault');
const TEST_RESULTS_DIR = path.join(AGENTVAULT_DIR, 'test-results');

/**
 * Ensure test results directory exists
 */
function ensureTestResultsDir(): void {
  if (!fs.existsSync(AGENTVAULT_DIR)) {
    fs.mkdirSync(AGENTVAULT_DIR, { recursive: true });
  }
  if (!fs.existsSync(TEST_RESULTS_DIR)) {
    fs.mkdirSync(TEST_RESULTS_DIR, { recursive: true });
  }
}

/**
 * Get test results file path
 */
function getTestResultsPath(agentName: string, testType: string): string {
  ensureTestResultsDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(TEST_RESULTS_DIR, `${agentName}-${testType}-${timestamp}.json`);
}

/**
 * Parse vitest output to extract test results
 */
function parseVitestOutput(stdout: string): TestSuite {
  const lines = stdout.split('\n');
  const tests: TestSuite['tests'] = [];
  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let duration = 0;

  for (const line of lines) {
    const match = line.match(/^(PASS|FAIL|SKIP)\s+(.+) \((\d+)ms\)$/);
    if (match) {
      const [, status, nameRaw, timeRaw] = match;
      const name = nameRaw?.trim() || 'unknown';
      const time = timeRaw || '0';
      tests.push({
        name,
        status: status === 'PASS' ? 'passed' : status === 'FAIL' ? 'failed' : 'skipped',
        duration: parseInt(time, 10),
      });
      total++;
      if (status === 'PASS') passed++;
      else if (status === 'FAIL') failed++;
      else skipped++;
    }

    const durationMatch = line.match(/Test Files\s+(\d+)\s+passed\s+\((\d+)\)/);
    if (durationMatch && durationMatch[2]) {
      duration = parseInt(durationMatch[2], 10);
    }
  }

  return {
    name: 'canister-tests',
    total,
    passed,
    failed,
    skipped,
    duration,
    tests,
  };
}

/**
 * Run unit tests
 */
export async function runUnitTests(options: TestRunnerOptions): Promise<TestSuite> {
  const vitestArgs = [
    'run',
    '--reporter=verbose',
  ];

  if (options.network) {
    vitestArgs.push(`--env.network=${options.network}`);
  }

  if (options.outputFormat === 'json') {
    vitestArgs.push('--reporter=json');
  }

  vitestArgs.push('tests/unit');

  const result = await execa('npx', ['vitest', ...vitestArgs], {
    reject: false,
    timeout: 120_000,
  });

  const testSuite = parseVitestOutput(result.stdout);

  if (options.outputFormat === 'json') {
    const resultsPath = getTestResultsPath(options.agentName, 'unit');
    fs.writeFileSync(resultsPath, JSON.stringify(testSuite, null, 2), 'utf8');
    console.log(`Test results saved to ${resultsPath}`);
  }

  return testSuite;
}

/**
 * Run integration tests
 */
export async function runIntegrationTests(options: TestRunnerOptions): Promise<TestSuite> {
  const vitestArgs = [
    'run',
    '--reporter=verbose',
  ];

  if (options.network) {
    vitestArgs.push(`--env.network=${options.network}`);
  }

  if (options.outputFormat === 'json') {
    vitestArgs.push('--reporter=json');
  }

  vitestArgs.push('tests/integration');

  const result = await execa('npx', ['vitest', ...vitestArgs], {
    reject: false,
    timeout: 300_000,
  });

  const testSuite = parseVitestOutput(result.stdout);

  if (options.outputFormat === 'json') {
    const resultsPath = getTestResultsPath(options.agentName, 'integration');
    fs.writeFileSync(resultsPath, JSON.stringify(testSuite, null, 2), 'utf8');
    console.log(`Test results saved to ${resultsPath}`);
  }

  return testSuite;
}

/**
 * Run load tests
 */
export async function runLoadTests(config: LoadTestConfig): Promise<LoadTestResult> {
  const errors: Record<string, number> = {};
  let totalRequests = 0;
  let successfulRequests = 0;
  let failedRequests = 0;
  const responseTimes: number[] = [];
  const startTime = Date.now();
  const endTime = startTime + (config.duration * 1000);
  const interval = config.duration * 1000 / (config.concurrency * 10);

  const requestPromises: Array<Promise<{ success: boolean; responseTime: number; error?: string }>> = [];

  for (let i = 0; i < config.concurrency * 10; i++) {
    if (Date.now() >= endTime) break;

    const startTimeMs = Date.now();

    const request = execa('npx', ['icp', 'canister', 'call', config.canisterId, config.method, ...(config.args ? [config.args] : [])], {
      reject: false,
      timeout: 30_000,
    });

    const requestPromise = request.then((result) => {
      const responseTime = Date.now() - startTimeMs;
      if (result.exitCode === 0) {
        return { success: true, responseTime };
      } else {
        const error = result.stderr || 'Unknown error';
        errors[error] = (errors[error] || 0) + 1;
        return { success: false, responseTime, error };
      }
    });

    requestPromises.push(requestPromise);

    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  const results = await Promise.all(requestPromises);

  for (const result of results) {
    totalRequests++;
    if (result.success) {
      successfulRequests++;
      responseTimes.push(result.responseTime);
    } else {
      failedRequests++;
      if (result.error) {
        errors[result.error] = (errors[result.error] || 0) + 1;
      }
    }
  }

  const actualDuration = (Date.now() - startTime) / 1000;
  const requestsPerSecond = totalRequests / actualDuration;

  const sortedTimes = responseTimes.sort((a, b) => a - b);
  const minResponseTime = sortedTimes[0] || 0;
  const maxResponseTime = sortedTimes[sortedTimes.length - 1] || 0;
  const avgResponseTime = responseTimes.length > 0 
    ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length 
    : 0;

  const percentiles = {
    p50: sortedTimes[Math.floor(sortedTimes.length * 0.5)] || 0,
    p90: sortedTimes[Math.floor(sortedTimes.length * 0.9)] || 0,
    p95: sortedTimes[Math.floor(sortedTimes.length * 0.95)] || 0,
    p99: sortedTimes[Math.floor(sortedTimes.length * 0.99)] || 0,
  };

  return {
    totalRequests,
    successfulRequests,
    failedRequests,
    requestsPerSecond,
    avgResponseTime,
    minResponseTime,
    maxResponseTime,
    percentiles,
    errors,
  };
}

/**
 * Run tests based on options
 */
export async function runTests(options: TestRunnerOptions): Promise<TestSuite | LoadTestResult> {
  switch (options.testType) {
    case 'unit':
      return runUnitTests(options);
    case 'integration':
      return runIntegrationTests(options);
    case 'load-test':
      if (!options.concurrency) {
        throw new Error('Concurrency is required for load tests');
      }
      if (!options.loadDuration) {
        throw new Error('Load duration is required for load tests');
      }
      throw new Error('Load test requires specific LoadTestConfig');
    default:
      throw new Error(`Unknown test type: ${options.testType}`);
  }
}
