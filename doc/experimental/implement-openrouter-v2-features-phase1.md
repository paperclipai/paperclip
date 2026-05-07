# Implementation Prompt: openrouter-local Features 1–4 (Phase 1)

**Repo:** `/Users/marc/Projects/paperclip`  
**Branch:** `feat/openrouter-local-adapter`  
**Adapter package:** `packages/adapters/openrouter-local/`

---

## Background and context

Before writing any code, read these documents in full:

1. `doc/experimental/OpenRouter-local v2 analysis.md` — overall context:
   architectural rationale, full adapter comparison table with row commentary,
   and engineering estimates for each feature. This is the primary context
   document for the work.
2. `doc/experimental/feature-dynamicmodels-spec.md` — Feature 1
3. `doc/experimental/wall-time-limit-spec.md` — Feature 2
4. `doc/experimental/reasoning-token-spec.md` — Feature 3
5. `doc/experimental/cost-tracking-spec.md` — Feature 4

Each spec is authoritative for its own feature. The analysis doc is context,
not a spec.

---

## Implementation order and conversation structure

Implement each feature in a **separate conversation** to minimise context window
pressure. The four conversations are:

| Conversation | Feature | Spec |
|---|---|---|
| A | Dynamic Model Selection | `feature-dynamicmodels-spec.md` |
| B | Wall-Clock Run Timeout | `wall-time-limit-spec.md` |
| C | Reasoning Token Support | `reasoning-token-spec.md` |
| D | USD Cost Tracking | `cost-tracking-spec.md` |
| E | Native Paperclip API Tools | `native-api-tools-spec.md` |

Each conversation must:
1. Read the relevant spec and the current state of any files it will modify.
2. Implement exactly what the spec says — no more, no less.
3. Run tests and confirm they pass before declaring done.
4. Commit on branch `feat/openrouter-local-adapter`.

Do not start conversation B until conversation A's commit is on the branch. Do
not start C until B is committed. Do not start D until C is committed. Do not
start E until D is committed. Each conversation starts by reading the latest
committed state of the files it will modify.

---

## Files by conversation

### Conversation A — Dynamic Model Selection

**Create:**
- `packages/adapters/openrouter-local/src/server/models.ts`
- `packages/adapters/openrouter-local/src/server/models.test.ts`

**Modify:**
- `packages/adapters/openrouter-local/src/server/index.ts` — wire `listModels`,
  `refreshModels`, `detectModel` into the `ServerAdapterModule` returned by
  `createServerAdapter()`
- `packages/adapters/openrouter-local/src/server/execute.ts` — model resolution:
  `config.model` → `OPENROUTER_MODEL` env → `DEFAULT_OPENROUTER_LOCAL_MODEL`
- `packages/adapters/openrouter-local/src/index.ts` — document `OPENROUTER_MODEL`
  env var in `agentConfigurationDoc`

### Conversation B — Wall-Clock Run Timeout

**Modify:**
- `packages/adapters/openrouter-local/src/server/execute.ts` — `isAbortError()`
  helper, `AbortController` creation and scheduling, `signal` forwarded to
  `chat.completions.create()`, `signal` in `toolCtx`, abort catch block,
  `timeoutSec` config documented in `agentConfigurationDoc`
- `packages/adapters/openrouter-local/src/server/tools.ts` — `signal?: AbortSignal`
  on `ToolContext`, `signal` parameter on `runShellCommand()`, abort listener
  registration and cleanup in `runShellCommand()`, `dispatchToolCall` passes
  `ctx.signal` through

**Extend:**
- `packages/adapters/openrouter-local/src/server/execute.test.ts`
- `packages/adapters/openrouter-local/src/server/tools.test.ts`

### Conversation C — Reasoning Token Support

**Modify:**
- `packages/adapters/openrouter-local/src/server/execute.ts` —
  `extractReasoningText()` helper, `resolveReasoningParam()` helper, emit
  `kind: "thinking"` before `kind: "assistant"` when reasoning content present,
  `reasoning` param forwarded to `chat.completions.create()` when
  `config.reasoning` is set, `reasoning` config field documented in
  `agentConfigurationDoc`

**Extend:**
- `packages/adapters/openrouter-local/src/server/execute.test.ts`

### Conversation D — USD Cost Tracking

**Modify:**
- `packages/adapters/openrouter-local/src/server/execute.ts` —
  `fetchGenerationCost()` module-level unexported helper, `generationIds: string[]`
  and `costUsd: number` added to `RunState` (initialised to `[]` and `0`),
  `completion.id` pushed inside the loop, post-loop fetch block (800ms delay,
  `Promise.all`, sum `total_cost`, override `state.provider` from
  `provider_name`), replace hardcoded `costUsd: 0` with `costUsd: state.costUsd`

**Extend:**
- `packages/adapters/openrouter-local/src/server/execute.test.ts`

### Conversation E — Native Paperclip API Tools

**Create:**
- `packages/adapters/openrouter-local/src/server/paperclip-api.ts` — `PaperclipApi` HTTP client and `PaperclipApiError`
- `packages/adapters/openrouter-local/src/server/paperclip-tools.ts` — `buildPaperclipTools()` and all 9 tool definitions
- `packages/adapters/openrouter-local/src/server/paperclip-tools.test.ts`

**Modify:**
- `packages/adapters/openrouter-local/src/server/tools.ts` — extend `ToolContext` with optional `paperclipApi`, `agentId`, `companyId`, `currentIssueId`, `autoApprove` fields
- `packages/adapters/openrouter-local/src/server/execute.ts` — `resolveCurrentIssueId()`, `PaperclipApi` construction, issue checkout lifecycle, `buildPaperclipTools()` merged into `allTools`
- `packages/adapters/openrouter-local/src/server/execute.test.ts` — add checkout success, checkout 409, and no-authToken tests
- `packages/adapters/openrouter-local/src/index.ts` — document `autoApprove` in `agentConfigurationDoc`

---

## Current execute.ts state (as of conversation A start)

Do not infer from git history — trust this summary. Each subsequent conversation
should read the file from disk rather than trusting this snapshot, since prior
conversations will have modified it.

- `resolveCwd(configCwd)` resolves `config.cwd` → `PAPERCLIP_WORKSPACE_PATH`
  env → `process.cwd()`
- `model = asString(config.model, DEFAULT_OPENROUTER_LOCAL_MODEL)` — no
  `OPENROUTER_MODEL` env fallback yet
- `toolCtx: ToolContext = { cwd, runCommandTimeoutSec }` — no `signal` field yet
- `costUsd: 0` hardcoded in `kind: "result"` emit
- `state.provider` sourced only from the completion object's `provider` field
- No `AbortController`, no reasoning extraction, no generation ID accumulation

---

## Tests

Run after each feature with:

```
cd packages/adapters/openrouter-local && npm test
```

All tests must pass before committing. Implement every numbered test case listed
in the spec's "Tests" section — these are not suggestions.

---

## Commit requirements

Each feature gets its own commit on `feat/openrouter-local-adapter`. Format:

```
openrouter-local: <short description>

<one sentence explaining what the feature does and why>
```

Examples:

```
openrouter-local: add dynamic model listing via OpenRouter /models API

Replaces the static 7-model list with a live filtered list tagged with capability flags; adds OPENROUTER_MODEL env var detection.
```

```
openrouter-local: add wall-clock run timeout via AbortController

Bounds total execute() duration with timeoutSec config; aborts in-flight OpenAI requests and SIGTERMs run_command subprocesses on expiry.
```

```
openrouter-local: extract and emit reasoning tokens as kind: "thinking" entries

Surfaces chain-of-thought from message.reasoning and message.reasoning_details for reasoning models (DeepSeek R1, QwQ, Claude extended thinking).
```

```
openrouter-local: fetch actual USD cost from OpenRouter /generation endpoint

Replaces hardcoded costUsd: 0 with summed total_cost across all tool loop iterations; also improves provider attribution via provider_name.
```

```
openrouter-local: add native Paperclip API tools

Adds typed get_issue, update_issue_status, add_comment, list_comments, create_sub_issue, list_issues, list_agents, hire_agent, and request_approval tools; issue checkout lifecycle; hire_agent approval gating via createApproval.
```

---

## Deployment to linkcast for end-to-end testing

After all four feature commits are on `feat/openrouter-local-adapter`, the user
will cherry-pick them onto `linkcast/main` for end-to-end testing in the running
Paperclip instance.

**Step 1 — identify the four commits:**
```bash
git log --oneline feat/openrouter-local-adapter
# Copy the four SHAs for the feature commits
```

**Step 2 — cherry-pick onto linkcast/main:**
```bash
git checkout linkcast/main
git cherry-pick <sha-feature-1> <sha-feature-2> <sha-feature-3> <sha-feature-4>
# Resolve any conflicts (unlikely — changes are confined to packages/adapters/openrouter-local/)
```

**Step 3 — push and rebuild:**
```bash
git push linkcast main
docker compose build && docker compose up -d
# (or the project's standard rebuild command)
```

**Step 4 — verify in the Paperclip UI:**
- Model picker shows the dynamic list with capability tags (`[free]`,
  `[thinking]`, `[vision]`, etc.)
- A run with a reasoning model (e.g. `deepseek/deepseek-r1`) shows
  `kind: "thinking"` entries in the transcript
- Run cost shows a non-zero USD value in the run result for an OpenRouter-routed
  model
- A run that exceeds `timeoutSec` returns cleanly with `timedOut: true` rather
  than hanging

---

## Done criteria (all four features)

1. `listModels()` returns a live filtered list from OpenRouter `/models`, with
   capability tags, free models first, non-OpenRouter sentinel fallback.
2. `refreshModels()` clears the module-level cache.
3. `detectModel()` returns `{ model, provider: "openrouter", source: "env_OPENROUTER_MODEL" }`
   when `OPENROUTER_MODEL` is set, or `null`.
4. Model resolution in `execute()` is: `config.model` → `OPENROUTER_MODEL` env
   → `DEFAULT_OPENROUTER_LOCAL_MODEL`.
5. `execute()` returns `{ timedOut: true, errorCode: "timeout" }` when
   `timeoutSec` is exceeded.
6. In-flight OpenAI HTTP request is aborted via `AbortController` signal on
   timeout.
7. In-flight `run_command` subprocess receives SIGTERM when signal fires.
8. Runs without `timeoutSec` behave identically to before.
9. Reasoning content from `message.reasoning` (string) is emitted as
   `kind: "thinking"` before `kind: "assistant"`.
10. Reasoning content from `message.reasoning_details` is extracted; entries
    with type `reasoning.encrypted` are ignored; `reasoning_details` takes
    precedence over the `reasoning` string when both are present.
11. `config.reasoning: true` → `{ enabled: true }` in completions call; object
    value forwarded verbatim; absent → no `reasoning` key in request.
12. `costUsd` in `kind: "result"` reflects actual OpenRouter spend summed across
    all tool loop iterations.
13. `state.provider` is populated from generation `provider_name` when available,
    overriding the completion object's `provider` field.
14. Non-OpenRouter endpoints: `costUsd` stays `0`, generation endpoint never
    called.
15. All generation fetch failures degrade gracefully to `costUsd: 0`; run
    completes normally.
16. All tests pass after each feature commit.
17. `PaperclipApi` client in place with all methods from the spec.
18. All 9 Paperclip tools defined and dispatching correctly against a mock API.
19. `hire_agent` with `autoApprove: false` calls `createApproval`, not `hireAgent`.
20. `hire_agent` with `autoApprove: true` calls `hireAgent` directly.
21. Checkout lifecycle runs before the tool loop when issue context is present; 409 returns `errorCode: "issue_locked"`.
22. No auth token → no checkout attempted, no Paperclip tools in tool list.
23. `autoApprove` documented in `agentConfigurationDoc`.
24. Existing filesystem tool tests unaffected.
