---
name: autoresearch
description: >
  Run autonomous experiment loops using Andrej Karpathy's AutoResearch pattern.
  Give the agent a single file to modify, a single metric to optimize, and let
  it run hundreds of experiments autonomously. Use when you have a clear numeric
  metric, automated evaluation, and want continuous autonomous improvement.
---

# SKILL: AutoResearch — Autonomous Experiment Loops

## Purpose
Implement and run autonomous experiment loops where an AI agent iteratively
modifies code, evaluates results against a single metric, and keeps only
improvements — running indefinitely without human intervention.

Based on Andrej Karpathy's AutoResearch pattern.
Reference repo: `https://github.com/karpathy/autoresearch`

---

## The 3-File Architecture

Every AutoResearch loop is built on exactly three files:

### 1. `program.md` — The Agent Brain
Defines the objective, rules, constraints, and tells the agent how to operate indefinitely.
This is the system prompt for the experiment loop.

### 2. `train.py` (or equivalent) — The Editable File
The **only** file the agent can modify. Contains the code/config being experimented on.
One file. Not two, not zero: one.

### 3. `prepare.py` (or equivalent) — The Evaluation Script
The file the agent **CANNOT touch**. Defines what "better" means (the scoring/eval function).
If the agent could edit it, it would cheat by rewriting the metric.

---

## The Experiment Loop

```
1. Agent formulates a hypothesis (what experiment to try)
2. Modifies train.py (the editable file)
3. Runs training/execution (~5 minutes per experiment)
4. Runs prepare.py to evaluate the result
5a. If metric improves → git commit (saved in history)
5b. If metric worsens → git reset and return to step 1
→ Repeat indefinitely
```

---

## Three Mandatory Conditions

For AutoResearch to work, ALL three must be true:

1. **A clear metric** — a single number with a defined direction
   (e.g., load time in ms ↓, Sharpe ratio ↑, conversion rate ↑, accuracy ↑)

2. **Automated evaluation** — no human in the loop.
   If you have to approve each step, it is not AutoResearch.

3. **A single editable file** — the agent only touches one file.

### Where AutoResearch FAILS:
- Brand design, UX, pricing (unless you have high volume for A/B testing)
- Anything where "better" is subjective and not measurable

---

## Setting Up an AutoResearch Loop

### Step 1: Create project structure

```bash
mkdir my-experiment && cd my-experiment
git init

# Create the three files
touch program.md train.py prepare.py
```

### Step 2: Write `prepare.py` (the metric)

```python
# Example: measure website load time
import subprocess, json, sys

result = subprocess.run(
    ["node", "benchmark.js"],
    capture_output=True, text=True
)
metrics = json.loads(result.stdout)
score = metrics["load_time_ms"]

# Append to results log
with open("results.tsv", "a") as f:
    f.write(f"{score}\n")

print(f"SCORE: {score}")
sys.exit(0 if score > 0 else 1)
```

### Step 3: Write `program.md`

```markdown
# AutoResearch Program

## Objective
Minimize website load time (measured in milliseconds by prepare.py).

## Rules
1. You may ONLY modify `train.py` (the CSS/JS bundle configuration)
2. You may NEVER modify `prepare.py` or `program.md`
3. After each modification, run `python prepare.py` to evaluate
4. If the score improves, run `git add -A && git commit -m "experiment: [description] score=[value]"`
5. If the score worsens, run `git checkout -- train.py` to revert
6. Log every experiment attempt and result
7. Never stop. Never ask for confirmation. Keep running experiments.

## Strategy
- Start with the most impactful optimizations first
- Try one change at a time for clear attribution
- Keep a mental model of what has worked and what hasn't
- Be creative but systematic
```

### Step 4: Launch the loop

```bash
claude --dangerously-skip-permissions
```

Then give the master prompt:
> "Read program.md. Run the benchmark baseline first. Record results in results.tsv.
> Then start the experiment loop. Do not stop or ask me anything.
> Keep running experiments autonomously."

---

## Use Cases

| Domain | Metric | Editable File |
|---|---|---|
| **Website speed** | ms load time (Puppeteer) | CSS/JS bundle config |
| **Trading** | Sharpe ratio | buy/sell strategy |
| **Marketing** | conversion rate | copy/headlines |
| **Model fine-tuning** | accuracy/perplexity | hyperparameters/LoRA config |
| **Prompt engineering** | correctness score | system prompt |
| **Algorithm optimization** | benchmark speed | function/algorithm |
| **Compiler flags** | binary size or speed | build configuration |
| **Database queries** | query latency | index/query config |

---

## Integration with Paperclip

To run AutoResearch as a Paperclip agent:

1. Create an agent with role "Researcher" or "Optimizer"
2. Set `adapterConfig.cwd` to the experiment directory
3. Set `adapterConfig.instructionsFilePath` to `program.md`
4. Set `adapterConfig.dangerouslySkipPermissions` to `true` (required for autonomous loop)
5. Set `adapterConfig.maxTurnsPerRun` high enough for meaningful iteration
6. The agent will run the loop during each heartbeat, picking up where it left off

### Example `adapterConfig`:

```json
{
  "model": "claude-sonnet-4-6",
  "cwd": "/home/agent/experiments/website-speed",
  "instructionsFilePath": "/home/agent/experiments/website-speed/program.md",
  "dangerouslySkipPermissions": true,
  "maxTurnsPerRun": 50,
  "env": {
    "EXPERIMENT_NAME": "website-speed-optimization"
  }
}
```

---

## The Master Prompt (reusable)

This prompt triggers the autonomous loop in any AutoResearch project:

> "Read program.md. Run the benchmark baseline first. Record results.
> Then start the experiment loop. Do not stop or ask me anything.
> Keep running experiments autonomously."

---

## Safety Guardrails

- The evaluation script (`prepare.py`) must be read-only to the agent
- Use git commits to preserve every successful experiment
- Set reasonable timeouts per experiment to prevent infinite hangs
- Monitor `results.tsv` for progress tracking
- The agent should never modify its own evaluation criteria
