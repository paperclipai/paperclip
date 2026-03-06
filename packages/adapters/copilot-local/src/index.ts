export const type = "copilot_local";
export const label = "GitHub Copilot CLI";

export const models: { id: string; label: string }[] = [];

export const AUTH_ENV_VARS = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
] as const;

export const agentConfigurationDoc = `# copilot_local agent configuration

Adapter: copilot_local

## Prerequisites

### Install Copilot CLI
\`\`\`bash
npm install -g @github/copilot
# or: brew install copilot-cli
# or: curl -fsSL https://gh.io/copilot-install | bash
\`\`\`

### Authenticate
Set one of the following environment variables (checked in order of precedence):
- COPILOT_GITHUB_TOKEN (highest priority, fine-grained PAT with "Copilot Requests" permission)
- GH_TOKEN
- GITHUB_TOKEN

Classic PATs (ghp_ prefix) are NOT supported. Use a fine-grained PAT (github_pat_ prefix).

If none are set and GitHub CLI is installed and authenticated, Copilot CLI will use its
token as a lowest-priority fallback.

### Pre-trust your workspace (first run only)
Copilot CLI prompts for directory trust the first time it runs in a new working
directory. Run \`copilot\` interactively in your cwd once and choose "Yes, and remember
this folder", or edit ~/.copilot/config.json to add the path to \`trusted_folders\`.

## Core fields
- cwd (string, optional): absolute working directory for the agent process
- promptTemplate (string, optional): run prompt template
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

## Operational fields
- timeoutSec (number, optional): run timeout in seconds (default: 120)
- graceSec (number, optional): SIGTERM grace period in seconds (default: 10)

## Permission flags
The adapter passes --yolo (equivalent to --allow-all) by default, which combines
--allow-all-tools, --allow-all-paths, and --allow-all-urls. For fine-grained control,
use extraArgs with --allow-tool, --deny-tool, --allow-url, --deny-url, etc.

## Known limitations
- No cost tracking. The Copilot CLI does not expose token usage in programmatic output.
- Output is plain text. Structured JSON output (--format json) is not yet generally available.
- Enterprise content exclusions are silently enforced per org policy.
`;
