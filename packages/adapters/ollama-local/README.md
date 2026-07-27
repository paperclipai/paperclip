# Ollama Local Adapter

`@paperclipai/adapter-ollama-local` connects Paperclip to an Ollama deployment
over either of Ollama's supported chat surfaces:

- `openai` (the default): `/v1/chat/completions`
- `ollama`: `/api/chat`

Configure an agent with `adapterType: "ollama_local"` and provide an installed
`model` in its adapter configuration. `baseUrl` defaults to
`http://127.0.0.1:11434`; `apiKey` is optional and is sent as a bearer token
when the endpoint is protected. Streaming is enabled by default, and the
adapter preserves streamed text and tool-call deltas across chunks before
running bounded tool-result rounds. `responseFormat` can be used for native
JSON or schema-constrained output.

The adapter does not start Ollama. Start Ollama separately, ensure the selected
model is installed (for example, with `ollama list`), and use the adapter's
environment test to diagnose connectivity or model availability.
