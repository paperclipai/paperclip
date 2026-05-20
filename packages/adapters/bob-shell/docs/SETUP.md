# Using Paperclip with the Bob Shell Adapter

This guide walks you through cloning the repo, building Paperclip, and setting up an agent that runs on Bob Shell.

## Prerequisites

- Node.js 20+ and [pnpm](https://pnpm.io) installed
- Bob Shell installed and available in your `PATH` (verify with `bob --version`)
- A Paperclip account with API credentials

## 1. Clone and Build

```bash
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
pnpm install
pnpm build
```

Start the Paperclip server:

```bash
pnpm dev
```

The UI is available at `http://localhost:3000` by default.

## 2. Configure Your Bob API Key

Bob Shell needs an API key to authenticate with the Bob service.
Set it in your environment before starting Paperclip, or add it to your `.env`:

```bash
export BOBSHELL_API_KEY=<your-key>
```

Alternatively you can inject it per-agent via the **Environment Variables** section in the agent config UI (key: `BOBSHELL_API_KEY`).

## 3. Create a Bob Shell Agent

1. Open the Paperclip UI → **Agents** → **New Agent**
2. Set **Adapter** to `Bob Shell`
3. Fill in the adapter fields:

| Field | Value | Notes |
|---|---|---|
| **Command** | `bob` | Path to Bob Shell binary, e.g. `/usr/local/bin/bob` |
| **Mode** | *(leave blank)* | Auto-derived from agent role; or set `paperclip-agent` explicitly |
| **Working Directory** | `/path/to/your/project` | Absolute path Bob Shell will operate in |
| **Timeout (seconds)** | `1800` | 30 min; set `0` for no timeout |
| **Grace Period (seconds)** | `20` | Time between SIGTERM and SIGKILL on cancel |

4. Under **Role**, choose the agent's role (e.g. `engineer`, `cto`). The adapter automatically maps roles to appropriate tool groups:
   - `engineer` → `read, edit, command, mcp`
   - `ceo` / `cto` / `coo` / `vp` → `read, command, mcp`
   - `manager` / `cmo` / `cfo` → `read, mcp`

5. Save the agent.

## 4. Verify the Setup

On the agent's settings page, click **Test Environment**. Paperclip runs `bob --version` and checks that the MCP connection is reachable. All checks should show green.

If Bob Shell is not found, set the full path in the **Command** field (e.g. `/usr/local/bin/bob`).

## 5. How It Works

When an agent heartbeat fires, Paperclip:

1. Writes a `.bob/` workspace configuration into the working directory:
   - `.bob/custom_modes.yaml` — defines the `paperclip-{role}` mode
   - `.bob/mcp.json` — wires Bob Shell back to Paperclip via MCP
   - `.bob/rules-paperclip-{role}/*.md` — injects company skills and agent instructions
2. Launches `bob --mode paperclip-{role} <prompt>` in the working directory
3. Streams Bob Shell's stdout, extracts metadata (tokens, cost, model), and posts the result back to Paperclip

Bob Shell connects back to Paperclip via MCP using credentials injected at runtime — no credentials are written to disk.

## Troubleshooting

**`Command not found: bob`**
Bob Shell is not in `PATH`. Either install it or set the full path in the **Command** field.

**MCP connection failed**
- Confirm Paperclip is running and reachable from the machine where Bob Shell executes.
- Check that `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY` are valid (visible in agent logs).

**Authentication error from Bob Shell**
`BOBSHELL_API_KEY` is missing or invalid. Set it in the agent's environment variables.

**`.bob/` files not generated**
The agent's working directory must exist and be writable by the Paperclip server process.
