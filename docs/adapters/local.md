---
title: Local OpenAI-Compatible Adapter
summary: Run a Paperclip heartbeat through a local OpenAI-compatible chat endpoint
---

The `local` adapter sends one OpenAI-compatible `/chat/completions` request per heartbeat. It is intended for local inference servers such as LM Studio that expose a `/v1` API.

## Configuration

```json
{
  "adapterType": "local",
  "adapterConfig": {
    "model": "qwen/qwen3-coder-30b",
    "baseUrl": "http://localhost:1234/v1",
    "instructionsFilePath": "/absolute/path/to/AGENTS.md",
    "maxTurns": 20
  }
}
```

Fields:

- `model` is the OpenAI-compatible chat model id.
- `baseUrl` defaults to `http://localhost:1234/v1`.
- `apiKey` is optional and is sent as a bearer token when configured.
- `instructionsFilePath` is injected into the prompt.
- `maxTurns` is used only by the `claude_local` fallback.

## Availability And Fallback

At the start of each run, Paperclip probes the local `/models` endpoint and honors the same override variables as the local inference flag script:

- `INFERENCE_LOCAL_URL_OVERRIDE`
- `INFERENCE_LOCAL_AVAILABLE=0`
- `INFERENCE_LOCAL_AVAILABLE=1`
- `INFERENCE_LOCAL_FORCE=on`
- `INFERENCE_LOCAL_FORCE=off`
- `INFERENCE_LOCAL_TIMEOUT_S`

When local inference is unavailable, Paperclip routes that run through `claude_local` using the same `instructionsFilePath` and `maxTurns`. The agent record is not changed.

## Health

Check local inference from the server:

```sh
curl http://localhost:3100/api/inference/local/health
```

The response includes:

```json
{
  "available": true,
  "url": "http://localhost:1234/v1",
  "models": ["qwen/qwen3-coder-30b"]
}
```
