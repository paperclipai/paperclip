# Repo to Skill 🛠️

**Turn any GitHub repo into an agent skill.** Give it a repo URL — get back a tested, ready-to-use skill that teaches AI agents how to use that tool.

> Make any open-source repo an agent's claw. 🐾

## Why?

There are thousands of amazing open-source tools, but AI agents don't know how to use most of them well. This skill bridges the gap — it reads a repo's code, docs, and examples, then generates a complete skill that any agent can load and use immediately.

## How it works

```
GitHub Repo → Clone & Analyze → Generate Skill → Test → Evaluate → Ready to use
```

1. **Clone & Analyze** — Reads README, docs, examples, CLI help, entry points
2. **Classify** — Determines if it's a CLI tool, library, framework, or service
3. **Generate** — Creates SKILL.md + references + scripts
4. **Test** — Installs the tool and runs smoke tests
5. **Evaluate** — Benchmarks with-skill vs baseline on realistic prompts

## Install

```bash
npx skills add shuyhere/repo-to-skill
```

Or clone this repo and copy the skill folder into your agent's skills directory.

## Usage

### Slash command
```
/skill repo-to-skill https://github.com/vllm-project/vllm
```

### Natural language
> Create a skill for using https://github.com/hiyouga/LLaMA-Factory

### What you get

```
<tool-name>/
├── SKILL.md              # How to use the tool (under 500 lines)
├── references/           # Detailed docs, loaded on demand
├── scripts/              # Setup & helper scripts
└── evals/
    └── evals.json        # Test cases with assertions
```

## Example — Real interaction

**User prompt:**
> @agent create a skill for using https://github.com/hiyouga/LLaMA-Factory

**What the agent does:**
1. Clones the repo, reads README + examples + source
2. Detects: Python CLI tool, entry point `llamafactory-cli`
3. Generates a complete skill covering LoRA, QLoRA, DPO, multimodal training, dataset prep, multi-GPU, deployment
4. Runs 5 eval prompts (e.g. *"Fine-tune Qwen3-4B on 5000 samples with 24GB VRAM"*)
5. Delivers the skill with benchmark results

**User prompt:**
> @agent I want to fine-tune Qwen3-4B on my custom dataset. I have 1 GPU with 24GB VRAM.

**Agent (with generated skill loaded):** gives a complete YAML config, correct template, `llamafactory-cli train` command, VRAM estimate — all accurate and tool-specific.

**Eval results:**

| Test | With Skill | Baseline (no skill) |
|------|-----------|---------------------|
| LoRA SFT (24GB GPU) | 5/5 ✅ | 5/5 ✅ |
| DPO Training | 5/5 ✅ | 5/5 ✅ |
| Merge & Deploy | 4/4 ✅ | 4/4 ✅ |
| Multimodal VLM | 4/4 ✅ | 4/4 ✅ |
| 70B Distributed | 4/4 ✅ | 3/4 ⚠️ |

**With skill: 22/22 (100%)** · Baseline: 21/22 (95.5%) — skill caught `FORCE_TORCHRUN=1`, a tool-specific detail the baseline missed.

## Included tools

| File | Purpose |
|------|---------|
| `SKILL.md` | Core skill — the 6-step generation process |
| `scripts/analyze_repo.sh` | Automated repo analyzer |
| `references/skill-format.md` | Skill format reference |
| `references/eval-schemas.md` | Eval & benchmark JSON schemas |

## Compatible with

- [OpenClaw](https://github.com/openclaw/openclaw)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Codex](https://openai.com/codex)
- Any agent supporting the [Agent Skills](https://agentskills.io) format

## License

MIT
