export const type = "hermes_fleetos";
export const label = "FleetOS Gateway (Raava)";

export const models = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
  { id: "openrouter/auto", label: "OpenRouter Auto" },
  { id: "openrouter/anthropic/claude-sonnet-4-6", label: "OpenRouter Claude Sonnet 4.6" },
  { id: "openrouter/google/gemini-2.5-pro", label: "OpenRouter Gemini 2.5 Pro" },
];

export const agentConfigurationDoc = `# hermes_fleetos agent configuration

Adapter: hermes_fleetos

Use when:
- You want Raava Dashboard to dispatch work to Hermes agents running inside FleetOS LXD containers.
- Your FleetOS API (FastAPI backend) manages container lifecycle, provisioning, and exec.

Don't use when:
- You run Hermes locally on the same host as Raava Dashboard (use hermes_local instead).
- You don't have a FleetOS API deployment.

Core fields:
- fleetosUrl (string, required): base URL of the FleetOS API (e.g. https://fleet.raava.io)
- apiKey (string, required): FleetOS API key for X-API-Key authentication
- containerId (string, required): target LXD container ID managed by FleetOS

Execution fields:
- model (string, optional): model id to pass to the hermes CLI inside the container
- promptTemplate (string, optional): run prompt template
- hermesCommand (string, optional): hermes CLI command inside the container (default "hermes")
- hermesArgs (string[], optional): additional CLI args for hermes
- env (object, optional): KEY=VALUE environment variables injected into the container exec

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (default 120)
- graceSec (number, optional): SIGTERM grace period in seconds (default 20)

Notes:
- The adapter communicates with FleetOS over HTTP using fetch() and X-API-Key auth.
- Container exec is performed via the FleetOS /containers/{id}/exec endpoint.
- Health checks and container status are queried before execution to ensure readiness.
`;
