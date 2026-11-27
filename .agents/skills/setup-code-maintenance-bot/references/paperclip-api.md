# Paperclip setup API

Use this reference when executing setup. These are API shapes, not commands to
run while authoring this skill. Read the selected instance's advertised schemas
before mutations; deployments can differ from the source used here.

## Access and discovery

Prefer the selected instance's available Paperclip tools. On Runner, discover
operations through its advertised `search_api` / `call_api` tools when present;
they supply authentication and company context. Do not invent tool names or
recover tokens from workspace files when those tools are unavailable.

If API access is unavailable or calls are not working and browser access is
available, use the authenticated Paperclip web UI on the selected instance.
Perform the same agent, skill, project, routine, and trigger setup through its
visible controls. Inspect existing records first, including resources created
by a partially successful API attempt. Honor the signed-in user's permissions
and approval gates. After saving, reopen the agent/routine and verify its fields,
trigger, and active/paused state. Record IDs and links from the resulting pages.
If the UI cannot configure a required setting, report that specific gap and keep
the setup paused; do not claim the setting was saved or bypass access controls.

For an authorized HTTP client, use its existing board session or injected
`PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY`. Normalize the base to append `/api`
exactly once. A run bridge address may differ from the user-facing web URL;
show the web URL but use the injected bridge for API requests. Never send the
credential to a different origin while resolving the user's instance choice.
Use the supported sign-in flow if access is missing, not credentials pasted
into chat. Keep secret values out of generated instructions, logs, and files.

Resolve identity/company through tool context, the authenticated CLI's `whoami`,
or `GET /api/agents/me` for agent callers. The latter is not a board identity
endpoint. Read only the selected company's records:

| Purpose | Operation |
| --- | --- |
| Candidate agents | `GET /api/companies/{companyId}/agents` |
| Agent configuration (permission required) | `GET /api/agents/{agentId}/configuration` |
| Projects and workspace selection | `GET /api/companies/{companyId}/projects`, `GET /api/projects/{projectId}`, `GET /api/projects/{projectId}/workspaces` |
| Existing routines | `GET /api/companies/{companyId}/routines` |
| Adapter capabilities | `GET /llms/agent-configuration.txt`, then `/llms/agent-configuration/{adapterType}.txt` |
| Available models | `GET /api/companies/{companyId}/adapters/{adapterType}/models` |
| AI connections (board access) | `GET /api/companies/{companyId}/ai-connections` |

Agent callers can manage only routines assigned to themselves. Creating a new
agent does not confer permission to manage that agent's routine. Use authorized
board/operator access for another agent (including the necessary `tasks:assign`
grant), or hand off through the supported authorized setup path. Do not mint an
agent key or impersonate the assignee to bypass this restriction. A forbidden
connection-list/configuration read is an access gap, not evidence of no accounts.

## Agent and AI connection

Read adapter docs before constructing configuration. A harness is the execution
adapter/runtime; a provider/model is its inference choice; an AI connection is
the account used to authenticate/bill it. The runtime also needs an execution
environment and separate Git-host access. Do not copy redacted credentials or
unrelated agents' entire configs.

For instances supporting managed AI connections, the binding belongs under
`runtimeConfig.aiConnection`, not an invented top-level `connectionId`:

```json
{
  "mode": "shared",
  "provider": "<supported-provider>",
  "method": "<supported-auth-method>",
  "connectionId": "<selected-connection-uuid>",
  "grantId": "<returned-grant-uuid>"
}
```

The alternative `responsible_user` binding uses `provider`, `method`, and
`mode: "responsible_user"` without connection/grant IDs. It resolves the
responsible user's provider default at run time; verify the scheduled routine's
responsible user and access, not just the setup caller's login. Discover compatible
bindings on the deployed instance. Never assume a model/provider combination
works merely because both appear in separate lists.

Prefer the governance-aware hire endpoint for a new agent:

```text
POST /api/companies/{companyId}/agent-hires
```

Construct the body using discovered values:

- `name`, `role`, `title`, `reportsTo`, `capabilities`, and a supported `icon`.
- `adapterType`, adapter-specific `adapterConfig`, and `defaultEnvironmentId`
  when supported and needed for the selected environment.
- `runtimeConfig.aiConnection` for the resolved managed connection, if used.
- `runtimeConfig.heartbeat: {"enabled": false, "wakeOnDemand": true}` for a new
  routine-driven agent when supported. Preserve existing agents' other schedules.
- `instructionsBundle.files["AGENTS.md"]` for managed-instruction adapters:
  a focused maintenance role, repository rules, bounded execution, normal
  Paperclip task lifecycle, and the user's PR/merge authority. Do not use legacy
  prompt-template config when managed instructions are supported.
- `desiredSkills` with installed company skill references when applicable.
- `budgetMonthlyCents` for the user-selected monthly budget, and `sourceIssueId`
  only when a real source issue exists.

Use the installed `paperclip-create-agent` skill for its detailed role-template
and hiring workflow when available. Read the response's `agent` and `approval`.
A pending hire is not runnable; leave activation pending and link the approval.
Do not use direct creation to evade governance. Preserve existing agents'
instructions, permissions, connection, and budgets unless changes are authorized.

The adapter probe is:

```text
POST /api/companies/{companyId}/adapters/{adapterType}/test-environment
```

Its current body accepts `adapterConfig`, optional `agentId`, `aiConnection`, and
`environmentId`. Supply the actual execution environment: omitting it can test
the Paperclip host instead of the worker. Inspect the probe's diagnostics; an
HTTP success alone is insufficient. Use supported runtime checks to verify
repository/skill readability and Git-host identity/permissions without publishing
a throwaway PR. Report any capability not exercised; leave unresolved access
blocked rather than claiming a successful maintenance run.

## Make the maintenance skill available

Choose either verified repository delivery or company installation:

- **Repository:** verify the full skill directory is committed and reachable on
  the selected checkout ref, including references/scripts. Use the worker's
  workspace-relative path, never the setup machine's absolute path. Document
  whether the worker follows that branch or an explicitly pinned version.
- **Company library:** inspect `GET /api/companies/{companyId}/skills`; reuse the
  exact installed skill when suitable. For an external source, use
  `POST /api/companies/{companyId}/skills/import` with `{"source":"<source>"}`.
  For a catalog skill, discover it via `GET /api/skills/catalog`, then use
  `POST /api/companies/{companyId}/skills/install-catalog` with its returned
  `catalogSkillId`. Local import paths must exist on the importing server.

Read back the installed skill's `SKILL.md` and required resources. Installation
is separate from assignment. Attach with:

```text
POST /api/agents/{agentId}/skills/sync
{"mode":"add","desiredSkills":["<resolved-company-skill-key>"]}
```

Verify through `GET /api/agents/{agentId}/skills`. Use `add` to preserve other
assignments; do not replace the full set for a single maintenance task.

## Create a paused routine and disabled trigger

Serialize the complete run instructions as `description` with real newlines.
Do not interpolate untrusted prose into a shell command. A JSON file or structured
tool argument avoids shell expansion. Replace every placeholder before sending.

```text
POST /api/companies/{companyId}/routines
```

```json
{
  "title": "<maintenance name>",
  "description": "<complete instructions from run-instructions.md>",
  "assigneeAgentId": "<agent-uuid>",
  "projectId": "<project-uuid>",
  "status": "paused",
  "concurrencyPolicy": "skip_if_active",
  "catchUpPolicy": "skip_missed",
  "activityGatePolicy": "always",
  "activityGateScope": "project"
}
```

The server derives `responsibleUserId` from the authorized user/parent-issue
context; it is not an arbitrary create-body field. Verify that attribution on
read-back. If an agent caller has no resolvable responsible user, use an
appropriate authorized parent-issue context or operator setup rather than
inventing a user ID.

`skip_if_active` avoids overlapping run issues; `coalesce_if_active` is another
supported choice if the user wants firings associated with current work. Neither
limits outstanding GitHub PRs: the run instructions must enforce that separately.
Use `always` for literal nightly execution. Paperclip's external-activity gate
tracks Paperclip activity, not Git commits; do not use it as a repository-change
detector. The worker can cheaply check whether new repository work exists.

The routine schema does not accept arbitrary workspace settings. Inspect the
project's execution policy and verify the worker gets the intended repository
and isolation. Do not assume workspace overrides on one manual run will persist
for future scheduled runs. Prefer an existing suitable project/workspace; if
provisioning one is needed, resolve that scope and use its advertised API.

```text
POST /api/routines/{routineId}/triggers
```

Schedule example, **only if the user selected 02:00 America/Chicago**:

```json
{"kind":"schedule","enabled":false,"cronExpression":"0 2 * * *","timezone":"America/Chicago"}
```

Cron uses five fields. Inspect the server's next run time and daylight-saving
behavior for the chosen timezone; do not promise a fixed 24-hour interval.

For webhooks, use the supported signing scheme, for example:

```json
{"kind":"webhook","enabled":false,"signingMode":"hmac_sha256","replayWindowSec":300}
```

Use the response's trigger ID, webhook URL, and secret material; do not fabricate
them. Store signing secrets through the supported secret/connection flow without
printing the response's secret fields. Configure the sender only within the
user's authorization. Inspect the deployed signing protocol, event filter, and
replay behavior; a generic Paperclip webhook is not automatically compatible
with every provider's event signature. Keep it disabled if the sender is not ready.

For manual/API use, the trigger body is `{"kind":"api","enabled":false}`.
API triggers require callers; they do not create a timer.

## Read back, activate, and report

Read `GET /api/routines/{routineId}` and verify the complete saved description,
assignee, project, policies, trigger, and absence of unintended extra triggers.
Keep a setup receipt of IDs and completed steps. If a create response is lost,
reconcile existing records before retrying; these create calls should not be
assumed idempotent. A run endpoint's idempotency key does not protect setup calls.

Once ready and authorized:

```text
PATCH /api/routine-triggers/{triggerId}
{"enabled":true}

PATCH /api/routines/{routineId}
{"status":"active"}
```

Read back again. If activation fails, leave the routine paused; report the
existing resources and exact next step. Do not delete a reused agent or project
as cleanup for partial setup.

Only for an authorized immediate trial:

```text
POST /api/routines/{routineId}/run
{"source":"manual","idempotencyKey":"<stable-key-for-this-one-trial>"}
```

This starts real work and can dispatch even while the routine is paused; it is
not a dry-run API. Reuse the key only for retries of that trial. Inspect
`GET /api/routines/{routineId}/runs?limit=10` and the returned execution issue:
queued, coalesced, or skipped is not a successful maintenance run. A bounded trial
must either return the promised PR/no-change result or a specific failure.

To stop future automatic work, `PATCH /api/routines/{routineId}` with
`{"status":"paused"}`. Pausing does not cancel an already dispatched issue/run;
inspect that separately if the user requests a full stop. Archiving is terminal,
so use pause for reversible suspension.

Prefer returned UI links. Otherwise resolve the company's actual URL prefix and
build links under the verified web base: `/{prefix}/agents/{agent-key-or-id}`,
`/{prefix}/projects/{project-key-or-id}`, `/{prefix}/routines/{routineId}`, and
`/{prefix}/issues/{identifier}`. Never substitute an API bridge URL for a web link.

## Source anchors

These shapes were checked against Paperclip source revision
`c65fc9e3c81c41aafe421aa90a00514b84343285`. When available in the target repository,
inspect `packages/shared/src/validators/{agent,routine,project}.ts`,
`packages/shared/src/ai-connections.ts`, `server/src/routes/{agents,routines,ai-connections}.ts`,
and `server/src/services/routines.ts`. The deployed instance's schemas and access
checks remain authoritative. This skill does not require those source files
to be installed alongside it.
