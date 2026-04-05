# Agent Runtime Guide

Status: User-facing guide  
Last updated: 2026-04-03  
Audience: Operators setting up and running agents in Paperclip

## 1. What this system does

Agents in Paperclip do not run continuously.  
They run in **heartbeats**: short execution windows triggered by a wakeup.

Each heartbeat:

1. Starts the configured agent adapter (for example, Claude CLI or Codex CLI)
2. Gives it the current prompt/context
3. Lets it work until it exits, times out, or is cancelled
4. Stores results (status, token usage, errors, logs)
5. Updates the UI live

## 2. When an agent wakes up

An agent can be woken up in four ways:

- `timer`: scheduled interval (for example every 5 minutes)
- `assignment`: when work is assigned/checked out to that agent
- `on_demand`: manual wakeup (button/API)
- `automation`: system-triggered wakeup for future automations

If an agent is already running, new wakeups are merged (coalesced) instead of launching duplicate runs.

**Timer wakeups and `cwd`:** Interval heartbeats often have **no active issue**, so the server may otherwise resolve the shell `cwd` to the agent home under `~/.paperclip/.../workspaces/<agent>`. If the agent should still run in your main repo checkout (typical for a **Revisor** or **Coordenador** that shares the project primary workspace on assignments), set **`adapterConfig.cwd`** to the **absolute path** of that directory. When no project/issue workspace is available, Paperclip uses that path so timer runs match assignment-driven runs.

## 3. What to configure per agent

## 3.1 Adapter choice

Common choices:

- `claude_local`: runs your local `claude` CLI
- `codex_local`: runs your local `codex` CLI
- `process`: generic shell command adapter
- `http`: calls an external HTTP endpoint

For `claude_local` and `codex_local`, Paperclip assumes the CLI is already installed and authenticated on the host machine.

## 3.2 Runtime behavior

Managed instruction bundles refer to the agent’s personal directory as `$AGENT_HOME/…` in Markdown. Local CLI adapters substitute that token with the **absolute** Paperclip workspace path in the prompt they send to the tool, so the model does not try to open a literal folder named `$AGENT_HOME` under the git worktree.

In agent runtime settings, configure heartbeat policy:

- `enabled`: allow scheduled heartbeats

**`adapterConfig.timeoutSec` (local CLI adapters):** If set to **0** or omitted, Paperclip applies a **default of 3600 seconds (1 hour)** per child process so timer or long prompts cannot hold the agent queue open without bound. Set a **positive** number to use your own cap; use a **larger** value (for example 7200) for legitimately long jobs.
- `intervalSec`: timer interval (0 = disabled)
- `wakeOnAssignment`: wake when assigned work
- `wakeOnOnDemand`: allow ping-style on-demand wakeups
- `wakeOnAutomation`: allow system automation wakeups

## 3.3 Working directory and execution limits

For local adapters, set:

- `cwd` (working directory)
- `timeoutSec` (max runtime per heartbeat; when `0` or omitted, adapters use the repo default wall-clock cap — currently **2 hours** — see `@paperclipai/adapter-utils` `DEFAULT_HEARTBEAT_CHILD_TIMEOUT_SEC`)
- `graceSec` (time before force-kill after timeout/cancel)
- optional env vars and extra CLI args
- use **Test environment** in agent configuration to run adapter-specific diagnostics before saving

## 3.4 Managed agents → OpenCode + free preset (default rollout)

For the usual Portuguese-named roles (*Claudio*, *Coordenador*, *Triagem*, *Segurança*, *Revisor*, *CEO*), repo scripts target **`opencode_local`** with a **Minimax M2.5 (free)** model by default (`opencode/minimax-m2.5-free`). Confirm with `opencode models` on the host (available ids differ by OpenCode version). To use **Qwen**, **Nemotron**, **GPT‑5 Nano**, etc., set `PAPERCLIP_OPENCODE_QUOTA_FALLBACK_MODEL` (for example `opencode/qwen3.6-plus-free` or `openrouter/...`).

Rollout scripts only patch **name-matched** roles unless you pass **`--all-agents`**, which updates **every** non-terminated `codex_local` / `opencode_local` agent in the company.

Only agents whose `adapterType` is **`codex_local`** or **`opencode_local`** are matched by rollouts (other adapters are left alone).

If `adapterConfig.command` was an absolute path to the Codex binary (for example macOS `…/Codex.app/…/codex`), the rollout rewrites it to **`opencode`** so PATCH validation and heartbeats invoke the OpenCode CLI, not `codex models`.

```sh
export PAPERCLIP_COMPANY_ID="<company-uuid>"
pnpm rollout:codex-presets -- --apply                 # managed roles only (Claudio, Coordenador, …)
pnpm rollout:codex-presets -- --apply --all-agents   # every opencode_local / codex_local agent
pnpm rollout:opencode-from-codex-quota -- --apply      # same as first line (alias entrypoint)
```

Use **Test environment** after each change. Configure OpenRouter (or your provider) for OpenCode before applying.

The `opencode_local` adapter sets `OPENCODE_PERMISSION` with `external_directory: "allow"` (global allow per OpenCode v2) so non-interactive heartbeats do not hit `external_directory (...); auto-rejecting` when the CLI would otherwise prompt in a TTY.
If a **resumed** session still hits permission auto-reject, Paperclip retries the same heartbeat **once** without session resume (fresh OpenCode session), similar to unknown-session recovery.

## 3.4b Codex (`codex_local`) — optional manual tuning

If you keep agents on Codex instead of the managed OpenCode rollout, set `adapterConfig.model` and `adapterConfig.modelReasoningEffort` explicitly so runs do not rely only on global `config.toml`.

### Audit latest runs vs managed preset

`GET /api/companies/:id/heartbeat-runs` stores `usageJson.model`. Compare to config and the managed target model (`DEFAULT_OPENCODE_QUOTA_FALLBACK_MODEL` or env override):

```sh
export PAPERCLIP_COMPANY_ID="<company-uuid>"
pnpm audit:agent-models                           # dry-run table
pnpm audit:agent-models -- --apply-nemotron       # PATCH managed roles only (flag name is legacy)
pnpm audit:agent-models -- --apply-all            # PATCH all opencode_local / codex_local in company
# --apply-codex / --apply-opencode are deprecated aliases for --apply-nemotron
```

Optional: `RUNS_LIMIT=600` to scan more rows.

**Broader run health (status / `error_code` / stuck `running`):** `pnpm audit:heartbeat-runs` with the same `PAPERCLIP_COMPANY_ID` (and optional `PAPERCLIP_TOKEN`). See `doc/plans/2026-04-03-heartbeat-runs-sampling-and-triage.md` for SQL templates and P0/P1 triage.

The Costs UI may still show a Codex quota hint (≥75% used) pointing at the same fallback model string as `CodexSubscriptionPanel`.

## 3.5 Prompt templates

You can set:

- `promptTemplate`: used for every run (first run and resumed sessions)

Templates support variables like `{{agent.id}}`, `{{agent.name}}`, and run context values.

Managed default instruction bundles also carry contributor-policy defaults. In the current bootstrap set, agents are instructed to document every code change before handoff by checking the repo's existing `docs/`, `doc/`, `README`, `CHANGELOG`, and `AGENTS.md` files and updating the most specific matching document for the area they changed.

## 4. Session resume behavior

Paperclip stores session IDs for resumable adapters.

- Most adapters reuse the last saved session on the next heartbeat for continuity.
- For **`codex_local`**, heartbeats **without** an issue/task id in the run context **do not** resume the last thread stored on `agent_runtime_state`, so idle timer wakeups are less likely to replay a huge Codex session. Runs with a task/issue id still resume via per-task session rows as before.
- You can reset a session if context gets stale or confused.

Use session reset when:

- you significantly changed prompt strategy
- the agent is stuck in a bad loop
- you want a clean restart

## 5. Logs, status, and run history

For each heartbeat run you get:

- run status (`queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`)
- error text and stderr/stdout excerpts
- token usage/cost when available from the adapter
- full logs (stored outside core run rows, optimized for large output)

In local/dev setups, full logs are stored on disk under the configured run-log path.

## 6. Live updates in the UI

Paperclip pushes runtime/activity updates to the browser in real time.

You should see live changes for:

- agent status
- heartbeat run status
- task/activity updates caused by agent work
- dashboard/cost/activity panels as relevant

If the connection drops, the UI reconnects automatically.

## 7. Common operating patterns

## 7.0 Technical review pipeline (multi-agent)

When issues use **`handoff_ready` → automatic review dispatch**, ensure exactly one agent matches the configured reviewer reference: company **`technicalReviewerReference`** (board PATCH), else env **`PAPERCLIP_TECHNICAL_REVIEWER_REFERENCE`**, else default **`revisor-pr`**. Pipeline agents need **wake on demand / assignment** enabled so system wakes succeed. Free-text review outcomes should follow the phrases in [`doc/plans/2026-04-05-review-outcome-classification-matrix.md`](../doc/plans/2026-04-05-review-outcome-classification-matrix.md) (or the `### Blocking findings` section pattern) so parent issues reconcile automatically.

## 7.1 Simple autonomous loop

1. Enable timer wakeups (for example every 300s)
2. Keep assignment wakeups on
3. Use a focused prompt template
4. Watch run logs and adjust prompt/config over time

## 7.2 Event-driven loop (less constant polling)

1. Disable timer or set a long interval
2. Keep wake-on-assignment enabled
3. Use on-demand wakeups for manual nudges

## 7.3 Safety-first loop

1. Short timeout
2. Conservative prompt
3. Monitor errors + cancel quickly when needed
4. Reset sessions when drift appears

## 8. Troubleshooting

**“Stale” / missed heartbeats on long runs:** `lastHeartbeatAt` on the agent row updates when a heartbeat **finishes**, not while OpenCode/Codex/Claude is still working. The health monitor therefore ignores **heartbeat-stalled** alerts whenever that agent already has a `heartbeat_runs` row in **`running`** (active work). If you still see confusion, confirm the run is really `running` in the UI and check the run log for progress.

If runs fail repeatedly:

1. Check adapter command availability (`claude`/`codex` installed and logged in).
2. Verify `cwd` exists and is accessible.
3. Inspect run error + stderr excerpt, then full log.
4. Confirm timeout is not too low.
5. Reset session and retry.
6. Pause agent if it is causing repeated bad updates.

Typical failure causes:

- CLI not installed/authenticated
- bad working directory
- malformed adapter args/env
- prompt too broad or missing constraints
- process timeout

**OpenCode (`opencode_local`) — identical patch error:** If the run error is `No changes to apply: oldString and newString are identical`, the model tried an edit where the “before” and “after” text are the same (often the file was already updated, or `oldString` did not match the file). Fix by resetting session (`forceFreshSession` on manual invoke), tightening prompts/skills so the agent **reads** the file before patching, and avoiding duplicate apply steps. Large input token counts on a single run usually mean an oversized session context — prefer a fresh session or narrower files-in-context.

**OpenCode — read-before-write:** If the error says `You must read file … before overwriting it` / `Use the Read tool first`, the model called an edit tool on a path it had not read in that session. Retry with a fresh session if needed, and ensure the agent workflow always **reads each file once before editing it**. Also confirm `cwd` and edited paths align with the **issue’s configured execution workspace** so the agent does not drift into an unrelated worktree.

**OpenCode — file changed after read:** If the error says a file `has been modified since it was last read` (often `memory/YYYY-MM-DD.md` when another heartbeat or process wrote it between read and save), the Paperclip adapter **retries the run once** without resuming the saved session so OpenCode re-reads the file. Persistent failures surface as `opencode_stale_workspace_file`. Reduce overlap by avoiding parallel runs on the same agent home when possible.

Claude-specific note:

- If `ANTHROPIC_API_KEY` is set in adapter env or host environment, Claude uses API-key auth instead of subscription login. Paperclip surfaces this as a warning in environment tests, not a hard error.

## 9. Security and risk notes

Local CLI adapters run unsandboxed on the host machine.

That means:

- prompt instructions matter
- configured credentials/env vars are sensitive
- working directory permissions matter

Start with least privilege where possible, and avoid exposing secrets in broad reusable prompts unless intentionally required.

## 10. Minimal setup checklist

1. Choose adapter (`claude_local` or `codex_local`).
2. Set `cwd` to the target workspace.
3. Add bootstrap + normal prompt templates.
4. Configure heartbeat policy (timer and/or assignment wakeups).
5. Trigger a manual wakeup.
6. Confirm run succeeds and session/token usage is recorded.
7. Watch live updates and iterate prompt/config.
