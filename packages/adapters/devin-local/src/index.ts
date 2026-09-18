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
- cwd (string, optional): absolute working directory. A resolved Paperclip project or task workspace takes precedence. An explicit cwd overrides the agent-home fallback. Without either a resolved workspace or explicit cwd, execution fails. Devin loads \`AGENTS.md\` from the effective directory.
- model (string, optional): Devin model family or exact \`model_uid\` (e.g. \`swe-1.7\`, \`claude-opus-5\`). Empty lets Devin pick its own default.
- permissionMode (string, optional): \`auto\` | \`normal\` | \`accept-edits\` | \`smart\` | \`dangerous\` | \`autonomous\`. Forwarded unchanged to the CLI; defaults to \`auto\` (the CLI default). Use \`dangerous\` for fully unattended runs.
- respectWorkspaceTrust (boolean, optional): defaults to \`false\`. When false, passes \`--respect-workspace-trust false\` so Devin can run in a fresh directory without an interactive trust prompt.
- sandbox (boolean, optional): defaults to \`false\`. When true, \`--sandbox\` is always passed and the CLI runs with the \`autonomous\` permission mode.
- timeoutSec (number, optional): run timeout in seconds (default 1800). Zero disables the process timeout.
- graceSec (number, optional): SIGTERM grace period (default 15).
- exportPath (string, optional): absolute path for the ATIF transcript. Defaults to a temp file.
- extraArgs (string[], optional): additional \`devin\` CLI args appended after the managed args.
- env (object, optional): KEY=VALUE environment overrides.
- instructionsFilePath (string, optional): Devin auto-loads \`AGENTS.md\` from \`cwd\`. Any other path (this key, or \`instructionsRootPath\` + \`instructionsEntryFile\` from the managed bundle) is delivered in the prompt: the file content is prepended with a directive naming its directory as authoritative for sibling instruction files.

Fusion selection:
- Choose an exact Fusion model_uid from the discovered catalog. Bare \`fusion\` is incomplete and is rejected.
- The exact UID selects both orchestrator and worker models and efforts. Do not add generic thinkingEffort, contextSize, fastMode, or priority overrides to a Fusion selection.
- Empty model inherits the CLI configuration, which may itself select Fusion.
- Fusion run-cost reporting may exclude worker usage. Published token rates are not a verified total run cost; budget reporting can therefore be incomplete.

Skills:
- Desired skills are linked into \`<effective cwd>/.devin/skills/\` before execution. The global \`~/.config/devin/skills/\` directory is not written.
- With an explicit cwd, \`listSkills\` / \`syncSkills\` inspect and update that directory. Without one, they report skills configured for the workspace resolved at run time and do not access the operator's home directory.
- A shared working directory shares skill discovery. Separate working directories are required when skills must remain separate; this adapter does not create a filesystem security boundary between local agents.
- External installations are never overwritten. Pruning removes only links that match the currently known Paperclip-managed source. Run-start sync failures warn on stderr.

Execution notes:
- The adapter runs \`devin --respect-workspace-trust false --permission-mode <mode> --model <uid> --export <atif> -p\` or \`--prompt-file <file> -p\`.
- \`--export\` provides the session id and token counts; usage is read from the ATIF file, not from a separate admin tool.
- Resume uses \`devin -r <sessionId> -p ...\` and is only attempted when the stored session's \`cwd\` matches the current run's \`cwd\`.
- Paperclip wake context is injected as \`PAPERCLIP_*\` environment variables; the agent can use them with plain \`curl\`.
`;
