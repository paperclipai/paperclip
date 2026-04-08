export const type = "pixel_local";
export const label = "Pixel (local)";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# pixel_local agent configuration

Adapter: pixel_local

Use when:
- You run the Pixel coding agent CLI on the same machine as Paperclip
- You want JSONL stream output compatible with Gemini-style \`--output-format stream-json\` (recommended)
- You want session resume across runs when the CLI exposes \`--resume <sessionId>\`

Don't use when:
- The agent is only reachable over HTTP (use \`http\` or a gateway adapter)
- You only need arbitrary shell commands (use \`process\`)

Core fields:
- cwd (string, optional): working directory for the process (created when possible)
- instructionsFilePath (string, optional): markdown file prepended into the prompt
- promptTemplate (string, optional): heartbeat / task prompt template
- bootstrapPromptTemplate (string, optional): runs once when starting a new session (not on resume)
- model (string, optional): passed through \`--model\` when non-empty
- command (string, optional): CLI to execute; defaults to \`pixel\`
- streamJson (boolean, optional): when true (default), adds \`--output-format stream-json\`
- approvalMode (string, optional): when set, adds \`--approval-mode <value>\` (Gemini-compatible CLIs)
- sandboxCli (boolean, optional): when true, passes \`--sandbox\` or \`--sandbox=none\` from \`sandbox\`
- sandbox (boolean, optional): only used when \`sandboxCli\` is true
- provider / biller (string, optional): recorded on execution results; default \`pixel\`
- env (object, optional): extra environment variables
- extraArgs / args (string[], optional): inserted before the prompt flag
- timeoutSec / graceSec (number, optional): process timeout and SIGTERM grace

Operational notes:
- Paperclip injects skills into \`~/.pixel/skills/\` when the agent package ships skills.
- If your Pixel CLI uses different flags, disable \`streamJson\`, clear \`approvalMode\`, and supply the correct \`extraArgs\`, or use a wrapper script as \`command\`.
`;
