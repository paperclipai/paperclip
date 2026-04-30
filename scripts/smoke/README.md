# Paperclip smoke scripts

Scripts in this directory drive end-to-end sanity checks against a running
Paperclip server. They are intentionally thin and stand-alone so they can be
re-used from a developer laptop **or** from CI.

## Scripts

| Script                       | Purpose                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `openclaw-join.sh`           | OpenClaw invite + join acceptance flow.                                       |
| `openclaw-docker-ui.sh`      | OpenClaw UI smoke via docker.                                                 |
| `openclaw-gateway-e2e.sh`    | OpenClaw gateway end-to-end smoke.                                            |
| `openclaw-sse-standalone.sh` | OpenClaw SSE receiver standalone check.                                       |
| `ollama-local-smoke.mjs`     | `@paperclipai/adapter-ollama-local` M1 smoke (GEM-7 acceptance criterion #9). |

## `ollama-local-smoke.mjs`

End-to-end validation that the Ollama local adapter installs, executes a
heartbeat against a running Ollama server, and that the server auto-posts the
run summary as an issue comment.

### Prerequisites

- Node.js ≥ 18 (uses global `fetch`). No `jq`, no `curl`, no other system deps.
- A running Paperclip server reachable at `PAPERCLIP_API_URL` (default
  `http://127.0.0.1:3100`).
- A running Ollama server reachable at `OLLAMA_BASE_URL` (default
  `http://127.0.0.1:11434`) with the target model pulled locally:

  ```bash
  ollama pull llama3.1:8b
  ```

- A valid API token in `PAPERCLIP_API_KEY` (board JWT or a short-lived run JWT)
  with permission to install adapters, create agents, create issues, and wake
  agents in the target company.

### Environment variables

| Variable               | Required | Default                                             | Notes                                                              |
| ---------------------- | -------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| `PAPERCLIP_API_URL`    | no       | `http://127.0.0.1:3100`                             | Paperclip server base URL.                                         |
| `PAPERCLIP_COMPANY_ID` | **yes**  | —                                                   | Company the smoke agent/issue are created in.                      |
| `PAPERCLIP_API_KEY`    | **yes**  | —                                                   | Bearer token.                                                      |
| `PAPERCLIP_RUN_ID`     | no       | —                                                   | Forwarded as `X-Paperclip-Run-Id` when running inside a heartbeat. |
| `OLLAMA_MODEL`         | no       | `llama3.1:8b`                                       | Model passed to the adapter. CLI arg `argv[2]` wins if provided.   |
| `OLLAMA_BASE_URL`      | no       | `http://127.0.0.1:11434`                            | Ollama server URL wired into the adapter config.                   |
| `OLLAMA_LOCAL_PATH`    | no       | `<repo>/packages/adapters/ollama-local` (resolved)  | Filesystem path to the local adapter package.                      |

### Usage

```bash
# default model (llama3.1:8b)
node scripts/smoke/ollama-local-smoke.mjs

# override the model via CLI argument (takes precedence over OLLAMA_MODEL)
node scripts/smoke/ollama-local-smoke.mjs qwen2.5:7b

# override the model via env var
OLLAMA_MODEL=qwen2.5:7b node scripts/smoke/ollama-local-smoke.mjs
```

The script prints each step, polls the heartbeat run for up to ~120 seconds,
and exits with code `0` on success or `1` on any validation failure.

### Cleanup

The script creates a throwaway agent (`ollama-smoke-<timestamp>`) and a
throwaway issue in the target company. Their ids are printed on success —
cancel or delete them manually if you want to keep the company tidy.

### Related

- [GEM-7](/GEM/issues/GEM-7) — Ollama adapter M1
- [GEM-16](/GEM/issues/GEM-16) — bug fixes that justified the Node port
