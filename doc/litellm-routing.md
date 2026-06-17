# LiteLLM Model Routing

Date: 2026-06-10
Status: deployed and verified (container lane of `doc/plans/2026-06-10-gbrain-memory-control-plane.md`)

## Topology — what runs where

Two LiteLLM instances exist on this machine. Do not confuse them.

| Instance | Where | Port | Backends | Status |
| --- | --- | --- | --- | --- |
| `com.steve.model-router` | Host LaunchAgent, venv at `~/.local/share/steve-model-router` | `127.0.0.1:4000` | OpenRouter aliases (`aios-*`, `router-smoke`, `mitra-coder`, …) | LIVE — already used by Hermes/Paperclip agents. Do not touch. |
| `steve-litellm` | Docker container `ghcr.io/berriai/litellm:main-stable`, `--restart unless-stopped` | `127.0.0.1:4001` | Local ollama models + `openrouter/*` passthrough | New (this work). |

Port deviation: the plan named `127.0.0.1:4000` for the container, but 4000 is
held by the live legacy router LaunchAgent. The container binds
`127.0.0.1:4001` instead. Consolidating the two instances is a deliberate
follow-up decision for the operator, not something to do in passing.

Shared backing store: docker container `steve-litellm-postgres` (postgres:16 at
`127.0.0.1:55432`, db/user `litellm`). Both instances point at the same
database (spend logs are commingled; the container baselined the schema to its
litellm version on first boot — the legacy router kept working, verified).
`store_model_in_db: false` — the config file stays the source of truth for
models.

## Config and master key

- Config path: `~/.config/litellm/config.yaml` (mounted read-only into the
  container at `/app/config.yaml`).
- The master key lives ONLY in that file (`general_settings.master_key`). It is
  not duplicated anywhere else on purpose — read it from the file when needed.
- The legacy router's config/master key are separate
  (`~/.local/share/steve-model-router/config.yaml` + its `.env`); the two
  instances do not accept each other's master keys.

Models served by `steve-litellm` (as of deployment):

- ollama (host ollama at `127.0.0.1:11434`, reached via
  `host.docker.internal`): `qwen3:32b`, `gemma4:12b`, `gemma4:12b-64k`,
  `gemma4-extended`, `llama3.1:70b`, `nous-hermes2-mixtral`, `glm-ocr`,
  `nomic-embed-text` (embedding).
- `openrouter/*` wildcard passthrough (the only provider key present on this
  host is `OPENROUTER_API_KEY`; no `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
  exists anywhere on the machine, so there are no direct anthropic/openai
  entries — Claude/GPT models are reachable as `openrouter/anthropic/...` /
  `openrouter/openai/...`).

## How to add a provider key

1. Add the key to the container environment by name (never inline in the
   config). Recreate the container with an extra `-e NAME` (value sourced from
   wherever the secret lives, e.g. a `.env` file — never echo it):

   ```sh
   docker rm -f steve-litellm
   export ANTHROPIC_API_KEY=...   # in the shell only
   docker run -d --name steve-litellm \
     --restart unless-stopped \
     -p 127.0.0.1:4001:4000 \
     -v "$HOME/.config/litellm/config.yaml:/app/config.yaml:ro" \
     -e DATABASE_URL='postgresql://litellm:<password>@host.docker.internal:55432/litellm' \
     -e OPENROUTER_API_KEY \
     -e ANTHROPIC_API_KEY \
     ghcr.io/berriai/litellm:main-stable \
     --config /app/config.yaml --port 4000
   ```

   (The DATABASE_URL password is in the current container's env:
   `docker inspect steve-litellm`.)

2. Reference it from `~/.config/litellm/config.yaml` with the `os.environ/`
   indirection, then restart:

   ```yaml
   - model_name: claude-sonnet-4-5
     litellm_params:
       model: anthropic/claude-sonnet-4-5
       api_key: os.environ/ANTHROPIC_API_KEY
   ```

   ```sh
   docker restart steve-litellm
   ```

3. Verify: `curl -H "Authorization: Bearer <master_key>" http://127.0.0.1:4001/v1/models`.

Config-only changes (no new env var) need just the edit + `docker restart steve-litellm`.

## How a Paperclip agent opts in

Env vars reach adapter CLIs through three layers, merged in this order (later
wins), in `resolveExecutionRunAdapterConfig`
(`server/src/services/heartbeat.ts` ~line 421):

1. **Agent** — `agents.adapterConfig.env` (object of `NAME: "value"`). Edit via
   Agent settings in the UI or `PATCH /api/agents/:agentId` with the merged
   `adapterConfig`.
2. **Project** — `projects.env` (overrides agent).
3. **Routine** — `routines.env` (overrides both).

The adapter (`packages/adapters/claude-local/src/server/execute.ts` ~179, and
the codex-local equivalent ~326) lays `config.env` over `process.env` when
spawning the CLI, so any `NAME` set there is visible to the CLI process.

Constraints:

- `PAPERCLIP_*` keys are reserved and stripped from operator-supplied env.
- Low-trust (`low_trust_review`) runs reject inline plain values for
  sensitive-looking keys (`*_API_KEY`, `*AUTH_TOKEN*`, etc.) — those must come
  via secret bindings. `*_BASE_URL` vars are fine inline.

### claude-local

```json
"env": {
  "ANTHROPIC_BASE_URL": "http://127.0.0.1:4001",
  "ANTHROPIC_AUTH_TOKEN": "<litellm master key or a virtual key>",
  "ANTHROPIC_MODEL": "openrouter/anthropic/claude-sonnet-4-5"
}
```

`ANTHROPIC_MODEL` is required in practice: there is no direct Anthropic
upstream key, so the model name must be one the proxy serves (an
`openrouter/anthropic/...` id or a local ollama model name). Use
`http://127.0.0.1:4000` instead only if you intend to hit the legacy router
and one of its alias models.

### codex-local

```json
"env": {
  "OPENAI_BASE_URL": "http://127.0.0.1:4001/v1",
  "OPENAI_API_KEY": "<litellm master key or a virtual key>"
}
```

Plus a model override in the adapter config pointing at a proxy-served model
(e.g. `openrouter/openai/gpt-5.2-codex` or `qwen3:32b`). Note codex-local
treats a present `OPENAI_API_KEY` as API-key billing mode
(`packages/adapters/codex-local/src/server/execute.ts` ~87).

## WARNING — do not flip live agents blind

Do NOT point a live agent at the proxy by editing its env and walking away.
First create one harmless test issue, assign it to the reconfigured agent,
watch the run complete end-to-end (response quality, billing mode, run
summary), and only then consider switching anything else. Base-URL env changes
silently reroute every request the CLI makes; a wrong model name or dead proxy
turns into stalled runs, not loud errors. Leave `com.steve.model-router`
(port 4000) and its LaunchAgent alone — live agents depend on it.

## Verification record (2026-06-10)

- `GET /v1/models` with master key: 200, 8 ollama entries + openrouter
  wildcard expansion (~100 ids).
- `POST /v1/chat/completions` model `gemma4:12b`, "Reply with exactly:
  routing ok" → `"routing ok"`, finish `stop`: cold (model load) 6.99 s,
  warm 2.03 s.
- Legacy router `http://127.0.0.1:4000/health/liveliness` still 200 after the
  container baselined the shared DB.
- Container first boot took ~6.5 min (prisma baseline of 123 migrations
  against the pre-existing schema); subsequent restarts are fast.
