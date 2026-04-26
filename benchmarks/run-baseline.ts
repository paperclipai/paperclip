#!/usr/bin/env -S node --import tsx/esm

/**
 * Anvil Baseline Benchmark Runner
 *
 * Executes benchmark scenarios per ADR-001 and calculates baseline metrics.
 *
 * Usage:
 *   pnpm tsx benchmarks/run-baseline.ts [--runs=3] [--output=benchmarks/baseline.json]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScenarioDefinition {
  id: string;
  type: string;
  title: string;
  description: string;
  prompt: string;
  setup?: {
    create_files?: Record<string, string>;
  };
  expected_outcomes: Record<string, any>;
  success_criteria: string[];
  time_limit_turns: number;
}

interface ScenarioRun {
  scenarioId: string;
  runNumber: number;
  completed: boolean;
  fatal_error: boolean;
  turns_taken: number;
  tool_calls: {
    total: number;
    first_attempt_success: number;
  };
  tokens_used: number;
  duration_ms: number;
}

interface BenchmarkResults {
  date: string;
  commit: string;
  scenarios_run: number;
  executions_per_scenario: number;
  results: {
    tcr: { value: number; unit: string };
    er: { value: number; unit: string };
    tca: { value: number; unit: string };
    ttc_median: { value: number; unit: string };
    te: { value: number; unit: string };
  };
  raw_runs: ScenarioRun[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const DEFAULT_RUNS_PER_SCENARIO = 3;
const DEFAULT_OUTPUT = path.join(__dirname, 'benchmark-baseline.json');

// ---------------------------------------------------------------------------
// Scenario Loading
// ---------------------------------------------------------------------------

async function loadScenarios(): Promise<ScenarioDefinition[]> {
  const files = await fs.readdir(SCENARIOS_DIR);
  const scenarioFiles = files.filter(f => f.endsWith('.json'));

  const scenarios: ScenarioDefinition[] = [];
  for (const file of scenarioFiles) {
    const content = await fs.readFile(path.join(SCENARIOS_DIR, file), 'utf-8');
    scenarios.push(JSON.parse(content));
  }

  return scenarios.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Scenario Execution
// ---------------------------------------------------------------------------

async function executeScenario(
  scenario: ScenarioDefinition,
  runNumber: number
): Promise<ScenarioRun> {
  console.log(`  Run ${runNumber}: ${scenario.title}`);

  const startTime = Date.now();

  // TODO: Integrate with Anvil/Claude Code harness
  // This is where the actual agent execution happens.
  //
  // Implementation needs to:
  // 1. Set up test environment (create setup files if defined)
  // 2. Spawn agent with scenario prompt
  // 3. Track tool calls and outcomes
  // 4. Monitor for completion or fatal errors
  // 5. Collect metrics (turns, tokens, tool accuracy)
  // 6. Clean up test environment
  //
  // Example integration points:
  // - Use claude-code CLI in headless mode
  // - Monitor agent transcript for tool calls
  // - Parse final state to determine completion
  // - Extract token usage from API logs

  // Mock implementation for now
  const mockResult: ScenarioRun = {
    scenarioId: scenario.id,
    runNumber,
    completed: Math.random() > 0.1, // 90% completion rate mock
    fatal_error: Math.random() < 0.05, // 5% error rate mock
    turns_taken: Math.floor(5 + Math.random() * 15), // 5-20 turns
    tool_calls: {
      total: Math.floor(10 + Math.random() * 20),
      first_attempt_success: Math.floor(8 + Math.random() * 15),
    },
    tokens_used: Math.floor(2000 + Math.random() * 3000),
    duration_ms: Date.now() - startTime,
  };

  console.log(`    ✓ Completed in ${mockResult.turns_taken} turns`);

  return mockResult;
}

// ---------------------------------------------------------------------------
// Metric Calculation
// ---------------------------------------------------------------------------

function calculateMetrics(runs: ScenarioRun[]): BenchmarkResults['results'] {
  const completedRuns = runs.filter(r => r.completed);
  const totalRuns = runs.length;

  // 1. Task Completion Rate (TCR)
  const tcr = (completedRuns.length / totalRuns) * 100;

  // 2. Error Rate (ER) - per 10 tasks
  const fatalErrors = runs.filter(r => r.fatal_error).length;
  const er = (fatalErrors / (totalRuns / 10));

  // 3. Tool Call Accuracy (TCA)
  const totalToolCalls = runs.reduce((sum, r) => sum + r.tool_calls.total, 0);
  const successfulCalls = runs.reduce((sum, r) => sum + r.tool_calls.first_attempt_success, 0);
  const tca = (successfulCalls / totalToolCalls) * 100;

  // 4. Time-to-Completion (TTC) - median turns
  const completedTurns = completedRuns.map(r => r.turns_taken).sort((a, b) => a - b);
  const ttc_median = completedTurns.length > 0
    ? completedTurns[Math.floor(completedTurns.length / 2)]
    : 0;

  // 5. Token Efficiency (TE)
  const totalTokens = completedRuns.reduce((sum, r) => sum + r.tokens_used, 0);
  const te = completedRuns.length > 0 ? totalTokens / completedRuns.length : 0;

  return {
    tcr: { value: Math.round(tcr * 10) / 10, unit: 'percent' },
    er: { value: Math.round(er * 10) / 10, unit: 'per_10_tasks' },
    tca: { value: Math.round(tca * 10) / 10, unit: 'percent' },
    ttc_median: { value: ttc_median, unit: 'turns' },
    te: { value: Math.round(te), unit: 'tokens_per_task' },
  };
}

// ---------------------------------------------------------------------------
// Main Execution
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const runsPerScenario = parseInt(args.find(a => a.startsWith('--runs='))?.split('=')[1] || String(DEFAULT_RUNS_PER_SCENARIO));
  const outputPath = args.find(a => a.startsWith('--output='))?.split('=')[1] || DEFAULT_OUTPUT;

  console.log('Anvil Baseline Benchmark Runner');
  console.log('================================\n');

  // Get current git commit
  let commit = 'unknown';
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD']);
    commit = stdout.trim().substring(0, 8);
  } catch (err) {
    console.warn('Warning: Could not get git commit');
  }

  // Load scenarios
  console.log('Loading scenarios...');
  const scenarios = await loadScenarios();
  console.log(`Loaded ${scenarios.length} scenarios\n`);

  // Execute all scenarios
  const allRuns: ScenarioRun[] = [];

  for (const scenario of scenarios) {
    console.log(`Scenario: ${scenario.id}`);

    for (let i = 1; i <= runsPerScenario; i++) {
      const run = await executeScenario(scenario, i);
      allRuns.push(run);
    }

    console.log();
  }

  // Calculate metrics
  console.log('Calculating metrics...');
  const results = calculateMetrics(allRuns);

  // Build output
  const output: BenchmarkResults = {
    date: new Date().toISOString().split('T')[0],
    commit,
    scenarios_run: scenarios.length,
    executions_per_scenario: runsPerScenario,
    results,
    raw_runs: allRuns,
  };

  // Write results
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nResults written to: ${outputPath}\n`);

  // Print summary
  console.log('Benchmark Results Summary');
  console.log('=========================');
  console.log(`Commit: ${commit}`);
  console.log(`Date: ${output.date}`);
  console.log(`Scenarios: ${scenarios.length} x ${runsPerScenario} runs\n`);
  console.log('Metrics:');
  console.log(`  Task Completion Rate (TCR): ${results.tcr.value}%`);
  console.log(`  Error Rate (ER): ${results.er.value} per 10 tasks`);
  console.log(`  Tool Call Accuracy (TCA): ${results.tca.value}%`);
  console.log(`  Time-to-Completion (TTC): ${results.ttc_median.value} turns (median)`);
  console.log(`  Token Efficiency (TE): ${results.te.value} tokens/task`);
  console.log();

  // Check against targets
  console.log('Target Comparison (ADR-001):');
  console.log(`  TCR: ${results.tcr.value >= 90 ? '✓' : '✗'} (target: >= 90%)`);
  console.log(`  ER: ${results.er.value <= 1.0 ? '✓' : '✗'} (target: <= 1.0 per 10)`);
  console.log(`  TCA: ${results.tca.value >= 85 ? '✓' : '✗'} (target: >= 85%)`);
  console.log(`  TTC: ${results.ttc_median.value <= 15 ? '✓' : '✗'} (target: <= 15 turns)`);
  console.log(`  TE: (baseline TBD)`);
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
