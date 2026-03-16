# Agent Trait Library

Composable prompt fragments for assembling agent identities. Each trait file is a self-contained markdown block that meaningfully shapes agent behavior.

## Structure

```
agents/traits/
├── expertise/    # What the agent knows
├── personality/  # How the agent communicates and decides
└── approach/     # The methodology the agent follows
```

## Compose an Agent

```bash
bun run scripts/compose-agent.ts \
  --expertise security \
  --personality skeptical \
  --approach systematic
```

Multiple traits per category via comma-separated values:

```bash
bun run scripts/compose-agent.ts \
  --expertise security,frontend \
  --personality analytical \
  --approach systematic
```

Auto-select traits from a task description:

```bash
bun run scripts/compose-agent.ts --task "Review this PR for security issues"
```

List all available traits:

```bash
bun run scripts/compose-agent.ts --list
```

## Example Compositions

| Use case | Command |
|---|---|
| Security reviewer | `--expertise security --personality skeptical --approach systematic` |
| Creative researcher | `--expertise research --personality creative --approach exploratory` |
| Fast implementer | `--expertise backend --personality pragmatic --approach rapid` |
| DevOps auditor | `--expertise devops --personality thorough --approach systematic` |
| Content writer | `--expertise content --personality bold --approach iterative` |
| Full-stack optimizer | `--expertise frontend,backend --personality analytical --approach iterative` |

## Pipe the Output

The script writes to stdout — pipe it directly into any tool that accepts a prompt string:

```bash
# Capture to a variable
PROMPT=$(bun run scripts/compose-agent.ts --expertise security --personality skeptical --approach systematic)

# Save to a file for review
bun run scripts/compose-agent.ts --expertise research --personality creative --approach exploratory > /tmp/agent-prompt.md
```

The composed output includes an `# Operational Rules` section with standard behavioral constraints appended automatically.

## Adding Custom Traits

1. Create a markdown file in the relevant subdirectory (`expertise/`, `personality/`, or `approach/`)
2. Follow the format of existing traits: a title heading, a one-line description, domain knowledge or communication style, and behavioral rules
3. Keep it 15-30 lines — enough to shape behavior, not so much that it bloats the composed prompt
4. The filename (without `.md`) becomes the trait name in CLI flags

## Trait File Format

```markdown
# Trait Name

One sentence: what this trait makes the agent do differently.

## Domain Knowledge / Communication Style / Working Method
- Specific bullet points — concrete, not generic
- Actionable behaviors the agent will actually exhibit

## Behavioral Rules
- Hard constraints: what the agent will always / never do
```

## Integration

Use composed prompts as the `prompt` parameter when spawning ad-hoc subagents:

```typescript
const prompt = await Bun.spawn(["bun", "run", "scripts/compose-agent.ts",
  "--expertise", "security",
  "--personality", "skeptical",
  "--approach", "systematic"
]).stdout;
```

Or paste the output directly into a new `AGENTS.md` when creating a Paperclip agent with `paperclip-create-agent`.
