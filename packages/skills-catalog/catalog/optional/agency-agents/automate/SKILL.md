---
name: "automate"
description: "Use this skill to create Codex Automations."
environments:
  - local
key: "paperclipai/optional/agency-agents/automate"
recommendedForRoles:
  - "engineer"
  - "operations"
tags:
  - "agency-agents"
  - "engineer"
  - "operations"
  - "automate"
defaultInstall: false
---
# Create Automation (Interactive)

Use this skill when the user explicitly wants to make, build, set up, or create a new **Codex Automation** — for example "create a Codex automation", "open the Automations editor with this draft", or "set up a scheduled Codex agent".

**Disambiguation.** "Automation" in a user workspace can mean many things (`.github/workflows`, CI pipelines, scheduled jobs, scripts, dbt, browser automation, shell scripts, workflow engines). Do **not** assume generic phrases like "automate this", "help me automate my deploys", or "make an automation" mean **Codex Automation**. Route to the named surface when the user mentions one, use normal repo/product exploration when the context points elsewhere, or ask a short clarifying question when the target surface is ambiguous. Start this spine only when the user explicitly asks for Codex Automations or confirms that Codex Automations is the intended surface.

## Execution spine (every run)

1. **Finish-path check.** First, check whether the in-app Automations editor handoff is available (see **Finish availability** below). If neither the Automations editor tool nor the resource opener is available, immediately say "Please use this skill in the Agents Window." and stop.
2. **Capture intent + proactive integration discovery.** After the finish-path check passes, if the prompt is missing 2+ of {what kicks it off, what should happen, what outcome}, send one short plain-chat message asking for a 1–2 sentence description and wait. Skip when the prompt already names trigger + action + outcome. Proactively run discovery for any integration the user named or implied — `gh repo view` on cwd; Slack MCP channels; PagerDuty MCP services; Linear/Sentry MCP teams/projects. Use the results to skip questions later.
3. **Completeness gates.** Work through the trigger, tool, prompt, naming, and PCD checks below. Do not jump to a summary while required picker-backed fields are still unknown unless the user explicitly deferred them to the Automations editor.
4. **One consolidated question.** Ask inline for whatever integration discovery couldn't resolve — trigger details, repo / channel / service when ambiguous, tools when not obvious. Default to plain-chat inline. Only escalate to `AskQuestion` for (a) the tools multi-select and (b) integration discovery candidate lists with 3+ matches.
5. **Draft table → approval → finish handoff.** Show a compact Markdown table (plain language, no YAML) recapping name / description, trigger, tools, instructions, resolved settings, and "to finish in editor". User approves, then ask whether they are ready for you to open the Automations editor so they can finish any deferred values there. When they say yes, use the finish path from the availability check.

---

## House rules

- **Plain language only.** Never show or talk about MCP / tool / proto names, request types, enum values, stage labels, or raw CLI output in user-visible chat. Say "open the editor with the draft", "the Slack channel", "the repo and branch". Exception: the user explicitly asks to see internals.
- **No YAML in finalization.** The draft table = compact Markdown only in plain language. Build and validate YAML / JSON internally; surface the wire payload only when the user asks for it.
- **No automatic fallbacks.** Never submit, open a URL, paste a browser prefill link, or switch buckets. The only finish path is the reviewed draft table, user approval, user readiness confirmation, then opening the Automations editor. If neither the Automations editor tool nor the resource opener is available, stop immediately and tell the user to use this skill in the Agents Window.
- **Creation-only.** This skill prepares new automations only. Do not list, get, inspect, update, or search existing Codex Automations from chat.
- **Integration discovery is allowed.** Use connected integration MCP read / list / search tools for picker-backed integration values such as Slack channels, PagerDuty services, Linear teams, and Sentry projects. This does **not** include backend automation tools that list, get, inspect, create, update, finish, or prefill Codex Automations.
- **Repo file references.** Only reference a file from the chat's current repo (path, excerpt, or `@file` mention) in any draft field — prompt, instructions, name, or description — when **both** are true: (1) the automation will run in that same repo (its git trigger scope or `workflow.gitConfig.repo` is the chat's repo) **and** (2) the file is committed to that repo (tracked by `git` on the branch the automation will check out, not just present in the working tree). If either condition fails, paraphrase the intent instead, or ask the user to commit and push the file first — do not embed the path or content. Untracked / staged-only / dirty-only files, files outside the automation's repo, and files in a different repo from the chat's checkout never qualify.

---

## PCD — Portal completeness & deferral

Use these checks to keep the draft complete before opening the editor. Do not show the ids to the user.

| Id | Scope |
|----|-------|
| **PCD:slack-trigger** | `slackTrigger` channel selection. Ask whether to specify channel(s) now or pick them in the Automations UI; discovery or explicit UI deferral must happen before the draft table. |
| **PCD:slack-actions** | `slack` / `readSlack` actions. Ask for the destination or explicit editor deferral before the draft table. |
| **PCD:git-scope** | `git` PR / push / CI triggers. Repo/org/branch scope must be resolved or explicitly deferred to the editor. |
| **PCD:universal** | Every intentional gap appears in the draft table's "To finish in editor" row and is repeated in the final handoff note. |

### PCD matrix

| Scope | Before opening editor unless deferred |
|-------|---------------------------------------|
| **PCD:slack-trigger** | Slack channel ids are resolved, or user chose to pick channels in the Automations UI. Empty channels are valid only for explicit UI deferral. |
| **PCD:slack-actions** | `slack.channel` / readSlack scope is resolved, or user chose **Select channels** in the editor. IDs must be `C…` / `G…` / `D…`, never `U…`. |
| **PCD:git-scope** | PR triggers have repos/orgs; push triggers have repo + branch; CI triggers have repo scope. Use scoped repo discovery only after the user identifies the target. |

### PCD notes

- Slack trigger and Slack action destinations are separate questions. A Slack trigger does not imply a Slack action destination, and a Slack action does not imply a Slack trigger channel.
- Do not prefill empty Slack channel values after the user chose "specify now" unless discovery ran or the user explicitly switched to editor deferral.
- For Slack replies, offer "respond in the triggering thread" separately from "send to a specific channel or DM".
- When `mcp` is enabled, the server must pass the **MCP existence gate** and **MCP auth gate** below. Prefer discovering and selecting the exact catalog server name yourself; ask the user only when multiple usable catalog matches fit the request or the requested integration is ambiguous. Do not call it a Codex plugin. Do not invent server names.

### MCP existence gate

An MCP server is eligible only when the current user's available MCP/tool catalog proves it exists and is usable in this session. Before using an MCP for integration discovery or adding an `mcp` action to the draft, inspect the actual catalog exposed to the agent session and pick the right value to put into `mcp.server.name`.

**Read the right field from the catalog.** Each agent-side catalog entry lives at `~/.cursor/mcps/<folder>/SERVER_METADATA.json` and carries two distinct values:

- `serverIdentifier` — the scoped folder name the agent runtime uses (e.g. `dashboard-team-1-Linear`, `plugin-pagerduty-pagerduty-mcp`, `cursor-app-control`).
- `serverName` — the plain name the user configured on cursor.com (e.g. `Linear`, `pagerduty-mcp`, `Databricks SQL`).

Write `serverName` into `workflow.actions[].mcp.server.name` and any `@[MCP: ...]` prompt mentions. Never write `serverIdentifier` / the folder name, never invent or paraphrase a prefix (`team-…`, `user-…`, `<orgId>-…`), and never hand-strip prefixes from the folder name — many `serverName`s contain spaces (e.g. `Databricks SQL`, `statsig read only console`), so string-munging the identifier is fragile. The Automations editor matches on trim + lowercase, so casing does not matter, but pass the exact `serverName` from `SERVER_METADATA.json` anyway. When you have a useful URL, you may also pass `templateMcpHints: [{ name: <serverName>, url: <serverUrl> }]` so a URL match can rescue a name drift.

**Eligibility — dashboard-backed servers only.** Only dashboard-backed servers appear in the Automations editor's `GetAvailableMcpServers` response, which is what the editor uses to resolve a prefilled `mcp` action to a connected server. Their `serverIdentifier` always begins with one of these prefixes:

- `dashboard-team-<teamId>-` (team-shared servers)
- `dashboard-` (personal user-configured servers on cursor.com)
- `plugin-<slug>-` (marketplace plugin servers)

Everything else in the agent catalog — `cursor-ide-browser`, `cursor-app-control`, `extension-…`, project `mcp.json` servers, and other local servers — does NOT appear in the dashboard catalog. Treat those as ineligible for the `mcp` action: do not add them to `workflow.actions`, do not reference them in `@[MCP: ...]` prompt mentions, and do not assume they will resolve when the editor opens. Prefilling an ineligible server lands the row in the blocked "Set up MCP" state and prevents the user from saving.

If one usable, dashboard-eligible catalog server clearly matches the user's requested integration, use it without asking the user to spell the server name. A name from the user prompt, a screenshot, a skill file, a workflow template, marketplace docs, or company convention is not proof.

If the catalog does not contain a usable, dashboard-eligible server, do not call that MCP, do not add an `mcp` action for it, and do not include `@[MCP: ...]` prompt mentions. Servers that are missing, disabled, or still need setup count as unavailable for prefill. Ask the user to set it up first, or leave the MCP out of the draft and record "Set up/select <integration> in the Automations editor" in **To finish in editor**. Unknown MCP server names are not valid deferred tool rows because prefilled missing MCPs block save.

### MCP auth gate

**Why this exists.** The Automations editor can prompt for MCP OAuth, but that flow navigates away from the draft and the user loses in-progress changes. Authenticate MCPs here in chat **before** you add an `mcp` action, show the draft table, or open the editor.

**When it applies.** Run this gate whenever you plan to add an `mcp` action or `@[MCP: ...]` prompt mention for a dashboard-eligible server — including after integration discovery for picker-backed values.

**Detect unauthenticated servers** from the current session catalog (do not guess). `STATUS.md` is written for both auth and generic error states, so its mere existence is **not** an auth signal — read the file and check its content:

- `~/.cursor/mcps/<folder>/STATUS.md` exists **and** its content says the server needs authentication (e.g. "needs authentication" / instructs calling `mcp_auth`). A STATUS.md that only reports a generic error is **not** an auth signal.
- `GetMcpTools` (or equivalent catalog inspection) reports `serverStatus: "needsAuth"` for that server's `serverIdentifier`.
- The server's live tool list is only `mcp_auth` (no other usable tools yet).
- Integration discovery against that server fails with an authentication / authorization error.

A server that passes the existence gate but matches any auth signal above is **not authenticated** — treat it separately from "missing", "not set up", or generic error.

**Hard stop until authed.** If the target MCP is not authenticated:

1. **Stop the automation-drafting spine.** Do not add the `mcp` action, do not include `@[MCP: ...]` mentions, do not show the draft table, and do not open the Automations editor.
2. **Tell the user plainly** which integration still needs to be connected (use `serverName`, never internal ids). Explain that connecting it now keeps their draft safe; deferring auth to the Automations editor can discard unsaved work.
3. **Offer inline auth when available.** This skill runs in the Agents Window, where interactive MCP auth is supported. If the server exposes `mcp_auth` (via `GetMcpTools`, the server's tool list, or `STATUS.md`), ask whether you should start the connection flow now. When they agree, authenticate **one server at a time** by calling `mcp_auth` for that server's `serverIdentifier` (empty args through the MCP tool interface, or the session's `McpAuth` tool with `server_identifier` when that is what is listed). Wait for success, re-check auth, then resume drafting.
4. **If inline auth is unavailable** (no `mcp_auth` tool in this session), direct them to connect the integration in Codex Settings → MCP, then return here and confirm when ready. Do not open the editor while the MCP is still unauthenticated.

**Never defer MCP OAuth to the Automations editor.** Do not put "Authenticate/connect <integration> in the Automations editor" in **To finish in editor** for an MCP you intend to prefill. Unauthenticated prefilled MCP rows block save and the editor auth redirect loses draft state.

**After auth succeeds**, re-run the auth gate, then continue integration discovery and drafting. Only include the `mcp` tool in the draft once the server is authenticated and usable.

---

## Procedure

### Stage 0 — Finish availability (must run before intent capture)

**Finish availability** (check once per run; this is the agent-internal decision — never quote tool names back to the user). Do not mention this check to the user. Do not say anything like "I'll first check whether the Automations editor handoff is available in this session." Do not inspect Codex backend automation tools. Do not inspect Codex backend automation tool descriptors to recover an old finish path.

| Bucket | Signal | Default finish |
|--------|--------|----------------|
| **Automations editor** | `cursor-app-control.open_automation` listed | Open the Automations editor with the reviewed draft |
| **Agents Window required** | Neither `cursor-app-control.open_automation` nor `cursor-app-control.open_resource` listed | Stop immediately — say "Please use this skill in the Agents Window." |

The Automations editor path uses `open_automation` directly with the reviewed draft. Do not inspect or call backend automation finish tools, build or paste a browser prefill URL, call `open_resource`, or build a `cursor://` deeplink.

If neither `cursor-app-control.open_automation` nor `cursor-app-control.open_resource` is available, do not continue the automation-drafting flow, do not generate a browser prefill URL, and do not ask follow-up questions. Immediately tell the user: "Please use this skill in the Agents Window."

### Stage 1 — Capture intent (plain chat, no AskQuestion)

Run this stage only after the finish availability check passes. If the user's prompt is thin, send one short plain-chat message and **wait**:

> "Before we dive in, what do you want this automation to do? What kicks it off, what should happen, and what's the outcome? A sentence or two is plenty. Let me know if you want some examples of what you can build."

Skip when the prompt already covers trigger + action + outcome, or the user said something similar to "walk me through it". The answer is freeform — never wrap this question in `AskQuestion`. Don't run repo discovery before Stage 1 fires or is deliberately skipped.

### Stage 2 — Authoring funnel

Existing automation edits are not supported in this flow. Do not list, get, inspect, update, or search existing automations through backend automation tools. Do not search by automation name or description. If the user wants to change an existing automation, ask them to edit it directly in the Automations UI or create a new replacement automation. Do not claim changes were saved from chat.

Work in Automations UI order: trigger → tools → prompt → name/description → draft table. Fill gaps from prior messages. Do not jump straight to YAML unless the user's prompt already covers the needed fields and PCD gates are satisfied or explicitly deferred.

#### Trigger

Use the **Appendix — Trigger selection tables** to pick the trigger and follow-ups. Resolve picker-backed values via integration discovery before asking; ask only for fields not already answered. A cron trigger without a resolved schedule is invalid for direct save; webhook triggers always come back to the editor after save for URL / auth.

#### Scheduled times

Cron stores a single expression, not a separate timezone field. If the user gives a schedule that maps cleanly to cron fields (for example "every weekday at 3am", "daily at 9am", or "Mondays at 9am"), include the cron trigger in the editor prefill. Treat "my timezone" or "local time" as the user's desired display-time intent when the hour/day pattern itself is expressible as cron. Do not put a schedule only in the prompt while leaving `workflow.triggers` empty.

For user-stated local times that cannot be encoded exactly as the Automations editor will display, do not pass a raw cron plus a timezone hint. Ask one more schedule question before opening the editor; do not open a scheduled automation with no trigger. Do not prefill `cron: {}`. It is invalid.

Valid cron examples:

```yaml
# Every hour
cron: { cron: "0 * * * *" }

# Every day at 9:00
cron: { cron: "0 9 * * *" }

# Every Monday at 9:00
cron: { cron: "0 9 * * 1" }

# Weekdays at 9:00
cron: { cron: "0 9 * * 1-5" }
```

#### Tools

Ask with structured multi-select when the tools are not obvious:

| Label | YAML |
|-------|------|
| Comment on PRs | `prComment` |
| Post to Slack | `slack` |
| Read Slack | `readSlack` |
| Request reviewers | `requestReviewers` |
| Manage check runs | `manageCheckRun` |
| Use MCP server | `mcp` |

When `slack` / `readSlack` is enabled, resolve the channel via Slack MCP discovery before drafting or document UI deferral. When `mcp` is enabled, run the MCP existence gate and MCP auth gate first; only exact, authenticated, usable catalog matches may be added to `workflow.actions`, and `mcp.server.name` MUST be the `serverName` value from the matched entry's `SERVER_METADATA.json` — never the folder / `serverIdentifier`. If a requested MCP is missing or not set up, do not prefill it — ask the user to set it up or defer setup/selection to the editor. If it exists but is not authenticated, stop per the MCP auth gate — do not prefill it and do not defer OAuth to the editor.

#### Prompt + name

Ask "What should the agent do when [trigger]?" Default one tight paragraph; match the user's length if they gave more. Cloud compute is configured in the [Cloud Agent dashboard](https://cursor.com/dashboard?tab=cloud-agents). Suggest a name + 1–2 sentence description from prior answers.

#### Fast-path

If confidence is high and required fields are present, you may skip straight to the draft table. Do not use fast-path to skip Slack channel choices, Git repo/branch scope, `mcp.server.name`, an unresolved schedule, or the MCP auth gate — fast-path never bypasses the **Hard stop until authed** rule, and the draft table cannot appear while a prefilled MCP is still unauthenticated. When uncertain, ask one focused question rather than replaying the full questionnaire.

### Stage 3 — Draft table, validation, finish

Recap the draft as a compact Markdown table in plain language. Don't write a planning document, checklist, or "steps I'll take":

| Draft field | What will open in the editor |
|-------------|------------------------------|
| Name / description | Short plain-language value |
| Trigger | What starts the automation |
| Tools | Enabled capabilities |
| Instructions | The prompt behavior, summarized |
| Resolved settings | Repo / branch, Slack channel, service / project, schedule, and other picker-backed values |
| To finish in editor | Settings deferred to the Automations UI; write "None" if nothing is deferred |

End with "Does this look correct?" Do not append a YAML or JSON block. After approval, run the internal **Validation check**, then send the finish handoff confirmation. A plain "yes" to the draft approves the draft, but it does not replace the final readiness confirmation.

#### Glass finish path (compliance)

When `cursor-app-control.open_automation` is available, there is exactly one finish path:

1. Show the Markdown draft table.
2. Wait for the user to approve it.
3. Tell the user which values, setup, or webhook/auth details must be finished in the Automations editor. Ask a direct readiness question, such as "Are you ready for me to open it for you?"
4. After they confirm, open the Automations editor with the reviewed draft.

Do not offer save, browser, paste-link, skip, or fallback choices.

### Post-finish actions (agent-internal)

Before opening the editor or otherwise moving the user away from chat, send one short final handoff note with every deferred field and caveat the user needs after the handoff. Include all "To finish in editor" rows, integration setup notes, webhook/auth follow-ups, Slack DM/channel picker confirmations, Cloud compute notes, and any schedule that was intentionally left for the editor picker. End with a direct readiness question, such as "Are you ready for me to open it for you?" When the user says yes, use the selected finish path. Do not put these reminders after the open step; the user may not see chat once they leave.

- **Open the Automations editor with the draft** (Automations editor). Use only for new automations. Call `cursor-app-control.open_automation` with the reviewed WorkflowData JSON as `prefillWorkflowData`. Do not call backend automation tools, `open_resource`, a browser URL builder, or a `cursor://` URL for this bucket. If `open_automation` fails, explain the failure in plain language and stop.
- **Agents Window required**. If neither `cursor-app-control.open_automation` nor `cursor-app-control.open_resource` is available, say "Please use this skill in the Agents Window." Do not draft, submit, paste a browser prefill URL, or switch paths automatically.

---

## Reference

### Discover before ask

Before asking the user for a picker-backed value (repo, Slack channel / DM, GitHub/GitLab PR / comment scope, PagerDuty service, Linear team, Sentry project, …), proactively check whether the associated integration MCP or CLI is available and authenticated, then fetch the relevant records. For MCP-backed integrations, the availability check must be the current user's actual MCP/tool catalog, not a remembered or guessed server name. Use the result to inform the next question: **1 match → inline confirm; 2 → inline either/or; 3+ → `AskQuestion` single-select.** Only ask freeform after scoped integration discovery is exhausted or the user picks deferral to the automations editor.

**Auth boundary.** Call integration list / search / read tools, `gh`, or `glab` when connected and authenticated. Do not use this path to list, get, inspect, create, update, finish, or prefill Codex Automations.

- **MCP integrations used for an `mcp` automation action** follow the **MCP auth gate** above — stop, explain, and authenticate in chat before prefilling. Inline `mcp_auth` is supported in the Agents Window when listed for that server.
- **Other integrations** (Slack channel discovery, PagerDuty services, `gh` / `glab`, etc.): if missing or unavailable, ask whether the user wants to set it up before continuing. If they say yes, guide setup and retry discovery after they confirm it is ready. If they say no, continue with the draft and say the user will need to finish that integration setup in the Automations editor afterwards. For these non-MCP-action integrations only, do not call `mcp_auth` without an explicit **Retry after setup** confirmation.

#### GitHub / GitLab repo scope

Accept natural repo nicknames; do not ask for `owner/repo` format first, and do not ask the user to list repos before trying scoped CLI discovery. Order:

1. **Exact or current repo.** If the user gave exact `owner/repo`, said "this repo", or the current checkout is the obvious target, use `gh repo view owner/repo --json defaultBranchRef,nameWithOwner` or `gh repo view --json defaultBranchRef,nameWithOwner` to fetch repo + default branch. For GitLab, use the equivalent `glab repo view` / project view command when available. Run auth status only if the exact lookup fails due to auth.
2. **Several named candidates.** If the user named several repo candidates, do not run an unscoped search. Resolve exact `owner/repo` candidates with lookup, or run scoped discovery only when a shared owner/org/namespace, current checkout, or product context narrows the search. If no scoped lookup is available, use `AskQuestion` over the user-named repos plus **Pick in Automations UI** before any CLI lookup.
3. **User needs to choose.** If the user needs to select a repo and the owner/org/namespace, nickname, current checkout, or product context scopes the search, proactively fetch candidates before asking: `gh search repos "<nickname> in:name" --json fullName,description --limit 10`, scoped `gh repo list <owner-or-org> --json nameWithOwner,description --limit 20`, or the equivalent scoped `glab repo list` / project search. Do this even when the next step is asking the user to pick one.
4. **Present candidates.** Use discovery results or user-named candidate sets in the next question: 1 match → inline confirm; 2 → inline either/or; 3+ → `AskQuestion` over the returned or named repos plus **Pick in Automations UI**. When repo choice is ambiguous after search/list discovery, use `AskQuestion` over partial matches + UI deferral instead of a freeform repo question.
5. **Confirm branch.** Use the lookup's default branch when available. If the automation requires a specific branch and discovery did not resolve it, ask for branch or offer the default branch explicitly.
6. **Discovery failed or unavailable.** If `gh` / `glab` is missing, unauthenticated, unavailable, or the scoped lookup/search/list fails, then ask the user what repo and branch to use or whether to pick them in the Automations UI. Do not block on CLI setup unless the user chooses **Retry after setup**.

Guardrails: do not run broad private repo inventory or unscoped account/org sweeps. Keep `gh repo list` / `glab repo list` scoped to an owner/org/namespace or similarly narrow context. Do not use raw `git remote` output as the only source of truth.

#### Slack

Slack MCP discovery before channel question, every time `slackTrigger` / `slack` / `readSlack` is involved. **Specify now** means the agent runs discovery first — not "ask the user for IDs". 1 channel → inline confirm; 2 → inline either/or; 3+ → `AskQuestion` over returned channels (+ **Pick in Automations UI**). **Do not prefill with empty channels after Specify now without discovery or continue-without.** If discovery is blocked → **Retry after setup** / **Continue without MCP** / **Pick in Automations UI** inline.

Slack `channel` accepts `C…` / `G…` / `D…` IDs only — never `U…` member IDs. For Slack replies, offer **respond in the triggering thread** separately from **send to a specific channel or DM**. Empty `{}` actions are valid when the user picks **Select channels** in the editor; record the deferral in the draft table.

#### PagerDuty / Linear / Sentry

PagerDuty MCP list services before `serviceIds` scope: 1/2 inline; 3+ → `AskQuestion` over services. **Optional `serviceIds`** — otherwise defer to UI. Linear teams / projects and Sentry projects follow the same pattern: discover when MCP is connected; otherwise defer to the editor.

### YAML output shape (agent-internal)

Wire format matches the reviewed Automations draft passed to `open_automation` as `prefillWorkflowData` — canonical proto JSON with full enum names (e.g. `GIT_PULL_REQUEST_ACTION_OPENED`). PR scope lives on `git.pullRequest` (`repos` / `orgs`); `workflow.gitConfig` holds `repo` + `branch` for non-`git` triggers that need a checkout. Use `ignoreDraftPrs`, not `ignoreDraftPr`. Slack channel / DM IDs: `C…` / `G…` / `D…`.

Skeleton:

```yaml
name: "My automation"
description: "Optional description"
workflow:
  triggers: []
  actions: []
  prompts: []
  model: ""
  agentOptions:
    skipInstall: false
  memoryEnabled: true
```

Prompts use `|` block scalar (`>-` folding breaks bullets). Empty `{}` actions are valid when the field is UI-only. `mcp.server.name` is required when `mcp` is enabled, and the name must be the `serverName` field from the matched entry's `SERVER_METADATA.json` — not the folder / `serverIdentifier`. See the MCP existence gate for the eligibility filter and the no-prefix-invention rule.

**Trigger oneof keys are exhaustive.** Every entry in `workflow.triggers` must use exactly one of these top-level proto keys: `cron`, `git`, `slackTrigger`, `slackReactionAdded`, `slackChannelCreated`, `microsoftTeamsTrigger`, `microsoftTeamsChannelCreated`, `linear`, `webhook`, `pagerduty`, `sentry`. Never invent or paraphrase (`slackReaction`, `slack_reaction`, `slack`, `reactionAdded`, etc.) — the editor decodes triggers with `ignoreUnknownFields: true`, silently drops unknown keys, and renders the result as an unconfigurable "Configure trigger" card that blocks save. Empty `{}` trigger entries hit the same failure mode; never prefill a trigger you cannot fully name.

### Validation check (agent-internal)

After draft table approval: validate YAML vs checklist + proto (PR enums, `ignoreDraftPrs`, Slack ID prefixes, `gitConfig` presence when needed, `mcp.server.name` when `mcp` is enabled, MCP actions backed by authenticated usable catalog matches, and description text free of `__securitybot_metadata__` / `customInstruction` metadata markers). **Do not invent inline JSON-schema validators** or shell snippets for automation YAML — they drift from proto shape and can falsely fail valid drafts. If validation fails, explain the issue in plain language and ask what to change; do not paste the full YAML unless the user explicitly asked. **Do not use backend automation tools and do not shell out to repo-local scripts** — use `open_automation` for Automations editor handoff only.

---

## Appendix — Trigger selection tables

These labels are agent-only — never show ids to users. If a future structured picker is used, split rows before any option cap.

### Trigger category

**Prompt:** "When should this automation run?"

| Option label | Option id | Proto / YAML |
|--------------|-----------|----------------|
| On a schedule | `cron` | `cron` |
| On a GitHub / GitLab event | `git` | `git` → specific event |
| On a Slack event | `slack` | specific event: `slackTrigger` vs `slackChannelCreated` |
| On a Linear event | `linear` | `linear` → specific event |
| On a PagerDuty incident event | `pagerduty` | `pagerduty` → specific event |
| On a Sentry issue event | `sentry` | `sentry` → specific event |
| On an incoming HTTP webhook | `webhook` | `webhook` |

### Specific event (per category)

**`cron`** — Prompt: "Which schedule shape?"

| Option label | Option id | Notes |
|--------------|-----------|-------|
| Every hour | `cron_every_hour` | UI preset |
| Every day | `cron_every_day` | preset |
| Every week | `cron_every_week` | preset |
| Custom cron expression | `cron_custom` | user supplies full cron |

**`git`** — Prompt: "Which Git event?"

| Option label | Option id | Maps to |
|--------------|-----------|---------|
| Draft pull request opened | `git_draft_opened` | `DRAFT_OPENED` |
| Pull request opened | `git_pr_opened` | `OPENED` |
| Code pushed to a pull request | `git_pr_pushed` | `PUSHED` |
| Pull request merged | `git_pr_merged` | `MERGED` |
| Comment added on pull request | `git_pr_commented` | `COMMENTED` |
| Label change | `git_label` | label trigger |
| New push to branch | `git_push` | push |
| Checks completed | `git_ci` | `ciCompleted` |

**`slack`** — Prompt: "Which Slack trigger?"

| Option label | Option id | YAML |
|--------------|-----------|------|
| New message in channel | `slack_message` | `slackTrigger` |
| Reaction added to message | `slack_reaction_added` | `slackReactionAdded` |
| Channel created | `slack_channel_created` | `slackChannelCreated` |

**`slackReactionAdded` payload** — `{ channels: ["C…"], emojiName: "<name>" }`. `emojiName` is the Slack short name **without** surrounding colons (e.g. `thumbsup`, not `:thumbsup:`); the server normalizes Unicode emoji to the matching alias on save. Completion reactions are not supported on `slackReactionAdded` triggers (would recurse) and are silently dropped.

**Completion reaction on a Slack message trigger.** "React with `:foo:` when the agent finishes" is a completion-reaction option on `slackTrigger`, not a separate trigger. Put `slackCompletionReactionMode: SLACK_COMPLETION_REACTION_MODE_CUSTOM` and `slackCompletionReactionCustomEmoji: ":foo:"` (with surrounding colons) on the same `slackTrigger` entry. Do not create a `slackReactionAdded` trigger to express completion behavior.

**Disambiguate "react with …".** When the user says "react with X to trigger" the trigger is `slackReactionAdded` (`emojiName: "x"`, no colons). When the user says "react with X when done" / "upon completion" / "after success" the trigger is `slackTrigger` with the completion-reaction fields above. Ask one focused question when intent is ambiguous instead of guessing.

**`linear`** — Prompt: "Which Linear event?"

| Option label | Option id | Proto JSON |
|--------------|-----------|------------|
| Issue created | `linear_created` | `linear.issueCreated` |
| Issue status changed | `linear_status` | `linear.statusChanged` |
| End of cycle | `linear_cycle` | `linear.endOfCycle` |

**`pagerduty`** — Prompt: "Which PagerDuty incident event?"

| Option label | Option id | Proto JSON |
|--------------|-----------|------------|
| Incident triggered | `pagerduty_triggered` | `incidentTriggered: {}` |
| Incident acknowledged | `pagerduty_ack` | `incidentAcknowledged: {}` |
| Incident resolved | `pagerduty_resolved` | `incidentResolved: {}` |
| Any incident event | `pagerduty_any` | `incidentAny: {}` |

Optional `serviceIds`. Proto may include `incidentEscalated` — only if user asks.

**`sentry`** — Prompt: "Which Sentry issue event?"

| Option label | Option id | Proto JSON |
|--------------|-----------|------------|
| Issue created | `sentry_created` | `issueCreated: {}` |
| Issue resolved | `sentry_resolved` | `issueResolved: {}` |
| Issue assigned | `sentry_assigned` | `issueAssigned: {}` |
| Issue archived | `sentry_archived` | `issueArchived: {}` |
| Issue unresolved | `sentry_unresolved` | `issueUnresolved: {}` |
| Any issue event | `sentry_any` | `issueAny: {}` |

Optional `projectIds`.

**`webhook`** — skip specific-event; `webhook: {}`; user gets URL/auth after save.

---
