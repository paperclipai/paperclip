# Anvil Baseline Benchmarks

Benchmark suite for measuring Anvil harness performance per ADR-001 ([ANGA-793#document-plan](/ANGA/issues/ANGA-793#document-plan)).

## Overview

This benchmark suite establishes a quantitative baseline for Anvil's agent performance across 5 dimensions:

| Metric | Definition | Target |
|--------|------------|--------|
| **TCR** | Task Completion Rate | ≥ 90% |
| **ER** | Error Rate (per 10 tasks) | ≤ 1.0 |
| **TCA** | Tool Call Accuracy | ≥ 85% |
| **TTC** | Time-to-Completion (median turns) | ≤ 15 |
| **TE** | Token Efficiency (tokens/task) | TBD |

## Structure

```
benchmarks/
├── README.md                 # This file
├── run-baseline.ts           # Benchmark runner script
├── scenarios/                # Scenario definitions
│   ├── 01-file-creation.json
│   ├── 02-bug-fix.json
│   ├── 03-refactor.json
│   ├── 04-information-retrieval.json
│   └── 05-multi-step.json
└── benchmark-baseline.json   # Results output (generated)
```

## Scenarios

### 1. File Creation (`01-file-creation.json`)
- **Type:** file_creation
- **Tests:** End-to-end tool chain (read, plan, write, verify)
- **Task:** Create utility module with tests
- **Time limit:** 20 turns

### 2. Bug Fix (`02-bug-fix.json`)
- **Type:** bug_fix
- **Tests:** Error diagnosis, targeted edit, validation
- **Task:** Fix failing test in existing module
- **Time limit:** 15 turns

### 3. Refactor (`03-refactor.json`)
- **Type:** refactor
- **Tests:** Multi-file coordination, rename safety
- **Task:** Extract shared helper function
- **Time limit:** 25 turns

### 4. Information Retrieval (`04-information-retrieval.json`)
- **Type:** information_retrieval
- **Tests:** Search, read, synthesize, respond
- **Task:** Explain authentication flow
- **Time limit:** 10 turns

### 5. Multi-Step Workflow (`05-multi-step.json`)
- **Type:** multi_step_workflow
- **Tests:** Sequential tool use with dependencies
- **Task:** Add feature with tests and docs
- **Time limit:** 30 turns

## Usage

### Running the Benchmark

```bash
# Run with defaults (3 runs per scenario)
pnpm tsx benchmarks/run-baseline.ts

# Custom number of runs
pnpm tsx benchmarks/run-baseline.ts --runs=5

# Custom output location
pnpm tsx benchmarks/run-baseline.ts --output=results/baseline.json
```

### Output Format

Results are written to `benchmark-baseline.json`:

```json
{
  "date": "2026-04-17",
  "commit": "ceb3619f",
  "scenarios_run": 5,
  "executions_per_scenario": 3,
  "results": {
    "tcr": { "value": 93.3, "unit": "percent" },
    "er": { "value": 0.5, "unit": "per_10_tasks" },
    "tca": { "value": 87.2, "unit": "percent" },
    "ttc_median": { "value": 12, "unit": "turns" },
    "te": { "value": 3250, "unit": "tokens_per_task" }
  },
  "raw_runs": [...]
}
```

## Implementation Status

### ✅ Completed
- Scenario definitions (5 scenarios covering all required types)
- Benchmark runner framework
- Metric calculation logic
- Output formatting

### ⚠️ TODO: Harness Integration

The benchmark runner currently uses **mock data**. To complete the implementation:

1. **Integrate with Anvil/Claude Code harness**
   - Location: `run-baseline.ts`, function `executeScenario()`
   - Required: Spawn agent with scenario prompt
   - Track: Tool calls, turns, tokens, completion status

2. **Implementation approaches:**

   **Option A: CLI Integration**
   ```typescript
   // Use claude-code CLI in headless mode
   const result = await execFileAsync('claude-code', [
     '--headless',
     '--prompt', scenario.prompt,
     '--working-dir', tempDir
   ]);
   ```

   **Option B: SDK Integration**
   ```typescript
   // Use Anvil SDK directly
   import { AnvilRunner } from '@anvilai/sdk';
   const runner = new AnvilRunner({...});
   const result = await runner.executeTask(scenario.prompt);
   ```

   **Option C: Remote API**
   ```typescript
   // Call Anvil API endpoint
   const response = await fetch('/api/benchmark/execute', {
     method: 'POST',
     body: JSON.stringify(scenario)
   });
   ```

3. **Metrics to capture:**
   - `completed`: boolean (task reached terminal state)
   - `fatal_error`: boolean (unrecoverable error occurred)
   - `turns_taken`: number of agent conversation turns
   - `tool_calls.total`: total tool invocations
   - `tool_calls.first_attempt_success`: successful on first try
   - `tokens_used`: total tokens (prompt + completion)

4. **Environment setup:**
   - Create isolated temp directory for each run
   - Set up `scenario.setup.create_files` if defined
   - Clean up after each run

## Execution Requirements (ADR-001)

- **Deterministic**: temperature=0, fixed seed
- **Runs per scenario**: 3 minimum (median scoring)
- **Runtime target**: < 30 minutes total
- **Parallelization**: Recommended for CI performance

## Integration with CI

Once harness integration is complete:

1. Add to GitHub Actions workflow:
   ```yaml
   - name: Run baseline benchmarks
     run: pnpm tsx benchmarks/run-baseline.ts
   
   - name: Upload results
     uses: actions/upload-artifact@v3
     with:
       name: benchmark-results
       path: benchmarks/benchmark-baseline.json
   ```

2. Compare against baseline on PRs
3. Block merge if TCR or ER regress beyond thresholds

## Next Steps

1. **Complete harness integration** (see TODO section above)
2. **Execute first baseline run** on current main branch
3. **Commit baseline results** to repo
4. **Set up CI gates** for future PRs
5. **Post results** to [ANGA-647](/ANGA/issues/ANGA-647)

## References

- ADR-001: [ANGA-793#document-plan](/ANGA/issues/ANGA-793#document-plan)
- Parent Issue: [ANGA-647](/ANGA/issues/ANGA-647)
- Epic: [ANGA-644](/ANGA/issues/ANGA-644)
