# @paperclipai/adapter-openrouter

**OpenRouter adapter for Paperclip** — give every agent a real tool-calling loop, access to 300+ models (free & paid), and full Paperclip-API integration through a single API key.

> If it can receive a heartbeat, it's hired. Now it can think with *any* model — and actually *do* things.

[![Status: Verified working end-to-end](https://img.shields.io/badge/status-verified%20working-brightgreen)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)]()
[![Built for Paperclip](https://img.shields.io/badge/built%20for-Paperclip-8b5cf6)]()

---

## What This Does

Connects Paperclip agents to [OpenRouter](https://openrouter.ai) with a complete agent runtime built directly into the adapter — no CLI subprocess, no wrapper, no missing capabilities.

### Agent capabilities

- **Multi-turn tool-calling loop** — model calls tools, adapter executes them, results feed back, loop continues until the model is done or `maxTurns` is hit
- **Built-in Paperclip API tools** — 8 tools wired to Paperclip's REST API so agents can read issues, post comments, update status, create sub-issues, hire teammates, and request approvals
- **Auto issue state management** — issues move to `in_progress` when work starts and `done` / `blocked` when it finishes
- **Final output posted as a comment** — every run leaves a comment on the issue so other agents and humans can see the result
- **Smart issue checkout** — automatically detects when Paperclip's heartbeat already pre-locked the issue and skips redundant API calls
- **Skill loading** — drops `SKILL.md` files into the agent's system prompt at runtime
- **Reasoning support** — DeepSeek R1, QwQ, and other thinking models emit `thinking` transcript entries separately from the final answer
- **Approval gating** — `hire_agent` and other mutating tools route through Paperclip's approval system by default (override with `autoApprove: true`)
- **Repeat-call loop break** — detects when a model gets stuck calling the same tool with the same args and breaks the loop with a clear error

### Model access

- **300+ models** from OpenAI, Anthropic, Google, Meta, Mistral, DeepSeek, Qwen, and more
- **50+ free models** — Llama 4 Maverick, Gemma 3, DeepSeek V3, Qwen3 235B, gpt-oss-120b, etc.
- **Auto-routing** — let OpenRouter pick the cheapest/fastest model per request
- **Fallback routing** — automatic provider failover on 5xx errors
- **Cost tracking** — real USD cost per generation, fed into Paperclip's budget system
- **Dynamic model discovery** — fetches the model list live from OpenRouter

---

## Verified Working

This adapter has been tested end-to-end against a real running Paperclip instance with a real CEO agent on the PanicButton company. Every tool in the suite has been exercised in production runs:

| Run | Issue | Tools fired | Outcome |
|---|---|---|---|
| **CRE-4** | Status report and delegation | `list_issues`, `get_issue`, `add_comment`, `create_sub_issue` ×3, `update_issue_status` | ✅ Status report posted, 3 sub-issues created (CRE-5/6/7), parent moved to in_progress |
| **CRE-15** | Hire flow | `get_issue`, `hire_agent`, `add_comment` | ✅ Approval row created in Paperclip, rendered in UI Approvals panel, human approved, **agent "Bob" materialized in org chart** |
| **CRE-16** | Comment + status | `get_issue`, `add_comment`, `update_issue_status` | ✅ Comment landed, status moved to done |
| **CRE-25** | Final clean run | `get_issue`, `add_comment`, `update_issue_status` | ✅ Six tool calls, zero warnings, $0.0035 cost, ~10s end to end |

**Tested models:**
- ✅ `openai/gpt-4o-mini` — best-in-class function calling, ~$0.003 per multi-tool run
- ✅ `openai/gpt-oss-120b:free` — reliable function calling, free tier
- ⚠️ `stepfun/step-3.5-flash:free` — fakes tool calls as XML text, **not recommended** (model issue, not adapter)

---

## Quick Start

### 1. Get an OpenRouter API Key

Go to <https://openrouter.ai/keys> and create a key. Free models work with $0 balance, but OpenRouter caps free-tier accounts at 50 requests per day total. Adding $5 in credits unlocks 1000 free-model requests/day and also lets you use paid models.

### 2. Enable the adapter (built-in)

The adapter ships in-repo as `@paperclipai/adapter-openrouter`. Enable it from your Paperclip repo root:

```bash
pnpm install
pnpm -r build
```

### 3. Apply registry wiring

You need to register the adapter in 3 places:

- `server/src/adapters/registry.ts` — add `openrouterAdapter` with `supportsLocalAgentJwt: true`
- `server/src/adapters/builtin-adapter-types.ts` — add `"openrouter"` to the type union
- `ui/src/adapters/registry.ts` + `ui/src/adapters/adapter-display-registry.ts` — register the UI side

See `REGISTRY_PATCHES.md` for the exact diffs. Then:
```bash
cd ../../..   # back to paperclip root
pnpm install
pnpm -r build
```

### 4. Set credentials

Three environment variables are required:
```bash
# Your OpenRouter API key (sk-or-v1-...)
export OPENROUTER_API_KEY="sk-or-v1-your-key-here"

# Required for Paperclip to mint agent JWTs that the adapter uses
# to call Paperclip's own API. Any random 32-byte hex string works.
export PAPERCLIP_AGENT_JWT_SECRET="$(openssl rand -hex 32)"

# Where the adapter should reach Paperclip's API. Default is correct
# for local dev.
export PAPERCLIP_API_URL="http://localhost:3100"
```

Persist them in `~/.bashrc` or `.paperclip/.env`.

### 5. Hire an agent

In the Paperclip UI → Org Chart → Hire Agent:

1. **Adapter Type**: OpenRouter
2. **Model**: any OpenRouter model id, e.g. `openai/gpt-4o-mini` (recommended for tools) or `openai/gpt-oss-120b:free`
3. **Test Environment**: validates your key and lists available models

Then create an issue and assign it to the new agent. Watch the live run view — you'll see structured `tool_call` and `tool_result` entries as the model works.

---

## Architecture
packages/adapters/openrouter/
├── package.json
├── README.md
├── REGISTRY_PATCHES.md
└── src/
├── index.ts                 # Root metadata, types, OpenRouter constants
├── server/
│   ├── index.ts             # Server barrel — execute, sessionCodec, detectModel, listSkills, syncSkills
│   ├── execute.ts           # Multi-turn tool loop, issue state mgmt, cost tracking, repeat-call protection
│   ├── paperclip-api.ts     # HTTP client for Paperclip's REST API (auth via ctx.authToken JWT)
│   ├── tools.ts             # 8 OpenAI-format tool definitions + handlers
│   ├── transcript.ts        # Typed TranscriptEntry emitters (init, assistant, thinking, tool_call, tool_result, result)
│   ├── skills.ts            # Filesystem-based SKILL.md loader
│   └── test.ts              # Environment diagnostics + dynamic model fetch
├── ui/
│   ├── index.ts
│   ├── parse-stdout.ts      # Stdout JSON lines → TranscriptEntry[]
│   └── build-config.ts      # Form values → adapterConfig JSON
└── cli/
├── index.ts
└── format-event.ts      # Terminal pretty-print for paperclipai run --watch

### How a run works

1. Paperclip's heartbeat dispatcher wakes the agent and calls `execute(ctx)`
2. Adapter loads skills from disk and prepends them to the system prompt
3. Adapter renders Paperclip's wake payload as the user message
4. If `ctx.authToken` is present, adapter constructs a `PaperclipApi` client and the 8 tool handlers
5. **Issue lock acquisition** — adapter checks if Paperclip's heartbeat already stamped the issue's `executionRunId` to this run; if yes, skip checkout, otherwise call `POST /api/issues/:id/checkout`
6. Issue is moved to `in_progress`
7. Tool loop runs:
   - Call OpenRouter `chat/completions` with `tools` array
   - Model returns either text (done) or tool calls
   - Each tool call is executed against Paperclip's API
   - Results are fed back as `role: "tool"` messages
   - Loop until no more tool calls, `maxTurns` is hit, or repeat-call protection trips
8. Final assistant text is posted as a comment on the issue
9. Issue is moved to `done` (success), `blocked` (max_turns / error / repeat loop)
10. Adapter fetches the OpenRouter generation cost and returns the full result with usage + costUsd

### Built-in tools

| Tool | What it does |
|---|---|
| `get_issue` | Fetch full details of an issue (title, description, status, comments) |
| `update_issue_status` | Move an issue to backlog / todo / in_progress / blocked / done / cancelled |
| `add_comment` | Post a comment on an issue (markdown body) |
| `list_comments` | List all comments on an issue |
| `create_sub_issue` | Create a child issue, optionally assigned to a teammate |
| `list_issues` | List company issues, filterable by status / assignee |
| `hire_agent` | Hire a new agent (routes through approval by default) |
| `request_approval` | Open a generic approval request for any human-gated action |

All tools call Paperclip's REST API authenticated as the agent (via `ctx.authToken`), so every action is attributed correctly in the audit log.

---

## Configuration Reference

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | `openrouter/auto` | OpenRouter model id. Use `:free` suffix for free tier. |
| `apiKey` | string | env var | Your OpenRouter API key (`sk-or-v1-...`) |
| `systemPrompt` | string | sensible default | System message prepended to all requests |
| `temperature` | number | `0.7` | Sampling temperature (0–2) |
| `maxTokens` | number | `4096` | Max completion tokens per turn |
| `topP` | number | `1` | Nucleus sampling threshold |
| `reasoning` | boolean | `false` | Enable extended thinking (model must support it) |
| `transforms` | string[] | — | OpenRouter transforms, e.g. `["middle-out"]` |
| `route` | string | `fallback` | `"fallback"` or `"no-fallback"` |
| `httpReferer` | string | `https://paperclip.ing` | App URL for OpenRouter leaderboards |
| `xTitle` | string | `Paperclip` | App name for OpenRouter leaderboards |
| `maxTurns` | number | `25` | Max tool-loop turns per run |
| `autoApprove` | boolean | `false` | Skip approval gates for `hire_agent` and similar mutating tools |
| `skillsDir` | string | `~/.openrouter-adapter/skills` | Override path to skills directory |

---

## Example Configs

### Production-grade CEO on a paid model
```json
{
  "name": "ceo",
  "adapterType": "openrouter",
  "adapterConfig": {
    "model": "openai/gpt-4o-mini",
    "temperature": 0.3,
    "maxTokens": 4096,
    "maxTurns": 30,
    "systemPrompt": "You are the CEO. Define strategy, delegate, and ship."
  }
}
```

### Free-tier agent on gpt-oss-120b
```json
{
  "name": "researcher",
  "adapterType": "openrouter",
  "adapterConfig": {
    "model": "openai/gpt-oss-120b:free",
    "temperature": 0.7,
    "maxTurns": 20
  }
}
```

### Frontier coding agent
```json
{
  "name": "senior-engineer",
  "adapterType": "openrouter",
  "adapterConfig": {
    "model": "anthropic/claude-sonnet-4-6",
    "temperature": 0.0,
    "maxTokens": 16384,
    "maxTurns": 50,
    "route": "fallback"
  }
}
```

### Reasoning agent with auto-routing
```json
{
  "name": "strategist",
  "adapterType": "openrouter",
  "adapterConfig": {
    "model": "openrouter/auto",
    "reasoning": true,
    "transforms": ["middle-out"]
  }
}
```

---

## Cost Tracking

After each completion the adapter queries OpenRouter's `/api/v1/generation` endpoint to get the real USD cost and accurate token counts, then returns them in `AdapterExecutionResult`. Paperclip deducts this from the agent's monthly budget. At 80% utilization → soft warning; at 100% → agent auto-pauses.

Free models report `$0.00` and don't eat into your budget.

---

## Skills

Drop a directory containing a `SKILL.md` into the skills root and the adapter loads it into the system prompt at runtime:
~/.openrouter-adapter/skills/
├── customer-research/
│   └── SKILL.md
└── crypto-security/
└── SKILL.md

Override the root with `adapterConfig.skillsDir` per-agent or `PAPERCLIP_SKILLS_DIR` env var.

> v1 loads every skill in the root. Per-agent skill selection (matching Paperclip's "desired skills" registry) is planned for v3.

---

## How It Differs From Other Adapters

| Feature | claude-local / codex-local | openrouter (this adapter) |
|---|---|---|
| Execution | Spawns local CLI subprocess | Pure HTTP, in-process tool loop |
| Tool loop | Handled by the CLI binary | Implemented in TypeScript inside the adapter |
| Models | Single provider | 300+ across all providers |
| Free models | ❌ | ✅ (50+) |
| Auto-routing | ❌ | ✅ |
| Local install | Requires CLI binary | Zero install — just Node 18+ |
| Cost tracking | Native token counting | OpenRouter Generation API |
| Paperclip API tools | Provided by the CLI's MCP support | Built into the adapter |
| Run lock acquisition | Via heartbeat pre-checkout | Heartbeat pre-checkout + adapter fallback |

---

## Known Limitations

The adapter is verified working end-to-end, but there are some real-world rough edges you should be aware of:

### Model-specific quirks

- **Free models silently rate-limit.** OpenRouter caps free-tier accounts at **50 requests per day total** across all free models. Heavy testing will exhaust this quickly. Adding $5 in credits unlocks 1000/day. The error is a clear 429 with `Rate limit exceeded: free-models-per-day`.
- **Some free models fake tool calls.** `stepfun/step-3.5-flash:free` is trained on a different tool format and emits `<tool_call>...</tool_call>` as literal text instead of structured `tool_calls` arrays. The adapter cannot recover from this — it's a model issue. Use `openai/gpt-oss-120b:free` or `openai/gpt-4o-mini` instead.
- **Reasoning model token counts vary.** DeepSeek R1 and QwQ emit reasoning tokens that don't always show up in OpenRouter's usage report. Cost tracking falls back to the `/generation` endpoint for accuracy.

### Adapter-specific limitations (deferred to v3)

- **No token streaming inside the tool loop.** v1 is non-streaming throughout for reliability — most free models stream tool calls poorly. Streaming is planned for v3.
- **No async approval-callback resume.** When `hire_agent` creates an approval, the run completes; it does not pause and wait for the human decision. The approval is processed when the agent next wakes.
- **No multimodal / vision attachment handling.** Issues with image attachments are passed as text descriptions only. Vision support is planned for v3.
- **No per-agent desired-skill filtering.** v1 loads every skill in the root directory. Per-agent skill selection (matching Paperclip's skill registry) is planned for v3.
- **No per-model capability detection.** The adapter sends `tools` to every model. Models that don't support function calling will fail or hallucinate. v3 will probe model capabilities and skip the `tools` array when unsupported.
- **Repeat-call detection is conservative.** The adapter breaks the loop after 3 identical consecutive calls. This protects against runaway loops but may also fire on legitimate retries — adjust `maxTurns` if needed.

### Paperclip integration notes

- **Paperclip core needs `supportsLocalAgentJwt: true`** on the openrouter adapter entry in `server/src/adapters/registry.ts`. Without this, `ctx.authToken` will be `undefined` and tool calls will be disabled. See `REGISTRY_PATCHES.md`.
- **Three env vars are required**, not just the API key. `OPENROUTER_API_KEY`, `PAPERCLIP_AGENT_JWT_SECRET`, and `PAPERCLIP_API_URL` must all be set in the same shell that runs `pnpm dev:server`.
- **Issue checkout has been observed to "fail" cosmetically** when `expectedStatuses` doesn't include the issue's current status. The adapter's default list (`backlog`, `todo`, `in_progress`, `in_review`, `blocked`) covers all pre-terminal statuses. If Paperclip ever adds new ones, update `paperclip-api.ts`.

---

## Roadmap

### v1 — MVP (one-shot, no tools)
- Basic OpenRouter integration ✅
- Streaming text generation ✅
- Cost tracking ✅

### v2 — Current release ✅
- Multi-turn tool loop ✅
- 8 built-in Paperclip API tools ✅
- Issue state management ✅
- Issue checkout with smart pre-lock detection ✅
- Final-output-as-comment ✅
- Skill loading ✅
- Reasoning support ✅
- `sessionCodec`, `detectModel`, `listSkills`, `syncSkills` ✅
- Cost tracking via Generation API ✅
- Repeat-call loop break ✅
- Approval gating for `hire_agent` and friends ✅
- **End-to-end verified against live Paperclip** ✅

### v3 — Planned
- Token streaming inside the tool loop
- Async approval-callback resume (pause run → wait → continue)
- Per-agent desired-skill filtering (integrate with Paperclip's skill registry)
- Multimodal attachment support (vision models)
- Per-model capability detection (skip `tools` for models that can't handle them)
- Per-model rate-limit backoff for free tier
- `getQuotaWindows` integration with OpenRouter `/key`
- Compaction strategy for long conversations

---

## Contributing

PRs welcome. The adapter lives in-repo at `packages/adapters/openrouter` of the Paperclip repository:
```bash
cd packages/adapters/openrouter
pnpm install
pnpm typecheck
pnpm build
```

Run the test suite (when one exists):
```bash
pnpm test
```

To test against a live Paperclip instance, enable the built-in adapter in your Paperclip checkout, then trigger a run.

---

## License

MIT — same as Paperclip.
