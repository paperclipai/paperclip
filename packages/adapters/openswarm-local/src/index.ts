import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "openswarm_local";
export const label = "OpenSwarm (local)";

// OpenSwarm has two distinct active distributions; both install a binary named
// `openswarm`. Operators pick one per machine via the `flavor` config field.
//
// - `unohee` (default): https://github.com/unohee/OpenSwarm
//   npm: @intrect/openswarm — Linear+Discord-driven autonomous orchestrator,
//   Worker/Reviewer pipeline, supports Claude/GPT/Codex/local models.
//   Wake shape: `openswarm exec "<prompt>" -p <cwd> --local --pipeline`
//
// - `vrsen`: https://github.com/VRSEN/openswarm
//   npm: @vrsen/openswarm — 8 specialist agents (Orchestrator, VA, Deep
//   Research, Data Analyst, Slides, Docs, Image, Video) on Agency Swarm.
//   Wake shape: `openswarm "<prompt>"` (one-prompt-to-deliverable).

export const SANDBOX_INSTALL_COMMAND = "npm install -g @intrect/openswarm";

export const models: Array<{ id: string; label: string }> = [];
export const modelProfiles: AdapterModelProfileDefinition[] = [];

export const agentConfigurationDoc = `# openswarm_local agent configuration

Adapter: openswarm_local

Use when:
- You want Paperclip to wake an OpenSwarm subprocess on heartbeat
- You want either unohee/OpenSwarm (autonomous Linear+Discord orchestrator) or
  VRSEN/OpenSwarm (multi-agent deliverables) as the agent runtime
- Provider/model selection is configured inside OpenSwarm itself
  (config.yaml for unohee, env vars for vrsen)

Don't use when:
- You want fine-grained Paperclip-side model routing (use claude_local /
  codex_local / hermes_local instead)
- The host can't run \`openswarm\` (CLI not installed)
- You want Discord-only triggering with no Paperclip wake (run OpenSwarm
  standalone)

Core fields:
- flavor (string, optional, default "unohee"): "unohee" | "vrsen"
- cwd (string, optional): default absolute working directory
- instructionsFilePath (string, optional): absolute path to a markdown
  instructions file injected as a prompt prefix
- promptTemplate (string, optional): override Paperclip's default wake prompt
- command (string, optional): defaults to "openswarm"
- extraArgs (string[], optional): additional CLI args appended after the
  flavor-default args (e.g. ["--worker-only"] for unohee, ["--no-banner"])
- env (object, optional): KEY=VALUE environment variables (for example
  ANTHROPIC_API_KEY, OPENAI_API_KEY, LINEAR_API_KEY, DISCORD_TOKEN)
- pipeline (boolean, optional, default true for unohee): adds --pipeline so
  the worker/reviewer/tester/documenter chain runs
- localOnly (boolean, optional, default true for unohee): adds --local so the
  command does not require a running daemon

Operational fields:
- timeoutSec (number, optional, default 1800): run timeout in seconds. unohee
  worker pipelines benefit from 30+ minutes; VRSEN deliverables can run long.
- graceSec (number, optional, default 15): SIGTERM grace period

Notes:
- The adapter spawns one OpenSwarm process per heartbeat run. Paperclip
  injects standard PAPERCLIP_* env vars, so OpenSwarm scripts can call back
  into Paperclip's API for issue/run context if you wire that up.
- OpenSwarm reports cost/usage in its own data store (better-sqlite3 +
  LanceDB for unohee). Token-level cost ingestion into Paperclip is not yet
  wired here; budget enforcement on this adapter is best-effort.
- For unohee, the upstream daemon mode (\`openswarm start\`) is also viable
  out-of-band; this adapter intentionally targets one-shot \`openswarm exec\`
  to keep heartbeat semantics clean.
`;
