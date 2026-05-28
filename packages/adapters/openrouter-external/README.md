# @marcpbailey/paperclip-adapter-openai

A Paperclip external adapter that lets agents call any **OpenAI Chat Completions–compatible** endpoint. The headline use case is [OpenRouter](https://openrouter.ai/) (`https://openrouter.ai/api/v1`), but nothing here is OpenRouter-specific — point `baseUrl` at `https://api.openai.com/v1`, a self-hosted vLLM, or any other OpenAI-shaped gateway and it works the same way.

Adapter `type` key: `openai`.

Implements the design proposed in [paperclipai/paperclip#3170](https://github.com/paperclipai/paperclip/issues/3170) (Option C — generic OpenAI-compatible adapter).

## Why

OpenRouter exposes OpenAI-shaped APIs for hundreds of frontier and open-source models, including free tiers. Configuring `baseUrl: https://openrouter.ai/api/v1` plus any OpenRouter model slug lets every Paperclip agent run on any of those models without a per-provider adapter. Swap the underlying LLM by changing one string.

## What it isn't

This is **not** a coding-tool-aware adapter. It has no shell access and no skill execution surface. For agents that need to run commands, edit files, or use the broader Paperclip skill ecosystem, use `claude_local`, `codex_local`, or `opencode_local`. This adapter is for pure LLM-call agents — heartbeats that ask a model a question and stream the answer back.

## Installation

Published to npm as [`@marcpbailey/paperclip-adapter-openai`](https://www.npmjs.com/package/@marcpbailey/paperclip-adapter-openai). Install through your Paperclip instance — instance-admin auth required.

### From the Paperclip UI

`Settings → Adapters → Install Adapter`, enter `@marcpbailey/paperclip-adapter-openai`.

### From the browser devtools console (logged-in tab)

```js
await fetch('/api/adapters/install', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ packageName: '@marcpbailey/paperclip-adapter-openai' })
}).then(r => r.json())
```

The server runs `npm install` into its managed adapter directory and registers the adapter immediately — no Paperclip restart needed.

### Updating to a new version

Once a newer version is on npm, hot-reload it without restarting Paperclip:

```js
await fetch('/api/adapters/openai/reinstall', { method: 'POST' }).then(r => r.json())
```

### Local development install (when iterating on this code)

If you're editing the adapter source and need Paperclip to pick up changes without an npm publish round-trip, install by local path. Build first, then:

```js
await fetch('/api/adapters/install', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ packageName: '/absolute/path/to/adapter-openai', isLocalPath: true })
}).then(r => r.json())
```

For Dockerized Paperclip, the path must resolve inside the container — bind-mount the source via a compose override (e.g., `volumes: ["/host/path:/srv/adapters/openai:ro"]`). Switch back to the npm version with `DELETE /api/adapters/openai` followed by a normal install.

After source edits, run `npm run build` then either `POST /api/adapters/openai/reload` (file cache bust, no npm) or rebuild and reinstall.

## Configuration

Per-agent `.paperclip.yaml` block:

```yaml
adapter:
  type: openai
  config:
    baseUrl: https://openrouter.ai/api/v1
    model: anthropic/claude-sonnet-4
    # Optional. {{agentId}}, {{agentName}}, {{companyId}},
    # {{runId}}, {{taskId}}, {{taskTitle}} are substituted.
    promptTemplate: |
      Continue your work on issue {{taskTitle}}.
inputs:
  env:
    OPENROUTER_API_KEY:
      kind: secret
      requirement: required
```

`OPENAI_API_KEY` is accepted as a fallback if `OPENROUTER_API_KEY` is not set, so the same adapter can target `api.openai.com` without renaming the variable.

### Supported config keys

| Key | Default | Notes |
|---|---|---|
| `baseUrl` | `https://openrouter.ai/api/v1` | Must be HTTPS. Any OpenAI-compatible endpoint. |
| `model` | `anthropic/claude-sonnet-4` | Provider/model slug for the configured endpoint. |
| `promptTemplate` | `"Continue your work on issue {{taskTitle}}."` | Mustache-style `{{var}}` substitution. |

### Supported env keys

| Var | Required | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | yes (or `OPENAI_API_KEY`) | API key for the configured endpoint. |
| `OPENAI_API_KEY` | fallback | Used when `OPENROUTER_API_KEY` is unset. |

## Verification

After install, run:

```sh
paperclipai doctor
```

and confirm the `openai` adapter appears as discoverable. Then trigger any agent's heartbeat — the LinkCast company package's `rollcall` task is a good first acceptance test (it routes through this adapter once `paperclip/linkcast/.paperclip.yaml` is loaded).

## Limitations

- **No streaming UI parser polish.** Token deltas are rendered as plain assistant text. Tool-call cards, thinking blocks, and structured progress are not parsed because the OpenAI Chat Completions stream doesn't carry that structure for us. A richer parser could be added if/when we wire tool-use through.
- **No automatic retries.** A failed call surfaces immediately as `exitCode: 1`. Add retry policy at the agent or company-package level if you need it.
- **No fallback model.** One adapter, one model per agent. Configure multiple agents if you want to try multiple models.
- **No tool-use support.** The OpenAI tools API is exposed by the SDK but not currently wired through here. Add when the first agent needs it.
- **No session persistence.** Each heartbeat is a single user-message round trip; there's no `sessionParams` written back. Agents that need conversational continuity should either embed history in the prompt template or use one of the local coding adapters.

## Maintenance

### Source location

Source lives in the [paperclipai/paperclip](https://github.com/paperclipai/paperclip) tree (via fork `marcpbailey/paperclip`) at `packages/adapters/openrouter-external/`. Moved here from `linkcast/crew/paperclip/adapter-openai` on 2026-05-04 as a staging step before promoting this adapter to a built-in `openrouter_local` package (sibling to `codex-local`, `claude-local`, etc.). The `-external` suffix marks the package as not yet a built-in adapter type — it is not listed in `BUILTIN_ADAPTER_TYPES`. The npm package is published under `@marcpbailey` (personal scope).

### Releasing a new version

From the adapter directory:

```sh
cd /path/to/adapter-openai
# edit source
npm run build                          # tsc → ./dist
npm version patch                       # or minor/major; bumps package.json + creates a tag if in a git repo
npm publish --access public             # public required for personal scope
```

The `--access public` flag is mandatory for first publishes under a personal scope; npm defaults scoped packages to private and 402s without a paid plan.

If `npm publish` prints `Authenticate your account at: https://www.npmjs.com/auth/cli/...`, **open that URL in a browser and click Authorize before pressing Enter** — the publish silently no-ops if you don't.

After the publish lands (verify with `curl -s https://registry.npmjs.org/@marcpbailey/paperclip-adapter-openai | jq '."dist-tags".latest'`), pull it into your Paperclip instance:

```js
// devtools console, logged-in tab
await fetch('/api/adapters/openai/reinstall', { method: 'POST' }).then(r => r.json())
```

### Removing the adapter

```js
await fetch('/api/adapters/openai', { method: 'DELETE' }).then(r => r.json())
```

This unregisters the adapter and runs `npm uninstall` on the package (when installed from npm). Existing agents already configured for this adapter type will fail to execute until something fills the slot again.

### History

The adapter was first installed via local-path bind mount into a Docker container, which broke any time `docker compose up` was invoked without the right override file. Switching to the npm-install path moved the adapter into the server's named Docker volume (`paperclip-data:/paperclip`) so it survives any restart from any working directory with no host-path coupling. See `POST /api/adapters/install` and `POST /api/adapters/:type/reinstall` in [server/src/routes/adapters.ts](https://github.com/paperclipai/paperclip/blob/master/server/src/routes/adapters.ts) for the install internals.
