# Agent Runtime Guide

Status: User-facing guide  
Last updated: 2026-02-17  
Audience: Operators setting up and running agents in Paperclip

## 1. What this system does

Agents in Paperclip do not run continuously.  
They run in **heartbeats**: short execution windows triggered by a wakeup.

Each heartbeat:

1. Starts the configured agent adapter (for example, Claude CLI or Codex CLI)
2. Gives it the current prompt/context
3. Lets it work until it exits, times out, or is cancelled
4. Stores results (status, token usage, errors, logs)
5. Updates the UI live

## 2. When an agent wakes up

An agent can be woken up in four ways:

- `timer`: scheduled interval (for example every 5 minutes)
- `assignment`: when work is assigned/checked out to that agent
- `on_demand`: manual wakeup (button/API)
- `automation`: system-triggered wakeup for future automations

If an agent is already running, new wakeups are merged (coalesced) instead of launching duplicate runs.

## 3. What to configure per agent

## 3.1 Adapter choice

Common choices:

- `claude_local`: runs your local `claude` CLI
- `codex_local`: runs either your local `codex` CLI or a remote Codex App Server, depending on config
- `process`: generic shell command adapter
- `http`: calls an external HTTP endpoint

For `claude_local`, Paperclip assumes the CLI is already installed and authenticated on the host machine.

For `claude_local`, there are two transport modes:

- Local CLI mode: Paperclip launches the local `claude` binary directly on the Paperclip host.
- Remote SDK bridge mode: if `agentSdkServerUrl` is set in adapter config, Paperclip connects to a Paperclip-defined Claude SDK bridge over WebSocket instead of spawning `claude` locally.

In remote SDK bridge mode, the remote Claude host is responsible for Claude installation/authentication, and the bridge is expected to run Claude locally on its own host and stream stdout/stderr back to Paperclip. This is a Paperclip bridge protocol for self-hosted Claude infrastructure, not an official Anthropic remote-control API.

When `instructionsFilePath` is configured for a remote Claude bridge run, Paperclip reads that file on the Paperclip host and forwards the contents to the bridge. The remote host does not need the same Paperclip-local path to exist.

When Paperclip sends `paperclipWorkspace.cwd` in wake context, treat that as a Paperclip-side workspace hint, not the remote bridge's process cwd. The standalone bridge only changes Claude's working directory when `adapterConfig.cwd` is explicitly set for the Claude agent; otherwise it stays in the bridge host's own local working directory.

What the remote Claude path currently gets:

- full Paperclip API env forwarded into the remote Claude process, including `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, and `PAPERCLIP_RUN_ID`
- forwarded agent instructions contents when `instructionsFilePath` is configured
- wake payload, task markdown, session handoff markdown, cwd, and the standard Paperclip heartbeat contract in the prompt
- Claude session resume ids when the task/session is resumable

That means remote Claude starts with the same issue/task framing local Claude would normally have, and it can call the Paperclip API directly if the remote host can reach `PAPERCLIP_API_URL`.

Remote Claude topology:

```text
Paperclip server
  └─ WebSocket control channel ──> Paperclip Claude bridge on remote host
                                      └─ spawns local `claude`
                                             └─ HTTP calls back to Paperclip API when it needs to
                                                checkout/comment/mark done/create interactions
```

Paperclip can optionally send a bearer token during the SDK bridge WebSocket handshake. If you expose the bridge beyond loopback, prefer `wss://` or an SSH-forwarded loopback listener instead of plaintext `ws://`.

The bridge server currently lives in this repository as `@paperclipai/claude-sdk-server`. It is now a standalone remote package: the remote host does not need the rest of Paperclip's adapter/runtime packages just to satisfy imports. It only needs the bridge package plus the `claude` CLI installed and authenticated locally.

For an in-repo deployment on the remote Claude host, install dependencies, build the bridge package, and then start it on loopback:

```bash
pnpm install
pnpm --filter @paperclipai/claude-sdk-server build

node packages/claude-sdk-server/dist/cli.js --listen ws://127.0.0.1:4400
```

If you want the bridge to require bearer auth, create a token file and start it with `--token-file`:

```bash
mkdir -p "$HOME/.claude"
openssl rand -hex 32 > "$HOME/.claude/paperclip-bridge.token"
chmod 600 "$HOME/.claude/paperclip-bridge.token"

node packages/claude-sdk-server/dist/cli.js \
  --listen ws://127.0.0.1:4400 \
  --token-file "$HOME/.claude/paperclip-bridge.token"
```

The preferred operator pattern is to SSH-forward that loopback listener back to the Paperclip host and point `agentSdkServerUrl` at the forwarded local address. If you do connect directly over the network, Paperclip can send `agentSdkServerBearerToken` as `Authorization: Bearer <token>` during the WebSocket handshake.

Current limitation: the standalone bridge intentionally uses a slimmer local Claude execution path than the full in-process `claude_local` adapter. It preserves remote run control, prompt templates, resume IDs, env injection, and standard Claude CLI flags, but it does not currently materialize Paperclip-managed Claude skill/runtime assets on the remote host.

If you want to ship the remote bridge as a single archive instead of cloning the whole repo on the remote host, build the bridge bundle:

```bash
pnpm --filter @paperclipai/claude-sdk-server bundle
```

That creates `packages/claude-sdk-server/bundle/paperclip-claude-sdk-server-bundle.tar.gz`. Copy that archive to the remote host, unpack it, install the one external runtime dependency, and start it:

```bash
tar -xzf paperclip-claude-sdk-server-bundle.tar.gz
cd paperclip-claude-sdk-server-bundle
npm install --omit=dev
node dist/cli.js --listen ws://127.0.0.1:4400
```

In that archive flow, the remote host only needs:

- Node.js 20+
- the local `claude` CLI installed/authenticated
- network access to install the `ws` npm package, unless you vendor `node_modules` separately

For `codex_local`, there are two transport modes:

- Local CLI mode: Paperclip launches the local `codex` binary directly on the Paperclip host.
- Remote App Server mode: if `appServerUrl` is set in adapter config, Paperclip connects to a remote Codex App Server over WebSocket instead of spawning `codex` locally.

In remote App Server mode, the remote Codex host is responsible for Codex installation/authentication, and Paperclip currently expects `dangerouslyBypassApprovalsAndSandbox=true` so runs do not block on interactive approval requests that Paperclip cannot yet review remotely.

What the remote Codex path currently gets:

- the same standard Paperclip heartbeat prompt contract as local Codex when no custom `promptTemplate` is set
- wake payload, task markdown, session handoff markdown, cwd, and agent instructions contents in the prompt
- full Paperclip env values computed on the Paperclip side, including `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, and `PAPERCLIP_RUN_ID`
- Codex thread/session resume ids when the task/session is resumable

The crucial difference from remote Claude is that Codex App Server does not currently receive those Paperclip env vars as process env in the remote shell. Paperclip injects a remote-runtime note into the prompt listing those values and telling Codex to export or use them manually before calling the API or running scripts.

Remote Codex topology:

```text
Paperclip server
  └─ WebSocket control channel ──> Codex App Server on remote host
                                      └─ manages Codex thread/turn execution
                                             └─ if Codex needs Paperclip API access, it uses
                                                the env values disclosed in the prompt note
                                                rather than inherited shell env
```

Paperclip can optionally send a bearer token during the App Server WebSocket handshake, but the preferred deployment pattern is still to forward the Codex App Server management port over SSH so the WebSocket stays encrypted in transit and Paperclip can treat it like a local listener on the Paperclip host.

Paperclip accepts `ws://` and `wss://` App Server URLs, but at this time we are not aware of Codex App Server supporting a native `wss://` listener. If you need encryption in transit today, prefer SSH port forwarding or terminate TLS in front of a local `ws://` App Server listener.

If you do need to test Codex App Server token auth directly, create the capability token yourself and store it in a file that only the Codex host can read:

```bash
mkdir -p "$HOME/.codex"
openssl rand -hex 32 > "$HOME/.codex/app-server.token"
chmod 600 "$HOME/.codex/app-server.token"
```

Then start Codex App Server on loopback with that token:

```bash
codex app-server \
  --listen ws://127.0.0.1:4100 \
  --ws-auth capability-token \
  --ws-token-file "$HOME/.codex/app-server.token"
```

Set `appServerBearerToken` in the agent config if you want Paperclip to send that token as `Authorization: Bearer <token>` during the WebSocket handshake. That path is not the preferred operator setup today; prefer SSH forwarding so Paperclip connects to a forwarded local listener instead of depending on direct token-authenticated remote access.

Remote Claude vs remote Codex today:

- Prompt/task framing parity: both now start with wake payload, task markdown, session handoff, cwd, and the stronger Paperclip default prompt contract.
- Instructions parity: both now receive agent instructions contents without requiring the same Paperclip-local file path to exist on the remote host.
- API env parity: remote Claude gets the Paperclip API env directly in the spawned process; remote Codex currently gets the same values only as prompt text, not as remote shell env.
- Runtime ownership: remote Claude uses a Paperclip-owned bridge that spawns `claude`; remote Codex talks directly to Codex App Server without a Paperclip-owned execution bridge.
- Operational consequence: remote Claude is currently better suited for agents that must reliably mutate Paperclip state from the remote host. Remote Codex is now much better aligned on issue/task framing than before, but still depends more on Codex correctly using the env values disclosed in the prompt.

## 3.2 Runtime behavior

In agent runtime settings, configure heartbeat policy:

- `enabled`: allow scheduled heartbeats
- `intervalSec`: timer interval (0 = disabled)
- `wakeOnAssignment`: wake when assigned work
- `wakeOnOnDemand`: allow ping-style on-demand wakeups
- `wakeOnAutomation`: allow system automation wakeups

## 3.3 Working directory and execution limits

For local adapters, set:

- `cwd` (working directory)
- `timeoutSec` (max runtime per heartbeat)
- `graceSec` (time before force-kill after timeout/cancel)
- optional env vars and extra CLI args

For `codex_local`, you can also set:

- `appServerUrl` to switch from local CLI execution to remote Codex App Server execution
- `appServerBearerToken` to send `Authorization: Bearer <token>` during the remote App Server WebSocket handshake when the listener requires bearer auth

For `claude_local`, you can also set:

- `agentSdkServerUrl` to switch from local CLI execution to remote Claude SDK bridge execution
- `agentSdkServerBearerToken` to send `Authorization: Bearer <token>` during the remote bridge WebSocket handshake when the listener requires bearer auth

When using `appServerUrl`, prefer an SSH-forwarded local address such as `ws://127.0.0.1:<forwarded-port>` instead of pointing Paperclip at a token-protected external listener.

When using `agentSdkServerUrl`, prefer an SSH-forwarded local address or `wss://` rather than a plaintext remote `ws://` listener.

## 3.4 Prompt templates

You can set:

- `promptTemplate`: used for every run (first run and resumed sessions)

Templates support variables like `{{agent.id}}`, `{{agent.name}}`, and run context values.

## 4. Session resume behavior

Paperclip stores resumable session state per `(agent, taskKey, adapterType)`.
`taskKey` is derived from wakeup context (`taskKey`, `taskId`, or `issueId`).

- A heartbeat for the same task key reuses the previous session for that task.
- Different task keys for the same agent keep separate session state.
- If restore fails, adapters should retry once with a fresh session and continue.
- You can reset all sessions for an agent or reset one task session by task key.

Use session reset when:

- you significantly changed prompt strategy
- the agent is stuck in a bad loop
- you want a clean restart

## 5. Logs, status, and run history

For each heartbeat run you get:

- run status (`queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`)
- error text and stderr/stdout excerpts
- token usage/cost when available from the adapter
- full logs (stored outside core run rows, optimized for large output)

In local/dev setups, full logs are stored on disk under the configured run-log path.

## 6. Live updates in the UI

Paperclip pushes runtime/activity updates to the browser in real time.

You should see live changes for:

- agent status
- heartbeat run status
- task/activity updates caused by agent work
- dashboard/cost/activity panels as relevant

If the connection drops, the UI reconnects automatically.

## 7. Common operating patterns

## 7.1 Simple autonomous loop

1. Enable timer wakeups (for example every 300s)
2. Keep assignment wakeups on
3. Use a focused prompt template that tells agents to act in the same heartbeat, leave durable progress, and mark blocked work with an owner/action
4. Watch run logs and adjust prompt/config over time

## 7.2 Event-driven loop (less constant polling)

1. Disable timer or set a long interval
2. Keep wake-on-assignment enabled
3. Use child issues, comments, and on-demand wakeups for handoffs instead of loops that poll agents, sessions, or processes

## 7.3 Safety-first loop

1. Short timeout
2. Conservative prompt
3. Monitor errors + cancel quickly when needed
4. Reset sessions when drift appears

## 8. Troubleshooting

If runs fail repeatedly:

1. Check adapter command availability (`claude`/`codex` installed and logged in).
2. Verify `cwd` exists and is accessible.
3. Inspect run error + stderr excerpt, then full log.
4. Confirm timeout is not too low.
5. Reset session and retry.
6. Pause agent if it is causing repeated bad updates.

Typical failure causes:

- CLI not installed/authenticated
- bad working directory
- malformed adapter args/env
- prompt too broad or missing constraints
- process timeout

## 9. Security and risk notes

Local CLI adapters run unsandboxed on the host machine.

That means:

- prompt instructions matter
- configured credentials/env vars are sensitive
- working directory permissions matter

Start with least privilege where possible, and avoid exposing secrets in broad reusable prompts unless intentionally required.

## 10. Minimal setup checklist

1. Choose adapter (`claude_local` or `codex_local`).
2. Set `cwd` to the target workspace.
3. Add bootstrap + normal prompt templates.
4. Configure heartbeat policy (timer and/or assignment wakeups).
5. Trigger a manual wakeup.
6. Confirm run succeeds and session/token usage is recorded.
7. Watch live updates and iterate prompt/config.
