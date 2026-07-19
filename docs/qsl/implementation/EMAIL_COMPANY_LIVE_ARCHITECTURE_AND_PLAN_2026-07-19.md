# Email Company - Live Architecture and Implementation Plan

## Provenance

| Field | Value |
|---|---|
| Date | 2026-07-19 |
| Instance | `email-clean-20260719` |
| Company | `Email` (id `15f8fb0a-065d-4e2b-9d24-a49d986dcaf8`, prefix `EMA`) |
| Branch | `feat/qsl-current-upstream-integration` |
| Source | Kimi K3 live-instance architecture audit |
| Server | `127.0.0.1:3100`, deployment mode `local_trusted` |
| Server version | `2026.707.0+202.git.fc5fd6110` |

All statements below were verified against the running application (REST API responses, instance configuration, upstream schema and adapter source at `upstream/master = f12bb27bcd1b36148090d6922a85bf1611d327e0`). The running application is treated as the source of truth.

---

## Executive Summary

Paperclip is running successfully with a clean, isolated Email-company instance. The live system confirms:

- Issues are Paperclip's sole unit of work.
- Heartbeats connect assigned work to agent execution.
- OpenCode is a built-in Paperclip adapter; OpenRouter provides the models through OpenCode's own auth.
- Model selection is stored per agent and supports per-task overrides.
- Plugins, skills, routines, and adapters are separate but complementary extension systems.
- Nearly all Email-company requirements map to native Paperclip features.
- The only major missing capability is direct email input/output; it should be implemented as a plugin, never as a core modification.
- Important outbound actions must remain human-approved and fully auditable.

The immediate objective is not to build an email plugin. The immediate objective is to prove one complete operating loop:

```text
Issue -> Agent -> OpenCode Adapter -> OpenRouter Model -> Work Product -> Review
```

---

# PART A - Architecture of the Running Instance

## A.1 Verified Live State

| Property | Value |
|---|---|
| Instance dir | `C:\Users\mikeb\.paperclip\instances\email-clean-20260719\` |
| Health | `{"status":"ok"}` at `/api/health` |
| Company | `Email`, prefix `EMA`, `issueCounter: 0` (first issue will be `EMA-1`) |
| Company budget | `0` (not yet set) |
| Hire approval gate | `requireBoardApprovalForNewAgents: false` (recommend enabling) |
| Built-in agents | `Reflection Coach`, `Summarizer` - auto-provisioned, both **paused** |
| Database | Embedded PostgreSQL (`embedded-postgres@18.1.0-beta.16`), data dir `~/.paperclip/instances/email-clean-20260719/db`, port 54329 |
| Backup status | Warning `database_backup_missing` on fresh instance; hourly job closes it, or run `paperclipai db:backup` once |

The two built-in agents are live evidence of the configuration model:

```json
{
  "adapterType": "claude_local",
  "adapterConfig": {
    "model": "claude-haiku-4-5",
    "paperclipSkillSync": {
      "desiredSkills": ["paperclipai/bundled/paperclip-operations/summarize-status"]
    },
    "instructionsFilePath": "...instances/email-clean-20260719/companies/<cid>/agents/<aid>/instructions/AGENTS.md",
    "instructionsBundleMode": "managed"
  },
  "runtimeConfig": { "heartbeat": { "maxConcurrentRuns": 20 } },
  "metadata": { "paperclipBuiltInAgent": { "key": "summarizer" } }
}
```

## A.2 How Tasks Flow Through Agents

Issues are the only unit of work. Flow (engine: `server/src/services/heartbeat.ts`):

```text
Issue created (by board / agent / routine / plugin)
  -> status: backlog -> todo
  -> wakeup enqueued (trigger: assignment, @mention, schedule, manual,
     approval resolution, routine)
  -> agent_wakeup_requests + heartbeat_runs(status:"queued")
  -> scheduler tick (30s) claims run (per-agent concurrency + budget check)
  -> ATOMIC CHECKOUT: single SQL update guarded on status+assignee
     (409 = someone else holds it; never retry a 409)
  -> issue: in_progress, execution lock set
     (checkout_run_id, execution_locked_at)
  -> workspace resolution (project workspace / git worktree)
     + per-run MCP gateway tokens
  -> adapter.execute()        <-- the agent actually runs here
  -> agent calls REST API with run JWT + X-Paperclip-Run-Id header
  -> issue -> in_review -> done (terminal) | blocked | cancelled
  -> cost_events -> budget check (100% = auto-pause) -> activity_log
```

## A.3 How Agents Invoke the OpenCode Adapter

1. The heartbeat engine resolves `getServerAdapter(agent.adapterType)` (`server/src/adapters/registry.ts`) and calls `adapter.execute(ctx)`.
2. The `opencode_local` adapter (`packages/adapters/opencode-local/src/server/execute.ts`) **spawns the `opencode` CLI as a child process** (override: `PAPERCLIP_OPENCODE_COMMAND`).
3. The child receives: the agent's managed instructions bundle (`AGENTS.md` under the instance's `companies/<cid>/agents/<aid>/instructions/`), materialized skills (`.../src/server/skills.ts`), `PAPERCLIP_*` env vars, and a short-lived run JWT.
4. OpenCode talks to OpenRouter using the **OpenCode CLI's own user-level auth** (outside Paperclip). Paperclip never sees the OpenRouter key.
5. The adapter streams stdout logs, token usage, cost, and session params back; sessions resume across heartbeats (`agent_task_sessions`).

## A.4 Where Adapter Configuration Is Stored

| Scope | Location |
|---|---|
| Per agent | `agents.adapter_type` (text, e.g. `opencode_local`) + `agents.adapter_config` (jsonb: `model`, `paperclipSkillSync.desiredSkills`, instructions paths) |
| Config history | `agent_config_revisions` - every change revisioned; supports governance rollback |
| Per-agent runtime | `agents.runtime_config` (jsonb, e.g. `heartbeat.maxConcurrentRuns`) |
| Instance | `~/.paperclip/adapter-settings.json` (enable/disable types), `~/.paperclip/adapter-plugins.json` + `adapter-plugins/` (external adapter packages; store: `server/src/services/adapter-plugin-store.ts`) |
| Run env layering | company secret bindings -> project `env` -> routine env overlay -> Paperclip-owned keys |

## A.5 Where Model Selection Is Persisted

Primary: **`agents.adapter_config.model`**. For `opencode_local` it is mandatory in **`provider/model` format**: `requireOpenCodeModelId()` throws `OpenCode requires adapterConfig.model in provider/model format` (`packages/adapters/opencode-local/src/server/models.ts`). Live proof on this instance: the Summarizer carries `adapterConfig.model: "claude-haiku-4-5"`.

| Layer | Mechanism |
|---|---|
| Agent default | `adapter_config.model` (revisioned via `agent_config_revisions`) |
| Per-task override | `issues.assignee_adapter_overrides` (jsonb), editable in Issue Properties (upstream #9710) |
| Recovery lane | `modelProfiles.cheap` in the heartbeat engine (status-only work, `allowDeliverableWork: false`) |
| UI dropdown source | `listOpenCodeModels()` shells `opencode models` (60s cache) - i.e. the models your OpenRouter auth exposes |

### Operational Note - Provider Prefix Determines Authentication

During implementation we confirmed an important OpenCode behavior that is not obvious from the UI.

OpenCode does not authenticate solely based on the model name. It authenticates according to the **provider prefix** contained in the selected model identifier.

Examples:

```text
BAD:  deepseek/deepseek-chat
      -> Uses the direct DeepSeek provider and DeepSeek credentials.

GOOD: openrouter/deepseek/deepseek-chat
      -> Uses the OpenRouter provider and the configured OpenRouter API key.
```

Likewise:

```text
openrouter/moonshotai/kimi-k3
openrouter/moonshotai/kimi-k2.5
```

also authenticate through OpenRouter.

This distinction caused initial confusion during Email-company onboarding because the non-prefixed DeepSeek model appeared valid but executed using a different provider than intended.

**Recommendation:** when the operational intent is to route requests through OpenRouter, always choose an `openrouter/...` model identifier rather than a provider-native identifier.

This behavior should be treated as an operational requirement for all QSL Paperclip deployments.

## A.6 How Plugins, Skills, Routines, and Adapters Interact

The heartbeat engine is the conductor; the four extension systems are orthogonal:

- **Routines** (`routines` / `routine_triggers` / `routine_runs`): cron/webhook/API trigger fires -> `dispatchRoutineRun` creates an **issue** (`originKind: "routine_execution"`, guarded by the `open_routine_execution` unique index) and wakes the assignee. Routines produce work; they do not execute it.
- **Skills**: versioned `company_skills` + bundled catalog (`packages/skills-catalog`). Agents declare `adapterConfig.paperclipSkillSync.desiredSkills`; the **adapter** materializes them into the agent CLI at run time. Skills are doctrine delivered through adapters.
- **Plugins**: out-of-process workers (JSON-RPC over stdio). Into each run they can inject **tools** (plugin tool dispatcher + per-run MCP tokens). Into the platform they add **jobs** (own scheduler), **webhooks**, **API routes**, **UI pages/sidebar/widgets**, and **DB namespaces with their own migrations** (`plugin_database_namespaces` / `plugin_migrations`). They may also manage agents/routines/skills/projects as managed resources.
- **Adapters**: the execution edge. They receive instructions bundle + skills + MCP config + scoped secrets, run the agent, and report cost/session/logs. Budgets gate all of it.

## A.7 Safest Extension Points for the Email Company

In order of preference:

1. **Company data** - agents, goals, projects, skills, routines (zero code).
2. **Pipelines + cases** for intake/lead tracking - native upstream entities (`pipelines`, `pipeline_stages`, `cases`, `pipeline_cases` tables + gated UI routes). Do not build custom tables for lead qualification.
3. **One plugin** (`plugin-email`) for the only genuinely missing capability - mail I/O - using capabilities `jobs.schedule`, `webhooks.receive`, `issues.create`, `http.outbound`, `secrets.read-ref`, `ui.page.register`, `ui.sidebar.register`.
4. **Approvals** as the human gate.

Skills and company export/import bundles (`COMPANY.md` + `.paperclip.yaml`) make everything reusable for future companies.

## A.8 QSL Review: Built-in or Custom?

**Custom - specific to this fork, not upstream.** `upstream/master` contains zero `qsl` paths. All QSL code exists only in this branch's 11 additive commits:

- `server/src/routes/qsl-bridge.ts`, `server/src/services/qsl-review.ts`
- `ui/src/pages/QslReview.tsx`, `ui/src/api/qsl.ts`
- `packages/db/src/schema/qsl_findings.ts` + migration `0182_qsl_findings.sql`

It runs in this instance only because the server is built from this branch. It is dormant unless something POSTs findings to the QSL bridge. Recommendation: leave dormant; pluginize it later (it maps cleanly to a plugin: DB namespace + apiRoutes + UI page slot), which also removes the core migration-numbering collision at `0182`.

---

# PART B - Vision vs. Audited Architecture

The Email company is intended as an AI-operated communications company, not an email client. Every vision item maps to a native mechanism except one:

| Vision item | Native mechanism | New code? |
|---|---|---|
| AI-operated communications company | Company + org tree + heartbeats + budgets | No |
| Unified email operations (I/O) | `plugin-email` (jobs/webhooks in; approval-gated tool out) | **Yes - the only one** |
| Customer intake, lead qualification, sales follow-up | Pipelines + cases + routines + triage agent | No |
| Client communications | Issues + comments + draft work products | No |
| Knowledge capture from conversations | Issue documents, work products today; `plugin-llm-wiki` as reference later; memory is on upstream's roadmap - do not pre-build | Later/optional |
| Task generation from emails | Triage agent creates issues via API (or `suggest_tasks` interaction) | No |
| Calendar and scheduling | Routines now; calendar MCP via the tool gateway later | No (later) |
| Document drafting and review | Issue documents (`plan` key), `in_review`, `issue_approvals` | No |
| Human approval before important outbound | `approvals` + execution policies; send-gate pattern (below) | No |
| Complete audit trail | `activity_log`, `cost_events`, `heartbeat_run_events`, `secret_access_events` | No |
| Cheap/strong model routing | Org design, not code: cheap models (DeepSeek/Kimi via `openrouter/...`) on triage/routine agents, strong models on drafting/analysis; per-task overrides; `modelProfiles.cheap` recovery lane. Upstream "smart model routing" is only a plan doc - configure, don't build | No |
| Reusable across future companies | Skills + company export/import bundles | No |

**Send-gate pattern** (human approval before important outbound): agent drafts -> attaches draft as work product -> `request_board_approval` -> send executes only on approval resolution. Enforced by existing machinery, fully audited in `activity_log`.

**Model routing as org design:** assign models per role through `adapter_config.model` - cheap (DeepSeek Chat / Kimi) for triage and routines; more capable models reserved for drafting and complex analysis; per-task override via Issue Properties when a specific issue justifies it; `modelProfiles.cheap` covers status-only recovery work automatically.

---

# PART C - Smallest Aligned Implementation

Four stages. Exactly one involves new code.

## Stage 0 - Prove the loop (today, ~1 hour, zero code)

1. Set a company monthly budget and enable `requireBoardApprovalForNewAgents` (Company Settings) - governance posture before autonomy.
2. Create the root company goal (e.g. "Operate reliable, human-approved communications for QSL ventures").
3. Create one agent: **Email Ops CEO**, adapter `opencode_local`, `model: openrouter/<cheap-capable-id>` exactly as listed by `opencode models` (Kimi or DeepSeek id).
4. Create issue **EMA-1**: "Produce Email company operating doctrine v0.1 (roles, triage rules, escalation)" assigned to the CEO; wake it (board wake or `paperclipai heartbeat run -a <agentId>`). Confirm: run transcript, cost event, activity entry, work product.

Do not build anything until this loop is green end-to-end.

## Stage 1 - Org + doctrine (zero code)

Hire three agents reporting to the CEO:

| Agent | Model tier | Job |
|---|---|---|
| Intake Triage | Cheapest (DeepSeek/Kimi) | Classify inbound items, create/route issues, draft suggested tasks |
| Comms Drafter | Stronger (justified) | Draft outbound communications as work products; never sends |
| Ops Analyst | Cheap | Summaries, metrics, weekly review inputs |

Write three company skills: `email-triage-sop`, `outbound-drafting-sop` (draft-only; humans send), `escalation-and-approval-rules`. Set per-agent budgets. Leave the two built-in agents paused.

## Stage 2 - Routines (zero code)

- `morning-ops-brief` - weekday cron -> issue -> CEO.
- `weekly-comms-review` - weekly cron -> issue -> Ops Analyst.

This converts the company from reactive to self-operating.

## Stage 3 - plugin-email v1, read-only (the only new code)

Scaffold with `create-paperclip-plugin`. Capabilities: `jobs.schedule`, `issues.create`, `http.outbound`, `secrets.read-ref`, `ui.page.register`.

- **v1 (read-only):** IMAP-poll job (or provider inbound webhook) -> normalize -> dedup by message-id in plugin state -> create issues in an **Intake** project. Leads tracked as **cases** in a pipeline. Outbound remains draft + board approval; a human sends.
- **v2 (later):** approval-gated send tool; calendar tool via the MCP tool gateway; knowledge capture if documents/work products prove insufficient.

## Housekeeping

- `database_backup_missing` warning is expected on a fresh instance; the hourly backup job closes it, or run `paperclipai db:backup` once.
- Keep the instance-per-branch discipline (`email-clean-20260719` vs upstream instances) so fork migration `0182` never collides with upstream's journal.

## Single Next Action

**Stage 0, step 3:** create the Email Ops CEO agent with an OpenRouter model id taken verbatim from `opencode models`, then run EMA-1 end-to-end. Everything else sequences on top of that proven loop.
