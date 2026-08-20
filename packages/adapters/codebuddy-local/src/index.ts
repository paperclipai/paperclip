export const type = "codebuddy_local";
export const label = "CodeBuddy";

export const DEFAULT_CODEBUDDY_LOCAL_MODEL = "default-model";

export const models = [
  { id: DEFAULT_CODEBUDDY_LOCAL_MODEL, label: "Default model" },
  { id: "gemini-3.0-pro", label: "Gemini 3.0 Pro" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gpt-5.1", label: "GPT-5.1" },
  { id: "gpt-5.5", label: "GPT-5.5" },
];

export const agentConfigurationDoc = `# codebuddy_local agent configuration

Adapter: codebuddy_local

Use when:
- You want Paperclip to run Tencent CodeBuddy CLI locally
- You want Claude-compatible stream-json output and resumable sessions
- You want Paperclip skills staged into CodeBuddy's native project paths

Core fields:
- cwd (string, optional): working directory
- instructionsFilePath (string, optional): instructions staged as CODEBUDDY.md when safe
- promptTemplate (string, optional): run prompt template
- model (string, optional): defaults to default-model
- effort (string, optional): low, medium, high, or xhigh
- supportsEffort (boolean, optional): pass --effort only when the installed CLI supports it
- maxTurns (number, optional): maximum agent turns
- appendSystemPrompt / appendSystemPromptFile (string, optional)
- mcpConfigPath (string, optional): passed via --mcp-config; strict MCP mode is never enabled
- command (string, optional): defaults to codebuddy
- extraArgs (string[], optional): additional CLI arguments
- env (object, optional): environment variables

Notes:
- Host must be authenticated: run \`codebuddy login\` on the Paperclip machine before waking the agent.
- Runs use --print - with --output-format stream-json and pass the prompt on stdin.
- Unattended runs use --permission-mode bypassPermissions.
- AskUserQuestion, EnterPlanMode, and ExitPlanMode are passed as separate disallowed tools.
- appendSystemPromptFile is read by Paperclip and sent through --append-system-prompt for CLI compatibility.
- Desired skills are staged into .codebuddy/skills and .claude/skills in the execution workspace.
`;
