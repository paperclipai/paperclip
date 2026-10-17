# @paperclipai/adapter-opencode-local

The local OpenCode adapter for Paperclip. It lets a Paperclip agent run on a
local [OpenCode](https://opencode.ai) install backed by a local,
OpenAI-compatible LLM server (for example [Ollama](https://ollama.com)),
configured through `~/.config/opencode/opencode.json` under `provider.dev`.

## `refresh-dev-models` — keep `provider.dev.models` fresh

The model list under `provider.dev.models` is hand-maintained, so it silently
drifts from what the LLM server actually serves: phantom tags (e.g. a `:latest`
that no longer resolves) make agents pick models that fail at run time, and
newly pulled models stay invisible until someone edits the file by hand.

`refresh-dev-models` is a dependency-free, **fail-safe** generator that polls the
live Ollama `/api/tags` endpoint and rewrites **only** `provider.dev.models`,
leaving everything else byte-for-byte intact.

### Usage

```sh
# Via the package bin (after build / install):
paperclip-opencode-refresh-dev-models [options]

# Or directly:
node dist/cli/refresh-dev-models.js [options]

# Or the package script:
pnpm --filter @paperclipai/adapter-opencode-local refresh-dev-models -- [options]
```

### Options

| Flag | Description | Default |
| --- | --- | --- |
| `--config PATH` | Source opencode config to refresh | `~/.config/opencode/opencode.json` (honours `XDG_CONFIG_HOME`) |
| `--ollama-url URL` | Explicit Ollama base URL | derived from config (see below) |
| `--provider-key KEY` | Provider key to keep fresh | `dev` |
| `--timeout-ms N` | Fetch timeout in milliseconds | `15000` |
| `--dry-run` | Print the would-be config to stdout; write nothing | off |
| `--quiet` | Suppress progress logging on stderr | off |
| `-h`, `--help` | Print help and exit | — |

Exit codes: `0` = success (config fresh, unchanged, or written); `1` = fail-safe
no-op on any error (the existing config is left intact).

### Ollama URL resolution

The endpoint is resolved in precedence order:

1. `--ollama-url` (explicit)
2. `OLLAMA_URL` environment variable
3. `provider.<key>.options.baseURL` from the config (a trailing `/v1` is
   stripped, since the tags API lives at the host root)
4. `http://localhost:11434` (default)

### Fail-safe guarantees

- Preserves `provider.dev.options` (baseURL/timeout/apiKey/…) verbatim.
- Preserves every non-`dev` provider and all other top-level keys and ordering.
- JSONC-tolerant read (strips `//` and `/* */` comments and trailing commas);
  the stripper is string-literal aware, so a `http://` inside a value is never
  mistaken for a comment.
- Writes atomically (temp file + `fsync` + rename) and takes a timestamped
  `.bak` of the previous bytes before every write.
- On **any** fetch/parse/empty-result error it throws and leaves the existing
  good config untouched — it never clobbers a good config with junk, and it
  never writes when nothing changed.

### Scheduling

Run it on a short interval so the configured model list never drifts — via a
Paperclip routine (schedule + manual triggers) or a host cron entry. Because it
is a no-op when the config already matches the server, it is safe to run
frequently.
