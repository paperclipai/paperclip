---
title: ACPX Sidecar
summary: Run Paperclip agents through dedicated external sidecar containers that shell out to acpx and official CLIs
---

The `acpx_sidecar` adapter lets Paperclip orchestrate an external runtime container instead of executing CLIs inside the main Paperclip process.

Use this adapter when:

- you want official CLIs (`codex`, `claude`, `gemini`, `openclaw`, `opencode`, `pi`) isolated in dedicated containers
- you want the sidecar container, not Paperclip, to own `acpx` session state
- you want provider-specific auth and network policy separated from the Paperclip API/UI container

How it works:

1. Paperclip renders the prompt and optional instructions file.
2. Paperclip calls `POST /run` on the sidecar.
3. The sidecar runs:
   - `acpx <agent> sessions ensure --name <session>`
   - optional `acpx <agent> set model <model>`
   - `acpx <agent> prompt -s <session> --file -`
4. The sidecar returns raw ACP JSON output.
5. Paperclip parses the ACP stream and stores the run summary.

## Required sidecar HTTP contract

`GET /health`

Returns a simple health payload.

`GET /status`

Returns sidecar rate-limit and active-run status.

`POST /run`

Request body:

```json
{
  "agent": "katya",
  "args": ["--cwd", "/home/node/workspaces/katya", "--format", "json", "--json-strict", "gemini", "prompt", "-s", "paperclip-katya", "--file", "-"],
  "cwd": "/home/node/workspaces/katya",
  "stdin": "Prompt text goes here",
  "timeout": 300
}
```

Response body:

```json
{
  "ok": true,
  "provider": "gemini",
  "agent": "katya",
  "command": ["acpx", "--cwd", "/home/node/workspaces/katya", "..."],
  "cwd": "/home/node/workspaces/katya",
  "exit_code": 0,
  "stdout": "{\"jsonrpc\":\"2.0\",...}",
  "stderr": "",
  "status": {}
}
```

## Adapter configuration

Core fields:

- `url`: sidecar base URL
- `agentCommand`: acpx runtime name such as `gemini`, `claude`, `codex`, `openclaw`, `opencode`, `pi`
- `cwd`: sidecar-local working directory
- `instructionsFilePath`: optional instructions markdown file
- `promptTemplate`: run prompt template
- `model`: optional `acpx set model ...` value
- `sessionNameTemplate`: optional session name template
- `extraArgs`: optional extra acpx flags
- `timeoutSec`: prompt timeout

Example:

```json
{
  "adapterType": "acpx_sidecar",
  "adapterConfig": {
    "url": "http://sidecar-gemini-shared:8730",
    "agentCommand": "gemini",
    "cwd": "/home/node/workspaces/katya",
    "model": "gemini-3.1-pro",
    "instructionsFilePath": "/home/node/workspaces/katya/AGENTS.md",
    "promptTemplate": "You are {{agent.name}}. Continue your Paperclip work."
  }
}
```
