# `@paperclipai/adapter-ollama-local`

Run Paperclip agents against a local [Ollama](https://ollama.com) instance.
External adapter package — loaded via `plugin-loader.ts` at runtime, never from
`BUILTIN_ADAPTER_TYPES`.

- Adapter type: `ollama_local`
- Scope: **local only in v1.** Remote hosts with auth deferred to v1.1 (depends on plugin-SDK secret write).
- Transport: `POST /api/chat` with NDJSON streaming. Non-streaming fallback available.

---

## Install

### 1. Install and start Ollama

```bash
# macOS / Windows / Linux — install per https://ollama.com/download
ollama serve            # starts the HTTP server on 127.0.0.1:11434
```

Verify:

```bash
curl http://127.0.0.1:11434/api/tags
```

### 2. Pull at least one model

See the [cookbook](#ollama-pull-cookbook) below.

### 3. Register the adapter with Paperclip

Add the package to `~/.paperclip/adapter-plugins.json`:

```json
{
  "plugins": [
    {
      "adapterType": "ollama_local",
      "packageName": "@paperclipai/adapter-ollama-local",
      "localPath": "/absolute/path/to/packages/adapters/ollama-local"
    }
  ]
}
```

Then restart the Paperclip server. The plugin loader picks it up at boot.

### 4. Create an agent with `adapterType: "ollama_local"`

Either through the UI (pick "Ollama (local)" in the adapter dropdown) or via
`POST /api/companies/:companyId/agents` with `adapterType: "ollama_local"` and
the config fields below.

---

## Configuration

All fields are optional unless noted. Sane defaults are defined in `src/constants.ts`.

| Field | Default | Notes |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:11434` | Ollama HTTP endpoint. Redacted in logs (origin only). |
| `model` **(required)** | `llama3.1:8b` | Tag as shown by `ollama list` — must be pulled locally first. |
| `contextWindow` | `8192` | Maps to Ollama's `num_ctx`. Adapter pre-checks the prompt and truncates the trailing user message if it would overflow. |
| `keepAliveSec` | `300` | Ollama `keep_alive` in seconds — how long the model stays resident after the last request. |
| `requestTimeoutSec` | `600` | Hard timeout per `/api/chat` request. |
| `maxOutputTokens` | unset | Maps to `num_predict`. Leave 0 / unset for Ollama default. |
| `temperature` | `0.7` | Sampling temperature (0–2). |
| `topP` | `0.9` | Nucleus sampling (0–1). |
| `instructionsFilePath` | `""` | Absolute path to a markdown file prepended as the system message. |
| `promptTemplate` | built-in | User-turn template. Handlebars-style variables: `{{agent.id}}`, `{{agent.name}}`, `{{runId}}`, etc. |

---

## `ollama pull` cookbook

Default model used when none is configured:

```bash
ollama pull llama3.1:8b
```

Other models recognised by the adapter's picker UI:

```bash
ollama pull llama3.1:70b          # heavier; needs ~40 GB RAM or GPU equivalent
ollama pull qwen2.5:7b            # solid generalist, good multilingual
ollama pull qwen2.5:14b
ollama pull qwen2.5:0.5b          # tiny — used by the integration test suite
ollama pull mistral:7b
ollama pull deepseek-coder:6.7b   # code-centric
```

Tag selection cheat-sheet:

- `:latest` → rolling, not reproducible across pulls. Avoid for production agents.
- `:8b`, `:70b`, `:0.5b` → parameter-size tags. Stable across pulls for a given family.
- `:q4_K_M`, `:q5_K_M`, `:fp16` → quantisation tags. Lower-bit = less VRAM, slightly worse quality.

Verify the pull landed:

```bash
ollama list
```

Remove an old model to reclaim disk:

```bash
ollama rm llama3.1:8b
```

---

## Troubleshooting matrix

| Symptom | Error code / log line | Fix |
|---|---|---|
| Heartbeat fails immediately with "Could not reach Ollama" | `ollama_connection_refused` | Run `ollama serve`. Confirm the `baseUrl` matches (default `http://127.0.0.1:11434`). On WSL2, connecting from a Linux container to a Windows-host Ollama requires the Windows host IP, not `127.0.0.1`. |
| Heartbeat fails with "Model ... is not available" | `ollama_model_not_found` (HTTP 404) | `ollama pull <model>` — the adapter will not auto-pull. |
| Heartbeat times out partway through streaming | `ollama_timeout` | Increase `requestTimeoutSec`, or use a smaller model / quant. The adapter retries transient timeouts up to `maxAttempts=3` with exponential backoff automatically. |
| Heartbeat succeeds but output is truncated or off-topic | `[paperclip] ollama_local context_overflow event={...}` in stderr | Transcript exceeded `contextWindow`. Raise the window, pick a larger-context model, or shorten the wake payload. The adapter preserves the system message and trims the trailing user message so the run still completes. |
| Multiple agents running slowly / one blocking the other | no dedicated error; throughput drops | Ollama serves one model at a time per GPU. Run a single large-model agent at a time, or use smaller models you can fit concurrently. |
| Garbled non-ASCII output | no error | Confirm `temperature` isn't above 1.5 and the model supports the language. Qwen2.5 is the strongest multilingual in the default picker. |
| Intermittent `undici UND_ERR_CONNECT_TIMEOUT` on WSL2 | appears as `ollama_connection_refused` | The adapter already treats WSL2 connect-timeouts as "connection refused" and surfaces the install hint. If it persists when Ollama IS running, check the firewall / listen address. |
| CI suite flakes around connection-refused test | N/A | The integration suite uses `src/server/integration/closed-port.ts` to get a deterministic refused-port URL on WSL2 — reuse that helper instead of hard-coding an unused port. |

### Structured heartbeat logs

Every heartbeat emits one structured event line to stderr for CI assertions:

```
[paperclip] ollama_local event={"adapter":"ollama_local","model":"qwen2.5:0.5b","baseUrl":"http://127.0.0.1:11434","tokensIn":423,"tokensOut":112,"elapsedMs":1847,"compacted":false,"status":"ok","errorCode":null}
```

Fields:

- `adapter`, `model` — constants / config values.
- `baseUrl` — origin only; userinfo, query, and hash are stripped by `redactBaseUrl()`.
- `tokensIn` / `tokensOut` — pulled from Ollama's `prompt_eval_count` / `eval_count`.
- `elapsedMs` — wall-clock from the top of `execute()`.
- `compacted` — true when EITHER the pre-send overflow check fired OR Ollama's post-send `prompt_eval_count` already hit `num_ctx`.
- `status` — `ok | error | timeout`.
- `errorCode` — nullable; mirrors `AdapterExecutionResult.errorCode`.

Retry attempts emit their own line:

```
[paperclip] ollama_local retry attempt=1 delayMs=287 code=connection_refused
```

Context-overflow events emit:

```
[paperclip] ollama_local context_overflow event={"contextWindow":8192,"budgetTokens":6144,"preTokens":7502,"postTokens":5991,"droppedChars":6055,"strategy":"drop-tail","phase":"pre_send"}
```

---

## Licensing matrix

Ollama itself is MIT licensed. Individual models carry their own licenses; the
operator is responsible for ensuring the chosen model is allowed for their use
case. Summary as of 2026-04-20 — verify against the upstream model page before
production use:

| Model family | License | Commercial use | Attribution | Notes |
|---|---|---|---|---|
| `llama3.1:*` | Meta Llama 3.1 Community License | Yes, with MAU cap (>700M requires separate license) | Required in visible app surface | Acceptable-use policy applies. |
| `llama3.2:*` | Meta Llama 3.2 Community License | Same MAU cap as 3.1 | Required | Same acceptable-use policy. |
| `qwen2.5:*` (≤ 72B except 72B) | Apache-2.0 | Yes | Required | `qwen2.5:72b` is under Qwen License with its own MAU cap — check before shipping. |
| `qwen2.5:0.5b` | Apache-2.0 | Yes | Required | Default CI test model. |
| `mistral:7b` | Apache-2.0 | Yes | Required | |
| `deepseek-coder:*` | DeepSeek License (custom) | Yes with restrictions | Required | Review restrictions before embedding in a commercial product. |
| `gemma2:*` | Gemma Terms of Use (Google) | Yes with restrictions | Required | Prohibited-use policy applies. |
| `phi3:*` | MIT | Yes | Not required (but polite) | |

**v1 posture:** the adapter does not surface the model license to end users at
heartbeat time — model choice is an operator/agent-config decision. The
companion plugin (`@paperclipai/plugin-ollama`) exposes the license in the model
picker UI.

---

## Related issues

- [GEM-7](/GEM/issues/GEM-7) — M1 adapter MVP
- [GEM-8](/GEM/issues/GEM-8) — M2 companion plugin
- [GEM-9](/GEM/issues/GEM-9) — M3 hardening + docs (this README)
- [GEM-40](/GEM/issues/GEM-40) — CI integration suite
- [GEM-41](/GEM/issues/GEM-41) — structured heartbeat logger
- [GEM-42](/GEM/issues/GEM-42) — retries with exponential backoff
- [GEM-43](/GEM/issues/GEM-43) — context-overflow telemetry
