export const type = "codebuddy_local";
export const label = "CodeBuddy (local)";
export const DEFAULT_CODEBUDDY_LOCAL_MODEL = "glm-5.0";
export const DEFAULT_CODEBUDDY_LOCAL_SKIP_PERMISSIONS = true;

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# codebuddy_local agent configuration

Adapter: codebuddy_local

Use when:
- You want Paperclip to run CodeBuddy CLI locally on the host machine
- You want CodeBuddy conversation resume across wake-ups via --resume
- You want CodeBuddy's local multi-model runtime with structured stream-json logs

Don't use when:
- You need webhook-style or remote gateway invocation (use openclaw_gateway or http)
- You only need a one-shot process execution (use process)
- CodeBuddy CLI is not installed or authenticated on the machine

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): CodeBuddy model id (defaults to glm-5.0)
- effort (string, optional): CodeBuddy reasoning effort (low|medium|high|xhigh)
- maxTurnsPerRun (number, optional): passed as --max-turns when greater than zero
- dangerouslySkipPermissions (boolean, optional): auto-add -y unless permission flags are already present
- command (string, optional): defaults to "codebuddy"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): termination grace period in seconds

Notes:
- Runs are executed with: codebuddy -p --output-format stream-json ...
- Prompts are piped to CodeBuddy via stdin.
- CodeBuddy models are discovered dynamically from \`codebuddy --help\`.
- Run \`codebuddy --help\` to inspect the current CLI version's supported model list.
- Sessions are resumed with --resume when stored session cwd matches current cwd.
- Paperclip auto-injects shared skills into "~/.codebuddy/skills" when missing so CodeBuddy can discover "$paperclip" and related skills on local runs.
- Paperclip auto-adds -y unless one of -y, --dangerously-skip-permissions, or --permission-mode is already present in extraArgs.
`;
