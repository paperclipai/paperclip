# CLI Reference

Paperclip CLI now supports both:

- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`, `env-lab`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Base Usage

Use repo script in development:

```sh
pnpm paperclipai --help
```

First-time local bootstrap + run:

```sh
pnpm paperclipai run
```

Choose local instance:

```sh
pnpm paperclipai run --instance dev
```

## Deployment Modes

Mode taxonomy and design intent are documented in `doc/DEPLOYMENT-MODES.md`.

Current CLI behavior:

- `paperclipai onboard` and `paperclipai configure --section server` set deployment mode in config
- server onboarding/configure ask for reachability intent and write `server.bind`
- `paperclipai run --bind <loopback|lan|tailnet>` passes a quickstart bind preset into first-run onboarding when config is missing
- runtime can override mode with `PAPERCLIP_DEPLOYMENT_MODE`
- `paperclipai run` and `paperclipai doctor` still do not expose a direct low-level `--mode` flag

Canonical behavior is documented in `doc/DEPLOYMENT-MODES.md`.

Allow an authenticated/private hostname (for example custom Tailscale DNS):

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

Bring up the default local SSH fixture for environment testing:

```sh
pnpm paperclipai env-lab up
pnpm paperclipai env-lab doctor
pnpm paperclipai env-lab status --json
pnpm paperclipai env-lab down
```

All client commands support:

- `--data-dir <path>`
- `--api-base <url>`
- `--api-key <token>`
- `--context <path>`
- `--profile <name>`
- `--json`

Company-scoped commands also support `--company-id <id>`.

API base resolution order:

1. `--api-base <url>`
2. `PAPERCLIP_API_URL`
3. selected context profile `apiBase`
4. local Paperclip config server port
5. `http://localhost:3100`

Connection failures include the attempted URL and a `GET /api/health` check hint.

## Connect Wizard

```sh
pnpm paperclipai connect
```

`connect` confirms the resolved API base, verifies `GET /api/health`, authenticates board access when needed, and saves a persona-aware profile:

- `persona=board` for board operator profiles
- `persona=agent` with `agentId` and `agentName` for agent profiles

Profiles store token env-var names, not plaintext tokens. The wizard prints shell exports for the newly created token.

Use `--data-dir` on any CLI command to isolate all default local state (config/context/db/logs/storage/secrets) away from `~/.paperclip`:

```sh
pnpm paperclipai run --data-dir ./tmp/paperclip-dev
pnpm paperclipai issue list --data-dir ./tmp/paperclip-dev
```

## Context Profiles

Store local defaults in `~/.paperclip/context.json`:

```sh
pnpm paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
pnpm paperclipai context set --persona agent --agent-id <agent-id> --api-key-env-var-name PAPERCLIP_API_KEY
pnpm paperclipai context show
pnpm paperclipai context list
pnpm paperclipai context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
pnpm paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

## Company Commands

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>
pnpm paperclipai company current [--company-id <company-id>]
pnpm paperclipai company stats
pnpm paperclipai company create --payload-json '{...}'
pnpm paperclipai company update <company-id> --payload-json '{...}'
pnpm paperclipai company branding:update <company-id> --payload-json '{...}'
pnpm paperclipai company archive <company-id>
pnpm paperclipai company export <company-id> --out ./company --include company,agents,projects,issues,skills
pnpm paperclipai company export:preview <company-id> --payload-json '{...}'
pnpm paperclipai company export:api <company-id> --payload-json '{...}'
pnpm paperclipai company import ./company --target new --new-company-name "Imported Company"
pnpm paperclipai company import:preview <company-id> --payload-json '{...}'
pnpm paperclipai company import:apply <company-id> --payload-json '{...}'
pnpm paperclipai company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
pnpm paperclipai company delete PAP --yes --confirm PAP
pnpm paperclipai company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
```

Notes:

- With agent authentication, `company list` and `company current` are
  agent-safe company selectors. `company list` first tries the board-wide list;
  if that is forbidden, it uses `--company-id`, `PAPERCLIP_COMPANY_ID`, context,
  or `/api/agents/me` and then reads only that scoped company.
- `company create` requires board/instance-admin authentication because it is
  an instance-wide setup command.
- Deletion is server-gated by `PAPERCLIP_ENABLE_COMPANY_DELETION`.
- With agent authentication, company deletion is company-scoped. Use the current company ID/prefix (for example via `--company-id` or `PAPERCLIP_COMPANY_ID`), not another company.

## Issue Commands

```sh
pnpm paperclipai issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
pnpm paperclipai issue get <issue-id-or-identifier>
pnpm paperclipai issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
pnpm paperclipai issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm paperclipai issue delete <issue-id> --yes
pnpm paperclipai issue comment <issue-id> --body "..." [--reopen]
pnpm paperclipai issue comments <issue-id> [--limit 50]
pnpm paperclipai issue comment:get <issue-id> <comment-id>
pnpm paperclipai issue comment:delete <issue-id> <comment-id>
pnpm paperclipai issue runs <issue-id-or-identifier>
pnpm paperclipai issue live-runs <issue-id-or-identifier>
pnpm paperclipai issue active-run <issue-id-or-identifier>
pnpm paperclipai issue heartbeat-context <issue-id>
pnpm paperclipai issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
pnpm paperclipai issue release <issue-id>
pnpm paperclipai issue force-release <issue-id>
```

Issue subresources are exposed as Paperclip API wrappers. Commands that map to broad server schemas accept JSON payloads and validate them with shared schemas before sending.

```sh
pnpm paperclipai issue child:create <issue-id> --payload-json '{"title":"Child task"}'
pnpm paperclipai issue approvals <issue-id>
pnpm paperclipai issue approval:link <issue-id> <approval-id>
pnpm paperclipai issue approval:unlink <issue-id> <approval-id>
pnpm paperclipai issue read <issue-id>
pnpm paperclipai issue unread <issue-id>
pnpm paperclipai issue archive <issue-id>
pnpm paperclipai issue unarchive <issue-id>
pnpm paperclipai issue recovery-actions <issue-id>
pnpm paperclipai issue recovery:resolve <issue-id> --outcome restored --source-issue-status todo
```

```sh
pnpm paperclipai issue documents <issue-id> [--include-system]
pnpm paperclipai issue document:get <issue-id> <key>
pnpm paperclipai issue document:put <issue-id> <key> --body-file ./plan.md [--title Plan]
pnpm paperclipai issue document:lock <issue-id> <key>
pnpm paperclipai issue document:unlock <issue-id> <key>
pnpm paperclipai issue document:revisions <issue-id> <key>
pnpm paperclipai issue document:restore <issue-id> <key> <revision-id>
pnpm paperclipai issue document:delete <issue-id> <key>
```

```sh
pnpm paperclipai issue work-products <issue-id>
pnpm paperclipai issue work-product:create <issue-id> --payload-json '{"type":"pull_request","provider":"github","title":"PR"}'
pnpm paperclipai issue work-product:update <work-product-id> --payload-json '{"status":"archived"}'
pnpm paperclipai issue work-product:delete <work-product-id>
pnpm paperclipai issue interactions <issue-id>
pnpm paperclipai issue interaction:create <issue-id> --payload-json '{"kind":"request_confirmation","payload":{"version":1,"prompt":"Continue?"}}'
pnpm paperclipai issue interaction:accept <issue-id> <interaction-id> [--selected-client-keys key1,key2]
pnpm paperclipai issue interaction:reject <issue-id> <interaction-id> [--reason "..."]
pnpm paperclipai issue interaction:respond <issue-id> <interaction-id> --answers-json '[{"questionId":"q1","optionIds":["yes"]}]'
pnpm paperclipai issue interaction:cancel <issue-id> <interaction-id> [--reason "..."]
```

```sh
pnpm paperclipai issue tree-state <issue-id>
pnpm paperclipai issue tree-preview <issue-id> --payload-json '{"mode":"pause"}'
pnpm paperclipai issue tree-holds <issue-id> [--status active] [--include-members]
pnpm paperclipai issue tree-hold:create <issue-id> --payload-json '{"mode":"pause","reason":"review"}'
pnpm paperclipai issue tree-hold:get <issue-id> <hold-id>
pnpm paperclipai issue tree-hold:release <issue-id> <hold-id> [--payload-json '{"reason":"done"}']
pnpm paperclipai issue attachments <issue-id>
pnpm paperclipai issue attachment:upload <issue-id> --company-id <company-id> --file ./artifact.txt
pnpm paperclipai issue attachment:download <attachment-id> [--out ./artifact.txt]
pnpm paperclipai issue attachment:delete <attachment-id>
pnpm paperclipai issue label:list --company-id <company-id>
pnpm paperclipai issue label:create --company-id <company-id> --name bug --color '#ff0000'
pnpm paperclipai issue label:delete <label-id>
pnpm paperclipai issue feedback:votes <issue-id>
pnpm paperclipai issue feedback:vote <issue-id> --payload-json '{"targetType":"issue_comment","targetId":"...","vote":"up"}'
```

## Project Commands

```sh
pnpm paperclipai project list --company-id <company-id>
pnpm paperclipai project get <project-id-or-shortname> [--company-id <company-id>]
pnpm paperclipai project create --company-id <company-id> --name "Launch Site" [--goal-ids <id1,id2>] [--lead-agent-id <id>]
pnpm paperclipai project update <project-id-or-shortname> [--status in_progress] [--company-id <company-id>]
pnpm paperclipai project delete <project-id-or-shortname> --yes [--company-id <company-id>]
```

Advanced project fields accept JSON:

```sh
pnpm paperclipai project create --company-id <company-id> --name "Ops" --env-json '{"OPENAI_API_KEY":{"kind":"secret","secretName":"openai-api-key"}}'
pnpm paperclipai project update <project-id> --execution-workspace-policy-json '{"enabled":true,"defaultMode":"shared_workspace"}'
```

## Goal Commands

```sh
pnpm paperclipai goal list --company-id <company-id>
pnpm paperclipai goal get <goal-id>
pnpm paperclipai goal create --company-id <company-id> --title "Grow revenue" [--level company] [--status active]
pnpm paperclipai goal update <goal-id> [--title "..."] [--status achieved]
pnpm paperclipai goal delete <goal-id> --yes
```

## Agent Commands

```sh
pnpm paperclipai agent list --company-id <company-id>
pnpm paperclipai agent get <agent-id>
pnpm paperclipai agent create --company-id <company-id> --payload-json '{"name":"Builder","adapterType":"codex_local"}'
pnpm paperclipai agent hire --company-id <company-id> --payload-json '{...}'
pnpm paperclipai agent update <agent-id> --payload-json '{"title":"Senior Builder"}'
pnpm paperclipai agent delete <agent-id> --yes
pnpm paperclipai agent me
pnpm paperclipai agent inbox
pnpm paperclipai agent inbox-mine --user-id <board-user-id>
pnpm paperclipai agent wake <agent-id-or-shortname> [--company-id <company-id>] [--reason "..."] [--payload '{"issueId":"..."}']
pnpm paperclipai agent pause <agent-id>
pnpm paperclipai agent resume <agent-id>
pnpm paperclipai agent approve <agent-id>
pnpm paperclipai agent terminate <agent-id>
pnpm paperclipai agent heartbeat:invoke <agent-id>
pnpm paperclipai agent claude-login <agent-id>
pnpm paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

Agent configuration and runtime endpoints:

```sh
pnpm paperclipai agent permissions:update <agent-id> --payload-json '{"canCreateAgents":true,"canAssignTasks":true}'
pnpm paperclipai agent configuration <agent-id>
pnpm paperclipai agent config-revisions <agent-id>
pnpm paperclipai agent config-revision:get <agent-id> <revision-id>
pnpm paperclipai agent config-revision:rollback <agent-id> <revision-id>
pnpm paperclipai agent runtime-state <agent-id>
pnpm paperclipai agent runtime-state:reset-session <agent-id> [--task-key <key>]
pnpm paperclipai agent task-sessions <agent-id>
pnpm paperclipai agent skills <agent-id>
pnpm paperclipai agent skills:sync <agent-id> --desired-skills paperclip,github
pnpm paperclipai agent instructions-path:update <agent-id> --payload-json '{"path":"/path/to/AGENTS.md"}'
pnpm paperclipai agent instructions-bundle <agent-id>
pnpm paperclipai agent instructions-bundle:update <agent-id> --payload-json '{"mode":"managed"}'
pnpm paperclipai agent instructions-file:get <agent-id> --path AGENTS.md
pnpm paperclipai agent instructions-file:put <agent-id> --path AGENTS.md --content-file ./AGENTS.md
pnpm paperclipai agent instructions-file:delete <agent-id> --path AGENTS.md
```

`agent local-cli` is the quickest way to run local Claude/Codex manually as a Paperclip agent:

- creates a new long-lived agent API key
- installs missing Paperclip skills into `~/.codex/skills` and `~/.claude/skills`
- prints `export ...` lines for `PAPERCLIP_API_URL`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_AGENT_ID`, and `PAPERCLIP_API_KEY`

Example for shortname-based local setup:

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

## Token Commands

Agent API keys are scoped to one company and one agent. Plaintext tokens are printed once at creation.

```sh
pnpm paperclipai token agent create --company-id <company-id> --agent <agent-id-or-name> --name external-worker
pnpm paperclipai token agent list --company-id <company-id> --agent <agent-id-or-name>
pnpm paperclipai token agent revoke --company-id <company-id> --agent <agent-id-or-name> <key-id>
```

Named board API keys use the board authorization model, support revocation and expiration metadata, and are audited server-side.

```sh
pnpm paperclipai token board create --company-id <company-id> --name external-admin
pnpm paperclipai token board create --name short-lived --ttl-days 7
pnpm paperclipai token board list
pnpm paperclipai token board revoke <key-id>
```

## Run Commands

`paperclipai run` without a subcommand still bootstraps and starts a local Paperclip instance. The subcommands below inspect and control API heartbeat runs.

```sh
pnpm paperclipai run list --company-id <company-id> [--agent-id <agent-id>] [--limit 50]
pnpm paperclipai run live --company-id <company-id> [--limit 50] [--min-count 0]
pnpm paperclipai run get <run-id>
pnpm paperclipai run events <run-id> [--after-seq 0] [--limit 200]
pnpm paperclipai run log <run-id> [--offset 0] [--limit-bytes 16384] [--text]
pnpm paperclipai run cancel <run-id>
pnpm paperclipai run issues <run-id>
pnpm paperclipai run workspace-operations <run-id>
pnpm paperclipai run workspace-log <operation-id> [--offset 0] [--limit-bytes 16384] [--text]
pnpm paperclipai run watchdog-decision <run-id> --decision continue [--reason "..."]
```

## Routine Commands

`paperclipai routines disable-all` remains the local maintenance command. The singular `routine` group maps to the REST API.

```sh
pnpm paperclipai routine list --company-id <company-id> [--project-id <project-id>]
pnpm paperclipai routine create --company-id <company-id> --payload-json '{...}'
pnpm paperclipai routine get <routine-id>
pnpm paperclipai routine update <routine-id> --payload-json '{...}'
pnpm paperclipai routine revisions <routine-id>
pnpm paperclipai routine revision:restore <routine-id> <revision-id>
pnpm paperclipai routine runs <routine-id> [--limit 50]
pnpm paperclipai routine run <routine-id> [--payload-json '{...}']
pnpm paperclipai routine trigger:create <routine-id> --payload-json '{...}'
pnpm paperclipai routine trigger:update <trigger-id> --payload-json '{...}'
pnpm paperclipai routine trigger:delete <trigger-id>
pnpm paperclipai routine trigger:rotate-secret <trigger-id>
pnpm paperclipai routine trigger:fire <public-id> [--payload-json '{...}']
```

## Prompt Handoff

Prompt handoff creates Paperclip work. It does not create a chat session.

```sh
pnpm paperclipai agent-prompt <agent-name-or-id> <agent-api-key> "Prompt here"
pnpm paperclipai agent prompt --agent <agent-name-or-id> --api-key-env PAPERCLIP_API_KEY "Prompt here"
pnpm paperclipai agent prompt --profile my-agent "Prompt here"
pnpm paperclipai board prompt --company-id <company-id> --agent <agent-name-or-id> "Prompt here"
```

By default the command creates a `todo` issue assigned to the target agent and wakes the agent. Use `--issue <issue-id>` to add a comment to existing work, and `--no-wake` to skip the wakeup.

## Skills Commands

`paperclipai skills` covers three distinct operations:

1. **Company install** — adds or updates a row in `company_skills` for the
   whole company. This is what `skills install`, `skills import`, `skills create`,
   and `skills scan-projects` do.
2. **Agent attach** — replaces an agent's *desired* company skill set
   (`skills agent sync`/`clear`). This is a desired-state operation on the
   agent's adapter config; it does not change the company library.
3. **Adapter runtime sync** — the adapter reconciles the desired skill set
   with files on disk and reports an `AgentSkillSnapshot` (`skills agent list`).
   `skills agent sync` triggers this automatically after updating desired state.

Required Paperclip runtime skills (heartbeat, etc.) remain server-enforced and
are added on top of whatever the desired set names.

### Catalog (app-shipped skills)

The Paperclip app ships a curated catalog under `@paperclipai/skills-catalog`.
Browse and inspect commands never mutate company state; `install` adds a catalog
skill to the company library.

```sh
pnpm paperclipai skills browse [--kind bundled|optional] [--category <slug>] [--query <text>]
pnpm paperclipai skills search "<text>" [--kind bundled|optional] [--category <slug>]
pnpm paperclipai skills inspect <catalog-id-or-key-or-slug>
pnpm paperclipai skills install <catalog-id-or-key-or-slug> [--as <slug>] [--force] --company-id <company-id>
```

Catalog semantics:

- **Bundled** skills live in `packages/skills-catalog/catalog/bundled/<category>/<slug>`
  and are recommended defaults for most companies. They use canonical key
  `paperclipai/bundled/<category>/<slug>`.
- **Optional** skills live in `packages/skills-catalog/catalog/optional/<category>/<slug>`
  and are role-specific or domain-specific (browser, AWS ops, etc.). Same key
  shape with `optional` in place of `bundled`.
- `skills install` materializes the catalog files into a company-managed skill
  directory and records provenance (`catalogId`, `catalogKey`, `packageVersion`,
  `originHash`, …) so future updates and audit decisions stay consistent.
- `--as <slug>` overrides the company skill slug. `--force` may replace a
  same-key catalog-managed skill but never bypasses hard validation or hard-stop
  audit findings.

Examples:

```sh
pnpm paperclipai skills browse --kind bundled --company-id <company-id>
pnpm paperclipai skills search "pull request" --kind bundled
pnpm paperclipai skills inspect github-pr-workflow
pnpm paperclipai skills install github-pr-workflow --company-id <company-id>
pnpm paperclipai skills install paperclipai:optional:browser:agent-browser --company-id <company-id>
```

External GitHub, skills.sh, local-path, and URL sources still go through
`skills import`; catalog commands are for the app-shipped catalog only.

### Company library

```sh
pnpm paperclipai skills list --company-id <company-id>
pnpm paperclipai skills show <skill-id-or-key-or-slug> --company-id <company-id>
pnpm paperclipai skills file <skill-id-or-key-or-slug> [--path SKILL.md] --company-id <company-id>
pnpm paperclipai skills import <source> --company-id <company-id>
pnpm paperclipai skills create --name "Review PRs" [--slug review-prs] [--description "..."] [--body-file SKILL.md] --company-id <company-id>
pnpm paperclipai skills scan-projects [--project-id <id>...] [--workspace-id <id>...] --company-id <company-id>
pnpm paperclipai skills check [skill-id-or-key-or-slug] --company-id <company-id>
pnpm paperclipai skills update <skill-id-or-key-or-slug> [--force] --company-id <company-id>
pnpm paperclipai skills update --all [--force] --company-id <company-id>
pnpm paperclipai skills audit [skill-id-or-key-or-slug] --company-id <company-id>
pnpm paperclipai skills reset <skill-id-or-key-or-slug> [--yes] [--force] --company-id <company-id>
pnpm paperclipai skills remove <skill-id-or-key-or-slug> --yes --company-id <company-id>
```

`skills import <source>` accepts a skills.sh URL, the equivalent
`<owner>/<repo>/<skill>` shorthand, a GitHub URL, a local path, or an
`npx skills add …` command. See `references/company-skills.md` in the agent
skill bundle for the source-type table.

`skills check`, `skills update`, `skills audit`, and `skills reset` are the
maintenance loop for catalog-installed skills:

- `check` reports whether each skill's installed bytes match its pinned origin
  (`hasUpdate`, `installedHash`, `originHash`, `updateHoldReason`,
  `auditVerdict`).
- `update` installs the pinned update through the existing install-update API.
  `--all` checks every company skill and updates only those with
  `hasUpdate=true`. `--force` discards local-modification or soft-audit holds;
  hard-stop audit findings still block the update.
- `audit` re-scans installed bytes and reports findings without executing
  anything.
- `reset` reinstalls a catalog-managed skill from its pinned origin, discarding
  local edits. Prompts in a TTY; requires `--yes` for non-interactive use.

### Agent attach

```sh
pnpm paperclipai skills agent list <agent-id-or-shortname> --company-id <company-id>
pnpm paperclipai skills agent sync <agent-id-or-shortname> --skill <skill-id-or-key-or-slug> [--skill <skill-id-or-key-or-slug>...] --company-id <company-id>
pnpm paperclipai skills agent clear <agent-id-or-shortname> --yes --company-id <company-id>
```

`skills agent sync` replaces the agent's non-required desired skill set (it is
not additive) and returns the resulting adapter `AgentSkillSnapshot`.
`skills agent clear` sends an empty desired list. Required Paperclip skills are
still enforced by the server in both cases.

### Notes

- Skill references accept company skill `id`, canonical `key`, or unique
  `slug`; catalog references accept catalog `id`, `key`, or unique `slug`.
- `skills file` prints raw file content in human mode so it can be piped.
- `skills create --body-file -` reads the skill markdown body from stdin.
- `skills remove`, `skills reset`, and `skills agent clear` prompt in a TTY and
  require `--yes` in non-interactive use.
- `--json` prints the raw API result for each command.

## Teams Commands

`paperclipai teams` works with the app-shipped team catalog in
`@paperclipai/teams-catalog`. Browse, search, inspect, and file reads do not
change company state. `preview` runs the company import planner, and `install`
imports the catalog team into an existing company.

```sh
pnpm paperclipai teams browse [--kind bundled|optional] [--category <slug>] [--query <text>]
pnpm paperclipai teams search "<text>" [--kind bundled|optional] [--category <slug>]
pnpm paperclipai teams inspect <catalog-id-or-key-or-slug> [--file TEAM.md]
pnpm paperclipai teams preview <catalog-id-or-key-or-slug> --company-id <company-id>
pnpm paperclipai teams install <catalog-id-or-key-or-slug> --company-id <company-id>
```

Preview/install options:

- Under agent authentication, use `paperclipai company list --json`,
  `paperclipai company current --json`, or `PAPERCLIP_COMPANY_ID` to select the
  target company. `company list` falls back to the scoped current company when
  board-wide listing is forbidden. `teams install` creates agents and therefore
  requires board authentication, an `agents:create` grant, or an agent with
  explicit `canCreateAgents` permission.
- `--request-approval-on-forbidden` turns a 403 install denial into a linked
  board approval request instead of a raw failed command; use
  `--approval-issue-id <id>` to attach it to a specific issue. During Paperclip
  task runs with `PAPERCLIP_TASK_ID` set, this fallback is automatic so
  agent-run walkthroughs leave a pending approval path instead of a raw 403.
- `--target-manager-agent-id <id>` or `--target-manager-slug <slug>` reparents
  catalog root agents under an existing manager.
- `--agent <slug>` and `--selected-file <path>` narrow the import.
- `--collision-strategy rename|skip|replace` controls name/key collisions.
- `--allow-external-sources`, `--allow-unpinned-optional-sources`, and
  `--allow-local-path-sources` explicitly opt into higher-trust source policy.
  Local-path sources are development-only and stay blocked unless that flag is
  passed.

## Secrets Commands

```sh
pnpm paperclipai secrets list --company-id <company-id>
pnpm paperclipai secrets declarations --company-id <company-id> [--include agents,projects] [--kind secret]
pnpm paperclipai secrets create --company-id <company-id> --name anthropic-api-key --value-env ANTHROPIC_API_KEY
pnpm paperclipai secrets link --company-id <company-id> --name prod-stripe-key --provider aws_secrets_manager --external-ref <provider-ref>
pnpm paperclipai secrets doctor --company-id <company-id>
pnpm paperclipai secrets provider-configs --company-id <company-id>
pnpm paperclipai secrets provider-config:create --company-id <company-id> --payload-json '{...}'
pnpm paperclipai secrets provider-config:discovery-preview --company-id <company-id> --payload-json '{...}'
pnpm paperclipai secrets provider-config:get <config-id>
pnpm paperclipai secrets provider-config:update <config-id> --payload-json '{...}'
pnpm paperclipai secrets provider-config:default <config-id>
pnpm paperclipai secrets provider-config:health <config-id>
pnpm paperclipai secrets provider-config:delete <config-id>
pnpm paperclipai secrets remote-import:preview --company-id <company-id> --payload-json '{...}'
pnpm paperclipai secrets remote-import --company-id <company-id> --payload-json '{...}'
pnpm paperclipai secrets migrate-inline-env --company-id <company-id> [--apply]
```

Secret listing and declarations never print secret values. `create` accepts
`--value-env` so shell history does not capture the value. `link` records
provider-owned references without copying the secret value into Paperclip.
For AWS-backed secrets, `secrets doctor` reports missing non-secret provider
env and the expected AWS SDK runtime credential source; do not store AWS
bootstrap credentials in Paperclip secrets.

Per-company provider vaults (multiple vault instances per provider, default
vault selection, coming-soon GCP/Vault) can be configured from the board UI under
`Company Settings → Secrets → Provider vaults` or through the provider-config CLI
commands above. See the
[secrets deploy guide](../docs/deploy/secrets.md#provider-vaults) and
[API reference](../docs/api/secrets.md#provider-vaults) for the contract.

## Approval Commands

```sh
pnpm paperclipai approval list --company-id <company-id> [--status pending]
pnpm paperclipai approval get <approval-id>
pnpm paperclipai approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm paperclipai approval approve <approval-id> [--decision-note "..."]
pnpm paperclipai approval reject <approval-id> [--decision-note "..."]
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."]
pnpm paperclipai approval resubmit <approval-id> [--payload '{"...":"..."}']
pnpm paperclipai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm paperclipai activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
pnpm paperclipai activity create --company-id <company-id> --payload-json '{...}'
pnpm paperclipai activity issue <issue-id>
```

## Dashboard Commands

```sh
pnpm paperclipai dashboard get --company-id <company-id>
```

## Org And Agent Config Commands

```sh
pnpm paperclipai whoami
pnpm paperclipai openapi
pnpm paperclipai org get --company-id <company-id>
pnpm paperclipai org svg --company-id <company-id> [--out org.svg]
pnpm paperclipai org png --company-id <company-id> [--out org.png]
pnpm paperclipai agent-config list --company-id <company-id>
```

## Access, Profile, And Instance Commands

```sh
pnpm paperclipai profile session
pnpm paperclipai profile get
pnpm paperclipai profile update --payload-json '{...}'
pnpm paperclipai profile company-user <user-slug> --company-id <company-id>
pnpm paperclipai invite list --company-id <company-id>
pnpm paperclipai invite create --company-id <company-id> --payload-json '{...}'
pnpm paperclipai invite revoke <invite-id>
pnpm paperclipai invite show <token>
pnpm paperclipai invite accept <token> [--payload-json '{...}']
pnpm paperclipai invite onboarding:text <token>
pnpm paperclipai join list --company-id <company-id> [--status pending_approval]
pnpm paperclipai join approve <request-id> --company-id <company-id>
pnpm paperclipai join reject <request-id> --company-id <company-id>
pnpm paperclipai join claim-key <request-id> --claim-secret <secret>
pnpm paperclipai member list --company-id <company-id>
pnpm paperclipai member update <member-id> --company-id <company-id> --payload-json '{...}'
pnpm paperclipai member role-and-grants <member-id> --company-id <company-id> --payload-json '{...}'
pnpm paperclipai member permissions <member-id> --company-id <company-id> --payload-json '{...}'
pnpm paperclipai member archive <member-id> --company-id <company-id> [--payload-json '{...}']
pnpm paperclipai admin user list [--query <text>]
pnpm paperclipai admin user promote <user-id>
pnpm paperclipai admin user demote <user-id>
pnpm paperclipai admin user company-access <user-id>
pnpm paperclipai admin user company-access:update <user-id> --payload-json '{...}'
```

CLI auth challenge endpoints are also exposed for tooling that needs the raw challenge lifecycle:

```sh
pnpm paperclipai auth challenge create --payload-json '{...}'
PAPERCLIP_CHALLENGE_SECRET=<challenge-secret> pnpm paperclipai auth challenge get <challenge-id> --token-env PAPERCLIP_CHALLENGE_SECRET
PAPERCLIP_CHALLENGE_SECRET=<challenge-secret> pnpm paperclipai auth challenge approve <challenge-id> --token-env PAPERCLIP_CHALLENGE_SECRET
PAPERCLIP_CHALLENGE_SECRET=<challenge-secret> pnpm paperclipai auth challenge cancel <challenge-id> --token-env PAPERCLIP_CHALLENGE_SECRET
pnpm paperclipai auth revoke-current
```

`--token <challenge-secret>` is still supported for compatibility, but `--token-env` avoids putting challenge secrets in shell history or process arguments.

## Instance Settings Commands

```sh
pnpm paperclipai instance scheduler-heartbeats
pnpm paperclipai instance settings:general
pnpm paperclipai instance settings:general:update --payload-json '{...}'
pnpm paperclipai instance settings:experimental
pnpm paperclipai instance settings:experimental:update --payload-json '{...}'
pnpm paperclipai instance database-backup
```

Experimental features are opt-in and are provided without compatibility guarantees. They may break, change, or be removed at any time. Use them at your own risk.

```sh
pnpm paperclipai sidebar preferences
pnpm paperclipai sidebar preferences:update --payload-json '{...}'
pnpm paperclipai sidebar project-preferences --company-id <company-id>
pnpm paperclipai sidebar project-preferences:update --company-id <company-id> --payload-json '{...}'
pnpm paperclipai sidebar badges --company-id <company-id>
pnpm paperclipai inbox dismissals --company-id <company-id>
pnpm paperclipai inbox dismiss --company-id <company-id> --payload-json '{"itemKey":"run:<run-id>"}'
pnpm paperclipai board-claim show <token>
pnpm paperclipai board-claim claim <token> [--payload-json '{...}']
pnpm paperclipai openclaw invite-prompt --company-id <company-id> --payload-json '{...}'
pnpm paperclipai available-skill list
pnpm paperclipai available-skill index
pnpm paperclipai available-skill get <skill-name>
pnpm paperclipai llm agent-configuration
pnpm paperclipai llm agent-configuration:adapter <adapter-type>
pnpm paperclipai llm agent-icons
```

## Adapter, Asset, And Skill Commands

```sh
pnpm paperclipai adapter list
pnpm paperclipai adapter install --payload-json '{"packageName":"@scope/adapter","version":"1.2.3"}'
pnpm paperclipai adapter get <adapter-type>
pnpm paperclipai adapter update <adapter-type> --payload-json '{"disabled":true}'
pnpm paperclipai adapter override <adapter-type> --payload-json '{"paused":true}'
pnpm paperclipai adapter reload <adapter-type>
pnpm paperclipai adapter reinstall <adapter-type>
pnpm paperclipai adapter delete <adapter-type>
pnpm paperclipai adapter config-schema <adapter-type>
pnpm paperclipai adapter ui-parser <adapter-type>
pnpm paperclipai adapter models <adapter-type> --company-id <company-id> [--refresh] [--environment-id <id>]
pnpm paperclipai adapter model-profiles <adapter-type> --company-id <company-id>
pnpm paperclipai adapter detect-model <adapter-type> --company-id <company-id>
pnpm paperclipai adapter test-environment <adapter-type> --company-id <company-id> --payload-json '{...}'
```

```sh
pnpm paperclipai asset image:upload --company-id <company-id> --file ./image.png [--namespace docs] [--alt "..."]
pnpm paperclipai asset logo:upload --company-id <company-id> --file ./logo.svg
pnpm paperclipai asset content <asset-id> --out ./asset.bin
```

```sh
pnpm paperclipai skill list --company-id <company-id>
pnpm paperclipai skill get <skill-id> --company-id <company-id>
pnpm paperclipai skill file <skill-id> --company-id <company-id> [--path SKILL.md]
pnpm paperclipai skill create --company-id <company-id> --payload-json '{...}'
pnpm paperclipai skill file:update <skill-id> --company-id <company-id> --payload-json '{...}'
pnpm paperclipai skill import --company-id <company-id> --payload-json '{"source":"github:owner/repo/path"}'
pnpm paperclipai skill scan-projects --company-id <company-id> --payload-json '{...}'
pnpm paperclipai skill update-status <skill-id> --company-id <company-id>
pnpm paperclipai skill install-update <skill-id> --company-id <company-id>
pnpm paperclipai skill delete <skill-id> --company-id <company-id>
```

## Cost, Finance, And Budget Commands

```sh
pnpm paperclipai cost summary --company-id <company-id>
pnpm paperclipai cost by-agent --company-id <company-id>
pnpm paperclipai cost by-agent-model --company-id <company-id>
pnpm paperclipai cost by-provider --company-id <company-id>
pnpm paperclipai cost by-biller --company-id <company-id>
pnpm paperclipai cost by-project --company-id <company-id>
pnpm paperclipai cost window-spend --company-id <company-id>
pnpm paperclipai cost quota-windows --company-id <company-id>
pnpm paperclipai cost issue <issue-id>
pnpm paperclipai cost event:create --company-id <company-id> --payload-json '{...}'
```

```sh
pnpm paperclipai finance event:create --company-id <company-id> --payload-json '{...}'
pnpm paperclipai finance events --company-id <company-id>
pnpm paperclipai finance summary --company-id <company-id>
pnpm paperclipai finance by-biller --company-id <company-id>
pnpm paperclipai finance by-kind --company-id <company-id>
pnpm paperclipai budget overview --company-id <company-id>
pnpm paperclipai budget policy:upsert --company-id <company-id> --payload-json '{...}'
pnpm paperclipai budget company:update --company-id <company-id> --payload-json '{...}'
pnpm paperclipai budget agent:update <agent-id> --payload-json '{...}'
pnpm paperclipai budget incident:resolve <incident-id> --company-id <company-id> [--payload-json '{...}']
```

## Workspace And Environment Commands

```sh
pnpm paperclipai workspace list --company-id <company-id>
pnpm paperclipai workspace get <execution-workspace-id>
pnpm paperclipai workspace close-readiness <execution-workspace-id>
pnpm paperclipai workspace operations <execution-workspace-id>
pnpm paperclipai workspace update <execution-workspace-id> --payload-json '{...}'
pnpm paperclipai workspace runtime-service <execution-workspace-id> start --payload-json '{...}'
pnpm paperclipai workspace runtime-command <execution-workspace-id> run --payload-json '{...}'
```

```sh
pnpm paperclipai environment list --company-id <company-id>
pnpm paperclipai environment capabilities --company-id <company-id>
pnpm paperclipai environment create --company-id <company-id> --payload-json '{...}'
pnpm paperclipai environment get <environment-id>
pnpm paperclipai environment leases <environment-id>
pnpm paperclipai environment lease <lease-id>
pnpm paperclipai environment update <environment-id> --payload-json '{...}'
pnpm paperclipai environment delete <environment-id>
pnpm paperclipai environment probe <environment-id>
pnpm paperclipai environment probe-config --company-id <company-id> --payload-json '{...}'
```

```sh
pnpm paperclipai project-workspace list <project-id>
pnpm paperclipai project-workspace create <project-id> --payload-json '{...}'
pnpm paperclipai project-workspace update <project-id> <workspace-id> --payload-json '{...}'
pnpm paperclipai project-workspace delete <project-id> <workspace-id>
pnpm paperclipai project-workspace runtime-service <project-id> <workspace-id> restart --payload-json '{...}'
pnpm paperclipai project-workspace runtime-command <project-id> <workspace-id> run --payload-json '{...}'
```

## Plugin Commands

Existing plugin lifecycle commands remain available: `plugin init`, `list`, `install`, `uninstall`, `enable`, `disable`, `inspect`, and `examples`.

```sh
pnpm paperclipai plugin ui-contributions
pnpm paperclipai plugin tools
pnpm paperclipai plugin tool:execute --payload-json '{...}'
pnpm paperclipai plugin health <plugin-id>
pnpm paperclipai plugin logs <plugin-id>
pnpm paperclipai plugin upgrade <plugin-id>
pnpm paperclipai plugin config <plugin-id>
pnpm paperclipai plugin config:set <plugin-id> --payload-json '{"configJson":{...}}'
pnpm paperclipai plugin config:test <plugin-id> --payload-json '{"configJson":{...}}'
pnpm paperclipai plugin jobs <plugin-id>
pnpm paperclipai plugin job:runs <plugin-id> <job-id>
pnpm paperclipai plugin job:trigger <plugin-id> <job-id> [--payload-json '{...}']
pnpm paperclipai plugin webhook <plugin-id> <endpoint-key> [--payload-json '{...}']
pnpm paperclipai plugin dashboard <plugin-id>
pnpm paperclipai plugin bridge:data <plugin-id> --payload-json '{...}'
pnpm paperclipai plugin bridge:action <plugin-id> --payload-json '{...}'
pnpm paperclipai plugin bridge:stream <plugin-id> <channel> [--duration-ms 10000]
pnpm paperclipai plugin data <plugin-id> <key> --payload-json '{...}'
pnpm paperclipai plugin action <plugin-id> <key> --payload-json '{...}'
pnpm paperclipai plugin local-folders <plugin-id> --company-id <company-id>
pnpm paperclipai plugin local-folder:status <plugin-id> <folder-key> --company-id <company-id>
pnpm paperclipai plugin local-folder:validate <plugin-id> <folder-key> --company-id <company-id> [--payload-json '{...}']
pnpm paperclipai plugin local-folder:set <plugin-id> <folder-key> --company-id <company-id> --payload-json '{...}'
```

Feedback traces can be fetched directly by ID when automating export workflows:

```sh
pnpm paperclipai feedback trace <trace-id>
pnpm paperclipai feedback bundle <trace-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
pnpm paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
```

## Local Storage Defaults

Local Paperclip data lives under the selected instance root. `PAPERCLIP_HOME` chooses the home directory and `PAPERCLIP_INSTANCE_ID` chooses the instance.

```text
~/.paperclip/                                     # PAPERCLIP_HOME
└── instances/
    └── default/                                  # instance root (PAPERCLIP_INSTANCE_ID)
        ├── config.json                           # runtime config
        ├── .env                                  # instance env file
        ├── db/                                   # embedded PostgreSQL data
        ├── data/
        │   ├── storage/                          # local_disk uploads
        │   └── backups/                          # automatic DB backups
        ├── logs/
        ├── secrets/
        │   └── master.key                        # local_encrypted master key
        ├── workspaces/                           # default agent workspaces
        ├── projects/                             # project execution workspaces
        ├── companies/                            # per-company adapter homes (e.g. codex-home)
        └── codex-home/                           # per-instance codex home (when not company-scoped)
```

Default paths for the canonical install:

- config: `~/.paperclip/instances/default/config.json`
- embedded db: `~/.paperclip/instances/default/db`
- logs: `~/.paperclip/instances/default/logs`
- storage: `~/.paperclip/instances/default/data/storage`
- secrets key: `~/.paperclip/instances/default/secrets/master.key`

Override base home or instance with env vars:

```sh
PAPERCLIP_HOME=/custom/home PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

## Storage Configuration

Configure storage provider and settings:

```sh
pnpm paperclipai configure --section storage
```

Supported providers:

- `local_disk` (default; local single-user installs)
- `s3` (S3-compatible object storage)
