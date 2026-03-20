/**
 * Kiro (local) adapter for Paperclip.
 *
 * Kiro CLI is AWS's agentic CLI (successor to Amazon Q Developer CLI).
 * It supports headless execution, session resumption, a native skills system,
 * and multi-provider model access including Claude, DeepSeek, Kimi, GLM, and Qwen.
 *
 * Skills are injected as actual SKILL.md files with YAML frontmatter
 * into ~/.kiro/skills/<skill-name>/SKILL.md (not symlinks like other adapters).
 */

export const type = "kiro_local" as const;

export const label = "Kiro (local)";

export const models = [
  { id: "auto", label: "auto" },
  { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "deepseek-3.2", label: "DeepSeek 3.2" },
  { id: "minimax-m2.1", label: "MiniMax M2.1" },
  { id: "minimax-m2.5", label: "MiniMax M2.5" },
  { id: "qwen3-coder-next", label: "Qwen 3 Coder Next" },
] satisfies { id: string; label: string }[];

export const DEFAULT_KIRO_LOCAL_MODEL = "auto" as const;

export const agentConfigurationDoc = `
# Kiro (local) Agent Configuration

## Prerequisites

1. **Install kiro-cli**: \`curl -fsSL https://cli.kiro.dev/install | bash\`
2. **Authenticate**: Run \`kiro-cli login\` interactively once
3. **Verify**: Run \`kiro-cli whoami\` to confirm authentication

## Configuration Fields

| Field | Description | Default |
|-------|-------------|---------|
| \`command\` | Path to kiro-cli binary | \`"kiro-cli"\` |
| \`model\` | Model to use (see list below) | \`"auto"\` |
| \`cwd\` | Working directory for execution | Current working directory |
| \`instructionsFilePath\` | Path to agent instructions file | Empty |
| \`timeoutSec\` | Execution timeout (0 = no timeout) | \`0\` |
| \`graceSec\` | Grace period for SIGTERM | \`15\` |
| \`extraArgs\` | Additional CLI flags | \`[]\` |
| \`env\` | Environment variable overrides | \`{}\` |

## Models (kiro-cli v1.27.3)

\`\`\`
auto               - Auto-select based on context
claude-sonnet-4.5  - Claude Sonnet 4.5 (200K / 1M context)
claude-sonnet-4    - Claude Sonnet 4 (200K context)
claude-haiku-4.5   - Claude Haiku 4.5 (200K context)
deepseek-3.2       - DeepSeek 3.2 (128K context)
minimax-m2.1       - MiniMax M2.1 (128K context)
minimax-m2.5       - MiniMax M2.5 (128K context)
qwen3-coder-next   - Qwen 3 Coder Next (128K context)
\`\`\`

## Execution

The adapter runs:
\`\`\`bash
kiro-cli chat --no-interactive --trust-all-tools --wrap never --model <model>
\`\`\`

Skills are injected into \`~/.kiro/skills/<name>/SKILL.md\` with YAML frontmatter.
Sessions are resumed via \`--resume\` based on working directory.

## Notes

- \`--trust-all-tools\` bypasses ALL approval prompts (file writes, shell commands, AWS calls)
- \`--wrap never\` suppresses line wrapping only; ANSI color codes are still emitted and stripped by the adapter
- Auth tokens are valid for ~8 hours (Identity Center)
- First run requires \`kiro-cli login\` to be run interactively once
`.trim();
