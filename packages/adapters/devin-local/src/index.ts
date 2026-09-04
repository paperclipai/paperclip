import { listDevinModels, refreshDevinModels } from './server/models.js';

export const type = 'devin_local';
export const label = 'Devin';

// Model discovery requires a working, authenticated `devin` CLI. Static exports
// are empty so callers do not see a stale hardcoded list when discovery fails.
export const models: { id: string; label: string }[] = [];
export { listDevinModels as listModels, refreshDevinModels as refreshModels };

export const agentConfigurationDoc = `# devin_local agent configuration

Adapter: devin_local — runs the Devin CLI in print mode (\`devin -p\`).

Use when:
- The agent should run the Devin CLI locally on the host.
- You want Devin's own model routing / cost tiers.
- The agent's instructions live in \`AGENTS.md\` in the working directory (\`cwd\`).

Don't use when:
- The Devin CLI is not installed or authenticated on the host.
- You need guaranteed non-interactive execution in an untrusted directory without setting \`respectWorkspaceTrust\` to false.

Core fields:
- command (string, optional): path to the Devin CLI. Defaults to \`devin\`.
- cwd (string, optional): absolute working directory. Devin loads \`AGENTS.md\` from this directory. Defaults to \`$HOME\`.
- model (string, optional): Devin model family or exact \`model_uid\` (e.g. \`swe-1.7\`, \`claude-opus-5\`). Empty lets Devin pick its own default.
- permissionMode (string, optional): \`auto\` | \`normal\` | \`accept-edits\` | \`smart\` | \`dangerous\` | \`autonomous\`. Forwarded unchanged to the CLI; defaults to \`auto\` (the CLI default). Use \`dangerous\` for fully unattended runs.
- respectWorkspaceTrust (boolean, optional): defaults to \`false\`. When false, passes \`--respect-workspace-trust false\` so Devin can run in a fresh directory without an interactive trust prompt.
- sandbox (boolean, optional): defaults to \`false\`. When true, \`--sandbox\` is always passed and the CLI runs with the \`autonomous\` permission mode.
- timeoutSec (number, optional): run timeout in seconds (default 1800).
- graceSec (number, optional): SIGTERM grace period (default 15).
- exportPath (string, optional): absolute path for the ATIF transcript. Defaults to a temp file.
- extraArgs (string[], optional): additional \`devin\` CLI args appended after the managed args.
- env (object, optional): KEY=VALUE environment overrides.
- instructionsFilePath (string, optional): Devin auto-loads \`AGENTS.md\` from \`cwd\`. Any other path (this key, or \`instructionsRootPath\` + \`instructionsEntryFile\` from the managed bundle) is delivered in the prompt: the file content is prepended with a directive naming its directory as authoritative for sibling instruction files.

Skills:
- Company desired skills are synced as persistent symlinks into \`<cwd>/.devin/skills/\` (Devin's native project-skill discovery).
- Sync is scoped per agent cwd. The global \`~/.config/devin/skills/\` path is intentionally not used, to avoid leaking skills across agents or companies.
- External installs that already occupy a skill name are reported as conflicts and are never overwritten.
- \`listSkills\` / \`syncSkills\` materialize and prune only Paperclip-managed links. A run-start ensure also links desired skills and prunes stale managed links before spawn; failures warn on stderr and never fail the run.

Execution notes:
- The adapter runs \`devin --respect-workspace-trust false --permission-mode <mode> --model <uid> --export <atif> -p\` or \`--prompt-file <file> -p\`.
- \`--export\` provides the session id and token counts; usage is read from the ATIF file, not from a separate admin tool.
- Resume uses \`devin -r <sessionId> -p ...\` and is only attempted when the stored session's \`cwd\` matches the current run's \`cwd\`.
- Paperclip wake context is injected as \`PAPERCLIP_*\` environment variables; the agent can use them with plain \`curl\`.
`;
