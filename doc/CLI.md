# CLI Reference

Paperclip CLI now supports both:

- installation and lifecycle management (`install`, `uninstall`, `update`, `upgrade`, `service`)
- instance setup/diagnostics (`onboard`, `doctor`, `configure`, `env`, `allowed-hostname`, `env-lab`)
- control-plane client operations (issues, approvals, agents, activity, dashboard)

## Security: safe invocation for content-bearing arguments

Use `npx paperclipai` for any command whose argument can hold untrusted or
semi-trusted content. Untrusted content includes issue text, comment bodies,
Markdown, pasted snippets, and model output. `npx` runs the CLI binary directly.
It passes the argument as an inert `argv` value. It does not run a shell over the
value. `npx paperclipai` works on any machine with Node: it runs a local install
of the `paperclipai` package, and it fetches the published package when no local
install is present.

Do not use `pnpm paperclipai` for a content-bearing argument. `pnpm paperclipai`
is a `package.json` script. `pnpm` builds a `/bin/sh` command string and appends
the argument to it, so the shell reads the argument first. The shell interprets
these spans before the CLI starts:

- command substitution: a backtick pair or `$( )`
- variable expansion: `$NAME` or `${NAME}` (this can leak a secret value into the persisted argument)

A crafted value can run an arbitrary command as the invoking user. A crafted
value can also expand an environment variable into the stored argument. No
CLI-side check stops this, because the shell runs before `cli/src` starts. This
is true even when the argument comes from a quoted shell variable, because `pnpm`
re-evaluates the value in its own shell.

Safe forms:

- `npx paperclipai <command> <args>` — the documented default. It passes an inert
  `argv` value and runs on any machine.
- `node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts <command> <args>` —
  the safe form to run the local source from a monorepo checkout. It is the exact
  command that the `pnpm paperclipai` script wraps, but it runs directly, so no
  shell reads the argument. Use it when you must test your local `cli/src`
  changes with a content-bearing argument.

Unsafe or broken forms:

- `pnpm paperclipai <command> <args>` — unsafe. `pnpm` runs the argument through a
  shell first.
- `pnpm run <script> -- <args>`, or any `package.json` script that wraps the CLI —
  unsafe for the same reason.
- `pnpm exec paperclipai <command> <args>` — broken. The root workspace does not
  depend on the `paperclipai` package, so `pnpm` does not link its binary into
  `node_modules/.bin`. The command fails with `Command "paperclipai" not found`,
  even after a build. Do not use it.

Static placeholders only: a document must show a static placeholder such as
`<host>` in a command example, never a live `$( )` or `$NAME` span. The reader's
own shell expands such a span on paste, before any CLI or `npx` receives argv, so
a direct-exec form does not stop it.

`pnpm paperclipai` stays acceptable only for a fully literal local lifecycle or
setup command. A fully literal command carries no substitutable value. It has no
placeholder, no example value the reader replaces, no interpolation, no path, no
ref, no id, and no name. It holds the subcommand and, at most, flags that take no
value.

The allowlist of literal commands lives in one place:
`server/src/__tests__/cli-invocation-safety.test.ts`. A guard test enforces it
fail-closed. Any `pnpm paperclipai` line whose command string is not an exact
allowlist entry is an offender. The allowlist holds commands such as `run`,
`onboard`, `onboard --yes`, `doctor`, `configure --section <name>`, `connect`,
`env-lab up`, `env-lab down`, `context show`, `context list`,
`worktree ensure-seeded`, and `worktree env`.

Every invocation that carries a positional value or an option value uses
`npx paperclipai` instead. This covers a hostname (`allowed-hostname`), an import
URL or folder (`company import`), an identifier or secret (`--company-id`,
`--agent-id`, `--claim-secret`), a payload (`--payload-json`), free text
(`--body`, `--title`, `--comment`), a data directory (`--data-dir`), an instance
(`--instance`), a bind preset (`--bind`), a context-profile name, and every
worktree path, ref, id, or name option. A runtime value counts as non-fixed even
when it looks safe. The private-hostname guard builds `allowed-hostname <value>`
from the request Host header, so it uses `npx paperclipai`.

For a command that must run the local checked-out source with a value, use the
direct-exec form: `node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts
<command> <args>`.

The `pnpm --filter @paperclipai/*` build and test commands are not CLI
invocation. They do not change.

### Offline and air-gapped use

`npx paperclipai` runs offline when the `paperclipai` package is already in a
local install or in the npm cache. It reaches the network only when the package
is in neither place.

To force cache-only resolution and block any network attempt, run
`npx --offline paperclipai <command> <args>`. Use `npx --prefer-offline
paperclipai` when you accept a fetch only for a missing package.

To prepare an air-gapped host, install the package one time while the host is
online. Run `npm install -g paperclipai`, or run the documented `install.sh`
path. After that step, both `npx paperclipai` and the installed `paperclipai`
binary run offline. Both pass an inert `argv` value.

To move the package without a registry, run `npm pack paperclipai` on an online
host. Copy the tarball to the air-gapped host. Run `npm install -g
./paperclipai-<version>.tgz`.

Do not use `pnpm paperclipai` as an offline fallback for a content-bearing
argument. It runs the argument through a shell first, offline or online. It also
resolves only inside a monorepo checkout.

A monorepo contributor who works offline uses the direct-exec form that this
section documents above: `node cli/node_modules/tsx/dist/cli.mjs
cli/src/index.ts <command> <args>`. It passes an inert `argv` value and runs the
local source.

## Base Usage

Use repo script in development:

```sh
pnpm paperclipai --help
```

Recommended installation and interactive onboarding:

```sh
curl -fsSLO https://paperclip.ing/install.sh
curl -fsSLO https://paperclip.ing/install.sh.sha256
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c install.sh.sha256
else
  shasum -a 256 -c install.sh.sha256
fi
bash install.sh
```

The checksum detects transfer or publishing mistakes but is served from the
same origin as the installer. Use a release-tag or commit-pinned GitHub copy
when you need an independently hosted source. Piped installs require supported
Node.js, npm, and npx to already be installed; download the script first before
allowing it to bootstrap Node.js with privileged package-manager commands.

First-time local bootstrap from a source checkout:

```sh
pnpm paperclipai run
```

Choose local instance:

```sh
npx paperclipai run --instance dev
```

## Install, Update, And Uninstall

Managed installs keep CLI payloads under `~/.paperclip/cli`, expose a stable
`~/.local/bin/paperclipai` shim, switch versions atomically, and retain two
previous payloads for rollback.

```sh
paperclipai install
paperclipai install --canary
paperclipai install --version <version>
paperclipai install --ref <branch|tag|sha> [--repo owner/repo]
paperclipai update
paperclipai update --latest|--canary|--version <version>
paperclipai update --rollback
paperclipai upgrade
paperclipai uninstall
```

`upgrade` aliases `update`. `uninstall` removes managed code and the shim but
preserves instance data under `~/.paperclip/instances/`. See
`doc/INSTALLING.md` for installation methods, security notes, PATH setup, and
the complete update and rollback behavior.

## Onboarding And Service Management

Interactive onboarding offers to install a background service on supported
platforms. `--yes` never installs it implicitly; automation must opt in.

```sh
paperclipai onboard
paperclipai onboard --yes
paperclipai onboard --yes --install-service
paperclipai onboard --yes --no-install-service
```

Service lifecycle commands remain under the `service` namespace:

```sh
paperclipai service install [--no-start-now] [--no-start-on-login]
paperclipai service uninstall
paperclipai service start
paperclipai service stop
paperclipai service restart [--wait]
paperclipai service status [--json]
paperclipai service logs [-f]
```

Every service verb supports `--instance <id>` and `--json`. Linux and WSL2 use
a systemd user unit when available; macOS uses a LaunchAgent. Unsupported
environments receive foreground `paperclipai run` guidance.

`paperclipai doctor` includes managed-install and service-health diagnostics in
addition to configuration, storage, database, logging, and port checks.

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
npx paperclipai allowed-hostname dotta-macbook-pro
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
npx paperclipai run --data-dir ./tmp/paperclip-dev
npx paperclipai issue list --data-dir ./tmp/paperclip-dev
```

## Context Profiles

Store local defaults in `~/.paperclip/context.json`:

```sh
npx paperclipai context set --api-base http://localhost:3100 --company-id <company-id>
npx paperclipai context set --persona agent --agent-id <agent-id> --api-key-env-var-name PAPERCLIP_API_KEY
pnpm paperclipai context show
pnpm paperclipai context list
npx paperclipai context use default
```

To avoid storing secrets in context, set `apiKeyEnvVarName` and keep the key in env:

```sh
npx paperclipai context set --api-key-env-var-name PAPERCLIP_API_KEY
export PAPERCLIP_API_KEY=...
```

## Company Commands

```sh
npx paperclipai company list
npx paperclipai company get <company-id>
npx paperclipai company current [--company-id <company-id>]
npx paperclipai company stats
npx paperclipai company create --payload-json '{...}'
npx paperclipai company update <company-id> --payload-json '{...}'
npx paperclipai company branding:update <company-id> --payload-json '{...}'
npx paperclipai company archive <company-id>
npx paperclipai company export <company-id> --out ./company --include company,agents,projects,issues,skills
npx paperclipai company export:preview <company-id> --payload-json '{...}'
npx paperclipai company export:api <company-id> --payload-json '{...}'
npx paperclipai company import ./company --target new --new-company-name "Imported Company"
npx paperclipai company import:preview <company-id> --payload-json '{...}'
npx paperclipai company import:apply <company-id> --payload-json '{...}'
npx paperclipai company delete <company-id-or-prefix> --yes --confirm <same-id-or-prefix>
```

Examples:

```sh
npx paperclipai company delete PAP --yes --confirm PAP
npx paperclipai company delete 5cbe79ee-acb3-4597-896e-7662742593cd --yes --confirm 5cbe79ee-acb3-4597-896e-7662742593cd
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
npx paperclipai issue list --company-id <company-id> [--status todo,in_progress] [--assignee-agent-id <agent-id>] [--match text]
npx paperclipai issue get <issue-id-or-identifier>
npx paperclipai issue create --company-id <company-id> --title "..." [--description "..."] [--status todo] [--priority high]
npx paperclipai issue update <issue-id> [--status in_progress] [--comment "..."]
npx paperclipai issue delete <issue-id> --yes
npx paperclipai issue comment <issue-id> --body "..." [--reopen]
npx paperclipai issue comments <issue-id> [--limit 50]
npx paperclipai issue comment:get <issue-id> <comment-id>
npx paperclipai issue comment:delete <issue-id> <comment-id>
npx paperclipai issue runs <issue-id-or-identifier>
npx paperclipai issue live-runs <issue-id-or-identifier>
npx paperclipai issue active-run <issue-id-or-identifier>
npx paperclipai issue heartbeat-context <issue-id>
npx paperclipai issue checkout <issue-id> --agent-id <agent-id> [--expected-statuses todo,backlog,blocked]
npx paperclipai issue release <issue-id>
npx paperclipai issue force-release <issue-id>
```

Issue subresources are exposed as Paperclip API wrappers. Commands that map to broad server schemas accept JSON payloads and validate them with shared schemas before sending.

```sh
npx paperclipai issue child:create <issue-id> --payload-json '{"title":"Child task"}'
npx paperclipai issue approvals <issue-id>
npx paperclipai issue approval:link <issue-id> <approval-id>
npx paperclipai issue approval:unlink <issue-id> <approval-id>
npx paperclipai issue read <issue-id>
npx paperclipai issue unread <issue-id>
npx paperclipai issue archive <issue-id>
npx paperclipai issue unarchive <issue-id>
npx paperclipai issue recovery-actions <issue-id>
npx paperclipai issue recovery:resolve <issue-id> --outcome restored --source-issue-status todo
```

```sh
npx paperclipai issue documents <issue-id> [--include-system]
npx paperclipai issue document:get <issue-id> <key>
npx paperclipai issue document:put <issue-id> <key> --body-file ./plan.md [--title Plan]
npx paperclipai issue document:lock <issue-id> <key>
npx paperclipai issue document:unlock <issue-id> <key>
npx paperclipai issue document:revisions <issue-id> <key>
npx paperclipai issue document:restore <issue-id> <key> <revision-id>
npx paperclipai issue document:delete <issue-id> <key>
```

```sh
npx paperclipai issue work-products <issue-id>
npx paperclipai issue work-product:create <issue-id> --payload-json '{"type":"pull_request","provider":"github","title":"PR"}'
npx paperclipai issue work-product:update <work-product-id> --payload-json '{"status":"archived"}'
npx paperclipai issue work-product:delete <work-product-id>
npx paperclipai issue interactions <issue-id>
npx paperclipai issue interaction:create <issue-id> --payload-json '{"kind":"request_confirmation","payload":{"version":1,"prompt":"Continue?"}}'
npx paperclipai issue interaction:accept <issue-id> <interaction-id> [--selected-client-keys key1,key2]
npx paperclipai issue interaction:reject <issue-id> <interaction-id> [--reason "..."]
npx paperclipai issue interaction:respond <issue-id> <interaction-id> --answers-json '[{"questionId":"q1","optionIds":["yes"]}]'
npx paperclipai issue interaction:cancel <issue-id> <interaction-id> [--reason "..."]
```

```sh
npx paperclipai issue tree-state <issue-id>
npx paperclipai issue tree-preview <issue-id> --payload-json '{"mode":"pause"}'
npx paperclipai issue tree-holds <issue-id> [--status active] [--include-members]
npx paperclipai issue tree-hold:create <issue-id> --payload-json '{"mode":"pause","reason":"review"}'
npx paperclipai issue tree-hold:get <issue-id> <hold-id>
npx paperclipai issue tree-hold:release <issue-id> <hold-id> [--payload-json '{"reason":"done"}']
npx paperclipai issue attachments <issue-id>
npx paperclipai issue attachment:upload <issue-id> --company-id <company-id> --file ./artifact.txt
npx paperclipai issue attachment:download <attachment-id> [--out ./artifact.txt]
npx paperclipai issue attachment:delete <attachment-id>
npx paperclipai issue label:list --company-id <company-id>
npx paperclipai issue label:create --company-id <company-id> --name bug --color '#ff0000'
npx paperclipai issue label:delete <label-id>
npx paperclipai issue feedback:votes <issue-id>
npx paperclipai issue feedback:vote <issue-id> --payload-json '{"targetType":"issue_comment","targetId":"...","vote":"up"}'
```

## Project Commands

```sh
npx paperclipai project list --company-id <company-id>
npx paperclipai project get <project-id-or-shortname> [--company-id <company-id>]
npx paperclipai project create --company-id <company-id> --name "Launch Site" [--goal-ids <id1,id2>] [--lead-agent-id <id>]
npx paperclipai project update <project-id-or-shortname> [--status in_progress] [--company-id <company-id>]
npx paperclipai project delete <project-id-or-shortname> --yes [--company-id <company-id>]
```

Advanced project fields accept JSON:

```sh
npx paperclipai project create --company-id <company-id> --name "Ops" --env-json '{"OPENAI_API_KEY":{"kind":"secret","secretName":"openai-api-key"}}'
npx paperclipai project update <project-id> --execution-workspace-policy-json '{"enabled":true,"defaultMode":"shared_workspace"}'
```

## Goal Commands

```sh
npx paperclipai goal list --company-id <company-id>
npx paperclipai goal get <goal-id>
npx paperclipai goal create --company-id <company-id> --title "Grow revenue" [--level company] [--status active]
npx paperclipai goal update <goal-id> [--title "..."] [--status achieved]
npx paperclipai goal delete <goal-id> --yes
```

## Agent Commands

```sh
npx paperclipai agent list --company-id <company-id>
npx paperclipai agent get <agent-id>
npx paperclipai agent create --company-id <company-id> --payload-json '{"name":"Builder","adapterType":"codex_local"}'
npx paperclipai agent hire --company-id <company-id> --payload-json '{...}'
npx paperclipai agent update <agent-id> --payload-json '{"title":"Senior Builder"}'
npx paperclipai agent delete <agent-id> --yes
npx paperclipai agent me
npx paperclipai agent inbox
npx paperclipai agent inbox-mine --user-id <board-user-id>
npx paperclipai agent wake <agent-id-or-shortname> [--company-id <company-id>] [--reason "..."] [--payload '{"issueId":"..."}']
npx paperclipai agent pause <agent-id>
npx paperclipai agent resume <agent-id>
npx paperclipai agent approve <agent-id>
npx paperclipai agent terminate <agent-id>
npx paperclipai agent heartbeat:invoke <agent-id>
npx paperclipai agent claude-login <agent-id>
npx paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>
```

Agent configuration and runtime endpoints:

```sh
npx paperclipai agent permissions:update <agent-id> --payload-json '{"canCreateAgents":true,"canCreateSkills":true,"canAssignTasks":true}'
npx paperclipai agent configuration <agent-id>
npx paperclipai agent config-revisions <agent-id>
npx paperclipai agent config-revision:get <agent-id> <revision-id>
npx paperclipai agent config-revision:rollback <agent-id> <revision-id>
npx paperclipai agent runtime-state <agent-id>
npx paperclipai agent runtime-state:reset-session <agent-id> [--task-key <key>]
npx paperclipai agent task-sessions <agent-id>
npx paperclipai agent skills <agent-id>
npx paperclipai agent skills:sync <agent-id> --desired-skills paperclip,github --mode add
npx paperclipai agent instructions-path:update <agent-id> --payload-json '{"path":"/path/to/AGENTS.md"}'
npx paperclipai agent instructions-bundle <agent-id>
npx paperclipai agent instructions-bundle:update <agent-id> --payload-json '{"mode":"managed"}'
npx paperclipai agent instructions-file:get <agent-id> --path AGENTS.md
npx paperclipai agent instructions-file:put <agent-id> --path AGENTS.md --content-file ./AGENTS.md
npx paperclipai agent instructions-file:delete <agent-id> --path AGENTS.md
```

Agent config, instructions, skills, project env, environment, secret, and workspace edits affect the next run. Active runs finish with the config they started with. When a saved session, reused workspace, or sandbox lease no longer matches the effective next-run config, Paperclip may start fresh execution and records non-sensitive freshness categories in run result JSON and workspace operation logs.

`agent local-cli` is the quickest way to run local Claude/Codex manually as a Paperclip agent:

- creates a new long-lived agent API key
- installs missing Paperclip skills into `~/.codex/skills` and `~/.claude/skills`
- prints `export ...` lines for `PAPERCLIP_API_URL`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_AGENT_ID`, and `PAPERCLIP_API_KEY`

Example for shortname-based local setup:

```sh
npx paperclipai agent local-cli codexcoder --company-id <company-id>
npx paperclipai agent local-cli claudecoder --company-id <company-id>
```

## Token Commands

Agent API keys are scoped to one company and one agent. Plaintext tokens are printed once at creation.

```sh
npx paperclipai token agent create --company-id <company-id> --agent <agent-id-or-name> --name external-worker
npx paperclipai token agent list --company-id <company-id> --agent <agent-id-or-name>
npx paperclipai token agent revoke --company-id <company-id> --agent <agent-id-or-name> <key-id>
```

Named board API keys use the board authorization model, support revocation and expiration metadata, and are audited server-side.

```sh
npx paperclipai token board create --company-id <company-id> --name external-admin
npx paperclipai token board create --name short-lived --ttl-days 7
npx paperclipai token board list
npx paperclipai token board revoke <key-id>
```

## Run Commands

`paperclipai run` without a subcommand still bootstraps and starts a local Paperclip instance. The subcommands below inspect and control API heartbeat runs.

```sh
npx paperclipai run list --company-id <company-id> [--agent-id <agent-id>] [--limit 50]
npx paperclipai run live --company-id <company-id> [--limit 50] [--min-count 0]
npx paperclipai run get <run-id>
npx paperclipai run events <run-id> [--after-seq 0] [--limit 200]
npx paperclipai run log <run-id> [--offset 0] [--limit-bytes 16384] [--text]
npx paperclipai run cancel <run-id>
npx paperclipai run issues <run-id>
npx paperclipai run workspace-operations <run-id>
npx paperclipai run workspace-log <operation-id> [--offset 0] [--limit-bytes 16384] [--text]
npx paperclipai run watchdog-decision <run-id> --decision continue [--reason "..."]
```

## Routine Commands

`paperclipai routines disable-all` remains the local maintenance command. The singular `routine` group maps to the REST API.

```sh
npx paperclipai routine list --company-id <company-id> [--project-id <project-id>]
npx paperclipai routine create --company-id <company-id> --payload-json '{...}'
npx paperclipai routine get <routine-id>
npx paperclipai routine update <routine-id> --payload-json '{...}'
npx paperclipai routine revisions <routine-id>
npx paperclipai routine revision:restore <routine-id> <revision-id>
npx paperclipai routine runs <routine-id> [--limit 50]
npx paperclipai routine run <routine-id> [--payload-json '{...}']
npx paperclipai routine trigger:create <routine-id> --payload-json '{...}'
npx paperclipai routine trigger:update <trigger-id> --payload-json '{...}'
npx paperclipai routine trigger:delete <trigger-id>
npx paperclipai routine trigger:rotate-secret <trigger-id>
npx paperclipai routine trigger:fire <public-id> [--payload-json '{...}']
```

## Prompt Handoff

Prompt handoff creates Paperclip work. It does not create a chat session.

```sh
npx paperclipai agent-prompt <agent-name-or-id> <agent-api-key> "Prompt here"
npx paperclipai agent prompt --agent <agent-name-or-id> --api-key-env PAPERCLIP_API_KEY "Prompt here"
npx paperclipai agent prompt --profile my-agent "Prompt here"
npx paperclipai board prompt --company-id <company-id> --agent <agent-name-or-id> "Prompt here"
```

By default the command creates a `todo` issue assigned to the target agent and wakes the agent. Use `--issue <issue-id>` to add a comment to existing work, and `--no-wake` to skip the wakeup.

## Skills Commands

`paperclipai skills` covers three distinct operations:

1. **Company install** — adds or updates a row in `company_skills` for the
   whole company. This is what `skills install`, `skills import`, `skills create`,
   and `skills scan-projects` do.
2. **Agent attach** — merges an agent's *desired* company skill set with an
   explicit `add`, `remove`, or `replace` mode (`skills agent sync`/`clear`).
   This is a desired-state operation on the agent's adapter config; it does not
   change the company library.
3. **Adapter runtime sync** — the adapter reconciles the desired skill set
   with files on disk and reports an `AgentSkillSnapshot` (`skills agent list`).
   `skills agent sync` triggers this automatically after updating desired state.

Required Paperclip runtime skills (heartbeat, etc.) remain server-enforced and
are added on top of whatever the desired set names.

Company skill mutations (`skills install`, `skills import`, `skills create`, and
`skills scan-projects`) are open to same-company actors by default. Missing
`skills:create` grants and `canCreateSkills` settings do not deny these commands;
only an explicit company skill policy restriction does. Core safety and company
boundary checks still apply, and `agents:create` remains required when a command
also creates agents.

### Catalog (app-shipped skills)

The Paperclip app ships a curated catalog under `@paperclipai/skills-catalog`.
Browse and inspect commands never mutate company state; `install` adds a catalog
skill to the company library.

```sh
npx paperclipai skills browse [--kind bundled|optional] [--category <slug>] [--query <text>]
npx paperclipai skills search "<text>" [--kind bundled|optional] [--category <slug>]
npx paperclipai skills inspect <catalog-id-or-key-or-slug>
npx paperclipai skills install <catalog-id-or-key-or-slug> [--as <slug>] [--force] --company-id <company-id>
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
npx paperclipai skills browse --kind bundled --company-id <company-id>
npx paperclipai skills search "pull request" --kind bundled
npx paperclipai skills inspect github-pr-workflow
npx paperclipai skills install github-pr-workflow --company-id <company-id>
npx paperclipai skills install paperclipai:optional:browser:agent-browser --company-id <company-id>
```

External GitHub, skills.sh, local-path, and URL sources still go through
`skills import`; catalog commands are for the app-shipped catalog only.

### Company library

```sh
npx paperclipai skills list --company-id <company-id>
npx paperclipai skills show <skill-id-or-key-or-slug> --company-id <company-id>
npx paperclipai skills file <skill-id-or-key-or-slug> [--path SKILL.md] --company-id <company-id>
npx paperclipai skills import <source> --company-id <company-id>
npx paperclipai skills create --name "Review PRs" [--slug review-prs] [--description "..."] [--body-file SKILL.md] --company-id <company-id>
npx paperclipai skills scan-projects [--project-id <id>...] [--workspace-id <id>...] --company-id <company-id>
npx paperclipai skills check [skill-id-or-key-or-slug] --company-id <company-id>
npx paperclipai skills update <skill-id-or-key-or-slug> [--force] --company-id <company-id>
npx paperclipai skills update --all [--force] --company-id <company-id>
npx paperclipai skills audit [skill-id-or-key-or-slug] --company-id <company-id>
npx paperclipai skills reset <skill-id-or-key-or-slug> [--yes] [--force] --company-id <company-id>
npx paperclipai skills remove <skill-id-or-key-or-slug> --yes --company-id <company-id>
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
npx paperclipai skills agent list <agent-id-or-shortname> --company-id <company-id>
npx paperclipai skills agent sync <agent-id-or-shortname> --skill <skill-id-or-key-or-slug> [--skill <skill-id-or-key-or-slug>...] --mode <add|remove|replace> --company-id <company-id>
npx paperclipai skills agent clear <agent-id-or-shortname> --yes --company-id <company-id>
```

`skills agent sync` requires a merge mode and returns the resulting adapter
`AgentSkillSnapshot`. `add` preserves all unnamed assignments, `remove` deletes
only named assignments, and `replace` destructively overwrites the complete
non-required desired skill set.
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
npx paperclipai teams browse [--kind bundled|optional] [--category <slug>] [--query <text>]
npx paperclipai teams search "<text>" [--kind bundled|optional] [--category <slug>]
npx paperclipai teams inspect <catalog-id-or-key-or-slug> [--file TEAM.md]
npx paperclipai teams preview <catalog-id-or-key-or-slug> --company-id <company-id>
npx paperclipai teams install <catalog-id-or-key-or-slug> --company-id <company-id>
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
npx paperclipai secrets list --company-id <company-id>
npx paperclipai secrets declarations --company-id <company-id> [--include agents,projects] [--kind secret]
npx paperclipai secrets create --company-id <company-id> --name anthropic-api-key --value-env ANTHROPIC_API_KEY
npx paperclipai secrets link --company-id <company-id> --name prod-stripe-key --provider aws_secrets_manager --external-ref <provider-ref>
npx paperclipai secrets doctor --company-id <company-id>
npx paperclipai secrets provider-configs --company-id <company-id>
npx paperclipai secrets provider-config:create --company-id <company-id> --payload-json '{...}'
npx paperclipai secrets provider-config:discovery-preview --company-id <company-id> --payload-json '{...}'
npx paperclipai secrets provider-config:get <config-id>
npx paperclipai secrets provider-config:update <config-id> --payload-json '{...}'
npx paperclipai secrets provider-config:default <config-id>
npx paperclipai secrets provider-config:health <config-id>
npx paperclipai secrets provider-config:delete <config-id>
npx paperclipai secrets remote-import:preview --company-id <company-id> --payload-json '{...}'
npx paperclipai secrets remote-import --company-id <company-id> --payload-json '{...}'
npx paperclipai secrets migrate-inline-env --company-id <company-id> [--apply]
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
npx paperclipai approval list --company-id <company-id> [--status pending]
npx paperclipai approval get <approval-id>
npx paperclipai approval create --company-id <company-id> --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
npx paperclipai approval approve <approval-id> [--decision-note "..."]
npx paperclipai approval reject <approval-id> [--decision-note "..."]
npx paperclipai approval request-revision <approval-id> [--decision-note "..."]
npx paperclipai approval resubmit <approval-id> [--payload '{"...":"..."}']
npx paperclipai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
npx paperclipai activity list --company-id <company-id> [--agent-id <agent-id>] [--entity-type issue] [--entity-id <id>]
npx paperclipai activity create --company-id <company-id> --payload-json '{...}'
npx paperclipai activity issue <issue-id>
```

## Dashboard Commands

```sh
npx paperclipai dashboard get --company-id <company-id>
```

## Org And Agent Config Commands

```sh
npx paperclipai whoami
npx paperclipai openapi
npx paperclipai org get --company-id <company-id>
npx paperclipai org svg --company-id <company-id> [--out org.svg]
npx paperclipai org png --company-id <company-id> [--out org.png]
npx paperclipai agent-config list --company-id <company-id>
```

## Access, Profile, And Instance Commands

```sh
npx paperclipai profile session
npx paperclipai profile get
npx paperclipai profile update --payload-json '{...}'
npx paperclipai profile company-user <user-slug> --company-id <company-id>
npx paperclipai invite list --company-id <company-id>
npx paperclipai invite create --company-id <company-id> --payload-json '{...}'
npx paperclipai invite revoke <invite-id>
npx paperclipai invite show <token>
npx paperclipai invite accept <token> [--payload-json '{...}']
npx paperclipai invite onboarding:text <token>
npx paperclipai join list --company-id <company-id> [--status pending_approval]
npx paperclipai join approve <request-id> --company-id <company-id>
npx paperclipai join reject <request-id> --company-id <company-id>
npx paperclipai join claim-key <request-id> --claim-secret <secret>
npx paperclipai member list --company-id <company-id>
npx paperclipai member update <member-id> --company-id <company-id> --payload-json '{...}'
npx paperclipai member role-and-grants <member-id> --company-id <company-id> --payload-json '{...}'
npx paperclipai member permissions <member-id> --company-id <company-id> --payload-json '{...}'
npx paperclipai member archive <member-id> --company-id <company-id> [--payload-json '{...}']
npx paperclipai admin user list [--query <text>]
npx paperclipai admin user promote <user-id>
npx paperclipai admin user demote <user-id>
npx paperclipai admin user company-access <user-id>
npx paperclipai admin user company-access:update <user-id> --payload-json '{...}'
```

CLI auth challenge endpoints are also exposed for tooling that needs the raw challenge lifecycle:

```sh
npx paperclipai auth challenge create --payload-json '{...}'
PAPERCLIP_CHALLENGE_SECRET=<challenge-secret> npx paperclipai auth challenge get <challenge-id> --token-env PAPERCLIP_CHALLENGE_SECRET
PAPERCLIP_CHALLENGE_SECRET=<challenge-secret> npx paperclipai auth challenge approve <challenge-id> --token-env PAPERCLIP_CHALLENGE_SECRET
PAPERCLIP_CHALLENGE_SECRET=<challenge-secret> npx paperclipai auth challenge cancel <challenge-id> --token-env PAPERCLIP_CHALLENGE_SECRET
npx paperclipai auth revoke-current
```

`--token <challenge-secret>` is still supported for compatibility, but `--token-env` avoids putting challenge secrets in shell history or process arguments.

## Instance Settings Commands

```sh
npx paperclipai instance scheduler-heartbeats
npx paperclipai instance settings:general
npx paperclipai instance settings:general:update --payload-json '{...}'
npx paperclipai instance settings:experimental
npx paperclipai instance settings:experimental:update --payload-json '{...}'
npx paperclipai instance database-backup
```

Experimental features are opt-in and are provided without compatibility guarantees. They may break, change, or be removed at any time. Use them at your own risk.

```sh
npx paperclipai sidebar preferences
npx paperclipai sidebar preferences:update --payload-json '{...}'
npx paperclipai sidebar project-preferences --company-id <company-id>
npx paperclipai sidebar project-preferences:update --company-id <company-id> --payload-json '{...}'
npx paperclipai sidebar badges --company-id <company-id>
npx paperclipai inbox dismissals --company-id <company-id>
npx paperclipai inbox dismiss --company-id <company-id> --payload-json '{"itemKey":"run:<run-id>"}'
npx paperclipai board-claim show <token>
npx paperclipai board-claim claim <token> [--payload-json '{...}']
npx paperclipai openclaw invite-prompt --company-id <company-id> --payload-json '{...}'
npx paperclipai available-skill list
npx paperclipai available-skill index
npx paperclipai available-skill get <skill-name>
npx paperclipai llm agent-configuration
npx paperclipai llm agent-configuration:adapter <adapter-type>
npx paperclipai llm agent-icons
```

Hermes gateway uses the generic invite/join commands above rather than
`openclaw invite-prompt`. Create an agent invite, read
`invite onboarding:text`, submit a join request with
`adapterType: "hermes_gateway"` and `agentDefaultsPayload.apiBaseUrl` /
`agentDefaultsPayload.apiKey`, then approve and claim the key with the `join`
commands. See [HERMES_GATEWAY_ONBOARDING.md](./HERMES_GATEWAY_ONBOARDING.md).

## Adapter, Asset, And Skill Commands

```sh
npx paperclipai adapter list
npx paperclipai adapter install --payload-json '{"packageName":"@scope/adapter","version":"1.2.3"}'
npx paperclipai adapter get <adapter-type>
npx paperclipai adapter update <adapter-type> --payload-json '{"disabled":true}'
npx paperclipai adapter override <adapter-type> --payload-json '{"paused":true}'
npx paperclipai adapter reload <adapter-type>
npx paperclipai adapter reinstall <adapter-type>
npx paperclipai adapter delete <adapter-type>
npx paperclipai adapter config-schema <adapter-type>
npx paperclipai adapter ui-parser <adapter-type>
npx paperclipai adapter models <adapter-type> --company-id <company-id> [--refresh] [--environment-id <id>]
npx paperclipai adapter model-profiles <adapter-type> --company-id <company-id>
npx paperclipai adapter detect-model <adapter-type> --company-id <company-id>
npx paperclipai adapter test-environment <adapter-type> --company-id <company-id> --payload-json '{...}'
```

```sh
npx paperclipai asset image:upload --company-id <company-id> --file ./image.png [--namespace docs] [--alt "..."]
npx paperclipai asset logo:upload --company-id <company-id> --file ./logo.svg
npx paperclipai asset content <asset-id> --out ./asset.bin
```

```sh
npx paperclipai skill list --company-id <company-id>
npx paperclipai skill get <skill-id> --company-id <company-id>
npx paperclipai skill file <skill-id> --company-id <company-id> [--path SKILL.md]
npx paperclipai skill create --company-id <company-id> --payload-json '{...}'
npx paperclipai skill file:update <skill-id> --company-id <company-id> --payload-json '{...}'
npx paperclipai skill import --company-id <company-id> --payload-json '{"source":"github:owner/repo/path"}'
npx paperclipai skill scan-projects --company-id <company-id> --payload-json '{...}'
npx paperclipai skill update-status <skill-id> --company-id <company-id>
npx paperclipai skill install-update <skill-id> --company-id <company-id>
npx paperclipai skill delete <skill-id> --company-id <company-id>
```

## Cost, Finance, And Budget Commands

```sh
npx paperclipai cost summary --company-id <company-id>
npx paperclipai cost by-agent --company-id <company-id>
npx paperclipai cost by-agent-model --company-id <company-id>
npx paperclipai cost by-provider --company-id <company-id>
npx paperclipai cost by-biller --company-id <company-id>
npx paperclipai cost by-project --company-id <company-id>
npx paperclipai cost window-spend --company-id <company-id>
npx paperclipai cost quota-windows --company-id <company-id>
npx paperclipai cost issue <issue-id>
npx paperclipai cost event:create --company-id <company-id> --payload-json '{...}'
```

```sh
npx paperclipai finance event:create --company-id <company-id> --payload-json '{...}'
npx paperclipai finance events --company-id <company-id>
npx paperclipai finance summary --company-id <company-id>
npx paperclipai finance by-biller --company-id <company-id>
npx paperclipai finance by-kind --company-id <company-id>
npx paperclipai budget overview --company-id <company-id>
npx paperclipai budget policy:upsert --company-id <company-id> --payload-json '{...}'
npx paperclipai budget company:update --company-id <company-id> --payload-json '{...}'
npx paperclipai budget agent:update <agent-id> --payload-json '{...}'
npx paperclipai budget incident:resolve <incident-id> --company-id <company-id> [--payload-json '{...}']
```

## Workspace And Environment Commands

```sh
npx paperclipai workspace list --company-id <company-id>
npx paperclipai workspace get <execution-workspace-id>
npx paperclipai workspace close-readiness <execution-workspace-id>
npx paperclipai workspace operations <execution-workspace-id>
npx paperclipai workspace update <execution-workspace-id> --payload-json '{...}'
npx paperclipai workspace runtime-service <execution-workspace-id> start --payload-json '{...}'
npx paperclipai workspace runtime-command <execution-workspace-id> run --payload-json '{...}'
```

```sh
npx paperclipai environment list --company-id <company-id>
npx paperclipai environment capabilities --company-id <company-id>
npx paperclipai environment create --company-id <company-id> --payload-json '{...}'
npx paperclipai environment get <environment-id>
npx paperclipai environment leases <environment-id>
npx paperclipai environment lease <lease-id>
npx paperclipai environment update <environment-id> --payload-json '{...}'
npx paperclipai environment delete <environment-id>
npx paperclipai environment probe <environment-id>
npx paperclipai environment probe-config --company-id <company-id> --payload-json '{...}'
```

```sh
npx paperclipai project-workspace list <project-id>
npx paperclipai project-workspace create <project-id> --payload-json '{...}'
npx paperclipai project-workspace update <project-id> <workspace-id> --payload-json '{...}'
npx paperclipai project-workspace delete <project-id> <workspace-id>
npx paperclipai project-workspace runtime-service <project-id> <workspace-id> restart --payload-json '{...}'
npx paperclipai project-workspace runtime-command <project-id> <workspace-id> run --payload-json '{...}'
```

## Plugin Commands

Existing plugin lifecycle commands remain available: `plugin init`, `list`, `install`, `uninstall`, `enable`, `disable`, `inspect`, and `examples`.

```sh
npx paperclipai plugin ui-contributions
npx paperclipai plugin tools
npx paperclipai plugin tool:execute --payload-json '{...}'
npx paperclipai plugin health <plugin-id>
npx paperclipai plugin logs <plugin-id>
npx paperclipai plugin upgrade <plugin-id>
npx paperclipai plugin config <plugin-id> --company-id <company-id>
npx paperclipai plugin config:set <plugin-id> --company-id <company-id> --payload-json '{"configJson":{...}}'
npx paperclipai plugin config:test <plugin-id> --company-id <company-id> --payload-json '{"configJson":{...}}'
npx paperclipai plugin jobs <plugin-id>
npx paperclipai plugin job:runs <plugin-id> <job-id>
npx paperclipai plugin job:trigger <plugin-id> <job-id> [--payload-json '{...}']
npx paperclipai plugin webhook <plugin-id> <endpoint-key> [--payload-json '{...}']
npx paperclipai plugin dashboard <plugin-id>
npx paperclipai plugin bridge:data <plugin-id> --payload-json '{...}'
npx paperclipai plugin bridge:action <plugin-id> --payload-json '{...}'
npx paperclipai plugin bridge:stream <plugin-id> <channel> [--duration-ms 10000]
npx paperclipai plugin data <plugin-id> <key> --payload-json '{...}'
npx paperclipai plugin action <plugin-id> <key> --payload-json '{...}'
npx paperclipai plugin local-folders <plugin-id> --company-id <company-id>
npx paperclipai plugin local-folder:status <plugin-id> <folder-key> --company-id <company-id>
npx paperclipai plugin local-folder:validate <plugin-id> <folder-key> --company-id <company-id> [--payload-json '{...}']
npx paperclipai plugin local-folder:set <plugin-id> <folder-key> --company-id <company-id> --payload-json '{...}'
```

Feedback traces can be fetched directly by ID when automating export workflows:

```sh
npx paperclipai feedback trace <trace-id>
npx paperclipai feedback bundle <trace-id>
```

## Heartbeat Command

`heartbeat run` now also supports context/api-key options and uses the shared client stack:

```sh
npx paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100] [--api-key <token>]
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
