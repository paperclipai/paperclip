# hermes_local — adapter design

Status: V1 design (2026-05-01). Minimal-but-functional. Mirrors `opencode_local`.

## 1. Hermes CLI invocation pattern

The Hermes CLI ships as `~/.local/bin/hermes`. Two non-interactive modes are
suitable for adapter use:

- `hermes -z PROMPT` — top-level "oneshot": prints **only the final response
  text** to stdout. No banner, no spinner, no tool previews, no `session_id:`
  line. Tools, memory, rules, AGENTS.md still load. Approvals auto-bypassed.
- `hermes chat -q QUERY -Q` — quiet single-query: prints `session_id: <id>` on
  the first line, then the final response. We need the session id, so V1 uses
  this form.

V1 invocation:

```
hermes chat -q "<full prompt>" -Q \
  [-m provider/model] [--provider PROVIDER] \
  [-r SESSION_ID]                          # only on resume
  [--ignore-rules --ignore-user-config]    # opt-in via config flags
  [--accept-hooks --yolo]                  # headless safety
  [--source paperclip]                     # filter Paperclip sessions out of user lists
```

Prompt is delivered via the `-q` argv, since Hermes' `-q` accepts a single
string (no stdin bridge). For very long prompts we may later switch to a
prompt file + `<<heredoc`-style runner; for V1, argv is fine on macOS where
ARG_MAX is ~1MB.

The CLI prints to stdout:

```
session_id: 20260501_113118_b86354
<final assistant text>
```

Stderr carries log lines + diagnostics; we capture but only surface non-empty
stderr lines as fallback errors.

## 2. Output parsing

V1 parser logic (in `parse.ts`):

1. Split stdout on the first newline.
2. If line 1 starts with `session_id:` → extract id, remainder = response.
3. Otherwise: no session id captured, all stdout = response.
4. Strip a single trailing newline.

V1 does **not** parse tool calls or per-step usage from stdout. The Hermes
quiet output format does not emit them. Token / cost data is fetched
post-run via `hermes sessions export --session-id <id> -` (JSONL with one
session record).

## 3. Cost reporting

After the run completes successfully and we have a `sessionId`, we run:

```
hermes sessions export --session-id <id> -
```

This emits a single JSON line with fields:

- `input_tokens`
- `output_tokens`
- `cache_read_tokens`
- `cache_write_tokens`
- `reasoning_tokens`
- `estimated_cost_usd`
- `actual_cost_usd`
- `billing_provider`
- `model`

We read `input_tokens / output_tokens / cache_read_tokens` into the standard
`UsageSummary` and use `actual_cost_usd ?? estimated_cost_usd` as `costUsd`.
Provider/biller come from `billing_provider`.

If the session export fails (e.g. session DB busy), we degrade gracefully:
report no usage, no cost — the run still succeeds.

## 4. Model discovery

Hermes does not have a non-interactive `hermes model list` command — `hermes
model` is an OAuth/setup wizard. However, the agent caches a registry at
`~/.hermes/models_dev_cache.json` (~1.8MB JSON keyed by provider).

V1 discovery strategy (cheap fallback ladder):

1. **Env override**: if `PAPERCLIP_HERMES_MODELS` is set, parse as
   comma-separated `provider/model` ids.
2. **Built-in defaults**: a small static list shipped in `index.ts` covering
   the models Vardaan actively uses (sonnet/opus/haiku/grok via openrouter).
3. **(future)**: parse `~/.hermes/models_dev_cache.json` and surface every
   `<provider>/<model>` combination. Skipped in V1 because the file is
   1.8MB and yields ~3000+ models, which would overwhelm the UI dropdown.

Passing the model is straightforward: Hermes accepts both
`provider/model` (e.g. `anthropic/claude-sonnet-4.6`) and prefixed forms.
We pass the configured `config.model` directly via `-m`, optionally with
`--provider` if `config.provider` is set.

## 5. Auth / cred files

Hermes stores creds at:

- `~/.hermes/auth.json` — pooled credentials (Codex, Nous, etc.)
- `~/.hermes/.env` — API keys (OpenRouter, OpenAI, …)
- `~/.hermes/config.yaml` — model defaults, personality, hooks, etc.

For docker bind-mount we mount `~/.hermes` → `/paperclip/.hermes:rw`. The
`hermes` binary itself is a small Python venv launcher; we additionally
mount `/Users/vardaankoenig/.local/bin/hermes` →
`/usr/local/bin/hermes:ro` and rely on the host's Python interpreter
(installed inside the image) to execute the venv shim. (Note: V1 leaves
docker wiring as a follow-up — the adapter package is fully usable in
local-only mode without docker.)

## 6. Differences vs opencode-local

| Concern | opencode-local | hermes-local (V1) |
|---|---|---|
| Default cmd | `opencode` | `hermes` |
| Run subcommand | `run --format json` | `chat -q` (quiet) |
| Output format | JSONL (typed events) | plain text + `session_id:` prefix |
| Tool-call parsing | yes (step_finish, tool_use) | no — only final text |
| Cost in stdout | yes (per step_finish) | no — fetched via sessions export |
| Session resume | `--session <id>` | `-r <id>` |
| Skill injection | symlink into `~/.claude/skills` | not in V1 (Hermes uses its own skills) |
| Project-config guard | `OPENCODE_DISABLE_PROJECT_CONFIG=true` | `--ignore-rules` (opt-in) |
| Permission auto-allow | runtime config injection | `--accept-hooks --yolo` flags |

## 7. V1 scope

In:
- prompt → response one-shot
- session id capture + resume
- post-run cost via `sessions export`
- model + provider + extra-args config
- minimal model list (env override + static defaults)
- working-dir resolution + env passthrough

Out (deferred to V2):
- skill injection (Hermes has its own skill registry)
- streaming output / tool-call breakdown
- runtime config injection (analog to `prepareOpenCodeRuntimeConfig`)
- remote (SSH/sandbox) execution targets — V1 returns a clear error
- model auto-discovery from `models_dev_cache.json`
