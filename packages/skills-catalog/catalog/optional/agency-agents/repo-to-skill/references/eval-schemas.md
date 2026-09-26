# Evaluation Schemas

JSON schemas used for skill evaluation and benchmarking.

## evals.json

Test cases for the generated skill. Located at `evals/evals.json` within the skill directory.

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "User's example prompt",
      "expected_output": "Description of expected result",
      "files": [],
      "expectations": [
        "The output includes correct installation command",
        "The command is syntactically valid"
      ]
    }
  ]
}
```

**Fields:**
- `skill_name`: Name matching the skill's frontmatter
- `evals[].id`: Unique integer identifier
- `evals[].prompt`: The task to execute (realistic user message)
- `evals[].expected_output`: Human-readable success description
- `evals[].files`: Optional input file paths (relative to skill root)
- `evals[].expectations`: List of verifiable assertion strings

## grading.json

Grading output per run. Located at `<run-dir>/grading.json`.

```json
{
  "expectations": [
    {
      "text": "The output includes correct installation command",
      "passed": true,
      "evidence": "Found: pip install vllm"
    }
  ],
  "summary": {
    "passed": 3,
    "failed": 1,
    "total": 4,
    "pass_rate": 0.75
  }
}
```

**Important:** Use fields `text`, `passed`, `evidence` (not `name`/`met`/`details`).

## timing.json

Captured from subagent task completion notifications.

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3
}
```

## benchmark.json

Aggregate comparison of with-skill vs baseline.

```json
{
  "metadata": {
    "skill_name": "vllm",
    "timestamp": "2026-03-13T12:00:00Z",
    "evals_run": [1, 2, 3]
  },
  "run_summary": {
    "with_skill": {
      "pass_rate": {"mean": 0.90, "stddev": 0.05},
      "time_seconds": {"mean": 35.0, "stddev": 8.0},
      "tokens": {"mean": 4200, "stddev": 500}
    },
    "without_skill": {
      "pass_rate": {"mean": 0.45, "stddev": 0.10},
      "time_seconds": {"mean": 28.0, "stddev": 6.0},
      "tokens": {"mean": 3100, "stddev": 400}
    },
    "delta": {
      "pass_rate": "+0.45",
      "time_seconds": "+7.0",
      "tokens": "+1100"
    }
  }
}
```

## Eval Design Tips

- Write prompts as a real user would type them (not overly precise)
- Include edge cases: unusual models, custom configs, error scenarios
- Assertions should be objectively verifiable — avoid subjective quality judgments
- For CLI tools: test that commands are syntactically runnable
- For libraries: test that code snippets import correctly and run
- For programmatic checks, write a script rather than eyeballing
