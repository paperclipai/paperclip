export const type = "amp_local";
export const label = "Amp (local)";

export const models = [
  { id: "auto", label: "Auto (Amp selects best model)" },
];

export const agentConfigurationDoc = `# amp_local agent configuration

Adapter: amp_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- mode (string, optional): Amp agent mode (smart|rush|deep)
- promptTemplate (string, optional): run prompt template
- dangerouslyAllowAll (boolean, optional): pass --dangerously-allow-all to amp (default: true)
- command (string, optional): defaults to "amp"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Amp requires AMP_API_KEY env var for non-interactive use.
- Amp's --stream-json output is Claude Code compatible.
- Thread IDs from Amp can be used for session continuation.
`;
