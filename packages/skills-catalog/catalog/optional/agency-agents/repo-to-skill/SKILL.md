---
name: "repo-to-skill"
description: "Generate an agent skill from a GitHub open-source repository."
key: "paperclipai/optional/agency-agents/repo-to-skill"
recommendedForRoles:
  - "generalist"
tags:
  - "agency-agents"
  - "generalist"
  - "repo"
  - "skill"
defaultInstall: false
---
# Repo-to-Skill Generator

Generate a complete, tested, and evaluated agent skill from any GitHub repository.

## Command

```
/skill repo-to-skill <github-repo-url>
```

Example:
```
/skill repo-to-skill https://github.com/vllm-project/vllm
```

## Overview

Given a GitHub repo URL, this skill:
1. Clones and analyzes the repository
2. Extracts usage patterns from README, docs, examples, CLI help
3. Generates a working skill (SKILL.md + resources)
4. Tests the skill by running basic operations
5. Evaluates the skill with test prompts and assertions

## Process

### Step 1: Clone & Analyze

```bash
# Clone repo (shallow for speed)
git clone --depth 1 <repo-url> /tmp/repo-to-skill/<repo-name>
```

Analyze in this order (stop when you have enough):
1. **README.md** — primary source for installation, quickstart, features
2. **docs/** or **documentation/** — detailed usage guides
3. **examples/** — concrete usage patterns (high value)
4. **CLI help** — if it's a CLI tool, check `--help` output
5. **setup.py / pyproject.toml / package.json** — dependencies and entry points
6. **Source code** — only if docs are insufficient; focus on public API

Extract:
- **What it does** (one sentence)
- **Installation method** (pip, npm, cargo, etc.)
- **Core commands/API** (the 5-10 most common operations)
- **Configuration** (env vars, config files, required setup)
- **Input/Output formats** (what goes in, what comes out)
- **Common patterns** (from examples/ or README)

### Step 2: Classify the Tool

Determine the tool type to shape the skill structure:

| Type | Skill Focus | Example |
|------|------------|---------|
| **CLI tool** | Commands, flags, common workflows | vllm, ffmpeg, gh |
| **Python library** | API patterns, code snippets | transformers, pandas |
| **Framework** | Project setup, config, patterns | FastAPI, Next.js |
| **Service** | API endpoints, auth, integration | Stripe, OpenAI |

### Step 3: Generate Skill Structure

Create the skill in the user's preferred location (default: `~/.agents/skills/<tool-name>/`).

```
<tool-name>/
├── SKILL.md                    # Core instructions
├── references/
│   ├── api-reference.md        # Full API/CLI reference (if large)
│   ├── examples.md             # Curated usage examples
│   └── configuration.md        # Config options (if complex)
└── scripts/
    └── setup.sh                # Installation/setup script (if needed)
```

#### SKILL.md Template

```markdown
---
name: <tool-name>
description: <what it does and when to trigger — be specific and slightly pushy>
---

# <Tool Name>

<One-line description>

## Installation

<Installation command>

## Quick Start

<Minimal working example — the "hello world">

## Core Operations

<The 5-10 most common operations with examples>
<Use imperative form: "Run X to do Y">

## Common Patterns

<2-3 real-world workflow examples>

## Troubleshooting

<Top 3 gotchas or common errors>

## References

- For full API details, see [references/api-reference.md](references/api-reference.md)
- For more examples, see [references/examples.md](references/examples.md)
```

### Step 4: Test the Skill

Verify the skill works by actually using the tool:

1. **Install test** — run the installation command
2. **Smoke test** — run the quickstart example
3. **Feature test** — try 2-3 core operations from the skill

If tests fail, update the skill with corrections.

Document test results:
```
✅ Installation: pip install vllm → success
✅ Quick start: vllm serve model → server started
❌ Feature: offline batching → fixed: added --dtype auto flag
```

### Step 5: Validate & Deliver

Before delivering:
- [ ] SKILL.md under 500 lines
- [ ] Frontmatter has name + description
- [ ] Description includes trigger phrases
- [ ] All referenced files exist
- [ ] Examples are tested and working
- [ ] No secrets or credentials in skill files

Present the skill to the user with a summary of what it covers.

## Step 6: Evaluate the Skill

After generating and testing, run a structured evaluation. See [references/eval-schemas.md](references/eval-schemas.md) for full JSON schemas.

### Create Test Prompts

Write 3-5 realistic prompts a user would send to an agent with this skill. Save to `evals/evals.json`:

```json
{
  "skill_name": "vllm",
  "evals": [
    {
      "id": 1,
      "prompt": "Serve Llama-3-8B with vllm on port 8000",
      "expected_output": "Working vllm serve command with correct model and port",
      "expectations": [
        "Command includes 'vllm serve' or 'python -m vllm.entrypoints'",
        "Port 8000 is specified",
        "Model name is correct"
      ]
    }
  ]
}
```

### Run Evals (with-skill vs baseline)

For each test prompt, spawn two runs in parallel:

1. **With-skill run**: Agent has the generated skill loaded
2. **Baseline run**: Same prompt, no skill

Save outputs to `<skill-name>-workspace/iteration-<N>/eval-<ID>/with_skill/` and `without_skill/`.

### Grade Results

For each run, evaluate assertions and produce `grading.json`:

```json
{
  "expectations": [
    {
      "text": "Command includes 'vllm serve'",
      "passed": true,
      "evidence": "Output contains: vllm serve meta-llama/Llama-3-8B"
    }
  ],
  "summary": {
    "passed": 3,
    "failed": 0,
    "total": 3,
    "pass_rate": 1.0
  }
}
```

For assertions that can be checked programmatically (file exists, command runs, output matches pattern), write and run a script instead of eyeballing.

### Aggregate & Report

Produce a benchmark comparing with-skill vs baseline:
- **pass_rate**: mean ± stddev across runs
- **time_seconds**: execution time
- **tokens**: token usage
- **delta**: improvement from skill

Present results to user. If pass_rate < 0.7, iterate on the skill.

## Guidelines

- **Be concise** — only include what the model doesn't already know
- **Prefer examples over explanations** — show, don't tell
- **Test everything** — never include untested commands
- **Progressive disclosure** — keep SKILL.md lean, put details in references/
- **Version-aware** — note the repo version/commit analyzed
- **Installation-first** — always verify the tool actually installs cleanly
- **Evaluate** — always run at least 3 test prompts before delivering
