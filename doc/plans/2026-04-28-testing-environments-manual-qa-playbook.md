# Manual QA Playbook: SSH and Sandbox Environment Matrix

Date: 2026-04-28
Owner: CTO
Related issues: `PAPA-184`, `PAPA-164`, `PAPA-146`

## Goal

Create a repeatable manual QA pass for every remote-managed adapter against every non-local environment Paperclip currently supports. The QA operator should do setup serially, launch the matrix in parallel, record pass/fail, and stop there. Root-cause analysis belongs to a follow-up engineering issue, not the QA pass.

## Scope

In scope:

- adapters: `claude_local`, `codex_local`, `cursor`, `gemini_local`, `opencode_local`, `pi_local`
- environment drivers/providers: `ssh`, `sandbox:e2b`
- UI surfaces: Plugins, Company Settings, Projects, Agents, Issues, Agent Detail

Out of scope:

- `process`, `http`, `openclaw_gateway`
- the built-in fake sandbox provider
- debugging beyond one clean rerun for obvious auth/session mistakes

Why: Paperclip only exposes SSH and sandbox environments for remote-managed adapters. The repo support matrix explicitly excludes the non-remote-managed adapters from this test surface.

## Inputs

Use the companion example file at [2026-04-28-testing-environments-manual-qa.env.example](./2026-04-28-testing-environments-manual-qa.env.example) as the source of truth for operator-supplied values.

Important inputs:

- `PAPERCLIP_BASE_URL`
- `QA_COMPANY_NAME`
- `QA_PROJECT_NAME`
- `QA_PROJECT_WORKSPACE_CWD`
- `QA_SSH_ENV_NAME`
- `QA_SSH_HOST`
- `QA_SSH_PORT`
- `QA_SSH_USERNAME`
- `QA_SSH_REMOTE_WORKSPACE_PATH`
- `QA_E2B_PLUGIN_PACKAGE`
- `QA_E2B_ENV_NAME`
- `QA_E2B_TEMPLATE`
- `E2B_API_KEY`
- provider credentials used by the installed CLIs, for example `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`

Do not commit the filled-in env file.

## Pass/Fail Policy

Mark each row one of:

- `pass` if the run finishes and the expected local file exists with the expected marker line
- `fail` if the run starts but Paperclip, the environment driver, workspace sync, or the adapter behavior is wrong
- `blocked/prereq` if the failure is a missing CLI, missing login, missing API key, or missing host access that prevented a fair test

The QA operator should not decide whether a product bug is “small” or “obvious.” They should only classify and report it.

## Why This Setup Uses One Shared Project Workspace

Use one dedicated project workspace rooted at `QA_PROJECT_WORKSPACE_CWD` and keep every issue on that project in `shared_workspace` mode.

This solves two problems:

- local verification happens in one deterministic directory instead of scattered agent-home workspaces
- parallel runs do not conflict because each issue writes a unique file path

The workspace should be a throwaway local git repo, not the main Paperclip checkout. SSH sync uses git import/export semantics, so a git-backed workspace is the safest common denominator for the whole matrix.

## 1. Prepare the Paperclip Host

1. Copy the example env file to an untracked local file, fill in the real values, then export it before starting Paperclip:

```bash
set -a
source /path/to/testing-environments-manual-qa.env
set +a
```

2. Do not preinstall the adapter CLIs on the Paperclip host just for this test. For SSH and sandbox environments, the adapter CLI belongs in the remote execution target that the agent actually runs inside.

3. Create the throwaway local project workspace if it does not exist yet:

```bash
mkdir -p "$QA_PROJECT_WORKSPACE_CWD"
cd "$QA_PROJECT_WORKSPACE_CWD"
git init
git checkout -B main
git config user.name "Paperclip QA"
git config user.email "qa@paperclip.local"
[ -f README.md ] || printf "# Paperclip Environment QA Workspace\n" > README.md
git add README.md
git commit -m "Initialize QA workspace" || true
```

4. Start Paperclip with the exported env file already loaded:

```bash
pnpm dev
```

If this fork auto-selects a port above `3100`, update `PAPERCLIP_BASE_URL` to the actual value from the server log or `pnpm dev:list`.

## 2. Open the Board and Create a Dedicated Company

1. Open `PAPERCLIP_BASE_URL` in the browser.
2. If the instance is in authenticated mode, sign in as a board user.
3. Create or reuse a dedicated company named `QA_COMPANY_NAME`.
4. Do not reuse a company that already contains unrelated environment experiments unless you intentionally want that history mixed into this run.

## 3. Install the E2B Plugin

1. Open the Plugins page.
2. Install the package named `@paperclipai/plugin-e2b` unless it is already present and enabled.
3. Leave it enabled.

Notes:

- the repo package name is `@paperclipai/plugin-e2b`
- the provider label in the environment form is `E2B Cloud Sandbox`

## 4. Create the QA Project and Workspace

Create one project named `QA_PROJECT_NAME`.

Inside that project:

1. Add a primary project workspace.
2. Use source type `Local git checkout`.
3. Set `cwd` to `QA_PROJECT_WORKSPACE_CWD`.
4. Mark it primary.

Then enable the project execution workspace policy:

- enabled: on
- default mode: `shared_workspace`
- default project workspace: the workspace you just created
- allow issue override: on

Do not point this project at the main Paperclip repo checkout. Use the throwaway QA workspace only.

## 5. Create the Environments

Open Company Settings and create these environments.

### SSH environment

Create an SSH environment named `QA_SSH_ENV_NAME` with:

- host: `QA_SSH_HOST`
- port: `QA_SSH_PORT`
- username: `QA_SSH_USERNAME`
- remote workspace path: `QA_SSH_REMOTE_WORKSPACE_PATH`
- strict host key checking: on unless you intentionally need it off
- private key: leave blank if the Paperclip host already has the right SSH keychain/agent access
- known hosts: optional but recommended when strict checking is on

Then click `Test connection`. Do not continue until it passes.

### E2B environment

Create a sandbox environment named `QA_E2B_ENV_NAME` with:

- provider: `E2B Cloud Sandbox`
- template: `QA_E2B_TEMPLATE`
- timeoutMs: `QA_E2B_TIMEOUT_MS`
- reuseLease: `QA_E2B_REUSE_LEASE`

If `E2B_API_KEY` is already exported before `pnpm dev`, you can leave the provider `apiKey` field blank and let the plugin read the host env var. If you do not want to rely on host env, create a Paperclip secret and use the secret-ref field instead.

Then click `Test provider`. Do not continue until it passes.

If one E2B template cannot host every adapter CLI cleanly, create more than one E2B environment here. The matrix can still stay the same as long as each E2B agent points at an environment whose template already contains the right CLI.

## 6. Prepare the Remote Execution Targets

Adapter CLI placement rule:

- for SSH agents, the CLI must exist on the SSH machine
- for E2B agents, the CLI must exist in the selected sandbox template
- the Paperclip host only needs enough access to provision environments and sync workspaces

### SSH target preparation

On the SSH machine referenced by `QA_SSH_HOST`, verify the adapter CLIs there, not on the Paperclip host. A simple check is:

```bash
ssh -p "$QA_SSH_PORT" "$QA_SSH_USERNAME@$QA_SSH_HOST" '
  which claude codex agent gemini opencode pi
'
```

If one of those commands is missing or unauthenticated on the SSH machine:

- fix it on the SSH machine before running the matrix, or
- mark the affected SSH rows `blocked/prereq`

### E2B target preparation

Do not assume one sandbox template can run every adapter CLI.

Use this rule:

- if one E2B template already contains every required CLI, one shared E2B environment is fine
- if different adapters need different template contents, create one E2B environment per adapter or per compatible template

Examples:

- `QA E2B Claude`
- `QA E2B Codex`
- `QA E2B OpenCode`

The minimum repeatable invariant is simple: each E2B agent's default environment must already be able to launch that agent's CLI without relying on the Paperclip host to have that CLI installed.

## 7. Create the Matrix Agents

Create one agent per adapter/environment combination. Use on-demand execution only; do not enable recurring heartbeats for this QA pass.

Recommended naming pattern:

| Agent name | adapter type | default environment |
| --- | --- | --- |
| `QA SSH Claude` | `claude_local` | `QA_SSH_ENV_NAME` |
| `QA SSH Codex` | `codex_local` | `QA_SSH_ENV_NAME` |
| `QA SSH Cursor` | `cursor` | `QA_SSH_ENV_NAME` |
| `QA SSH Gemini` | `gemini_local` | `QA_SSH_ENV_NAME` |
| `QA SSH OpenCode` | `opencode_local` | `QA_SSH_ENV_NAME` |
| `QA SSH Pi` | `pi_local` | `QA_SSH_ENV_NAME` |
| `QA E2B Claude` | `claude_local` | `QA_E2B_ENV_NAME` or an adapter-specific E2B environment |
| `QA E2B Codex` | `codex_local` | `QA_E2B_ENV_NAME` or an adapter-specific E2B environment |
| `QA E2B Cursor` | `cursor` | `QA_E2B_ENV_NAME` or an adapter-specific E2B environment |
| `QA E2B Gemini` | `gemini_local` | `QA_E2B_ENV_NAME` or an adapter-specific E2B environment |
| `QA E2B OpenCode` | `opencode_local` | `QA_E2B_ENV_NAME` or an adapter-specific E2B environment |
| `QA E2B Pi` | `pi_local` | `QA_E2B_ENV_NAME` or an adapter-specific E2B environment |

Adapter notes:

- `cursor` is the real adapter type. Do not look for `cursor_local`.
- `opencode_local` requires an explicit discovered model in `provider/model` format.
- For the others, use the normal UI defaults unless a known-good team preset already exists.

## 8. Create All Issues Before Running Anything

Create one issue per agent under `QA_PROJECT_NAME`.

Use this title pattern:

- `Environment matrix: <environment> / <adapter>`

Use these relative file paths inside `QA_PROJECT_WORKSPACE_CWD`:

| Environment | Adapter | Relative file path |
| --- | --- | --- |
| `ssh` | `claude_local` | `manual-qa/environment-matrix/ssh/claude_local.md` |
| `ssh` | `codex_local` | `manual-qa/environment-matrix/ssh/codex_local.md` |
| `ssh` | `cursor` | `manual-qa/environment-matrix/ssh/cursor.md` |
| `ssh` | `gemini_local` | `manual-qa/environment-matrix/ssh/gemini_local.md` |
| `ssh` | `opencode_local` | `manual-qa/environment-matrix/ssh/opencode_local.md` |
| `ssh` | `pi_local` | `manual-qa/environment-matrix/ssh/pi_local.md` |
| `e2b` | `claude_local` | `manual-qa/environment-matrix/e2b/claude_local.md` |
| `e2b` | `codex_local` | `manual-qa/environment-matrix/e2b/codex_local.md` |
| `e2b` | `cursor` | `manual-qa/environment-matrix/e2b/cursor.md` |
| `e2b` | `gemini_local` | `manual-qa/environment-matrix/e2b/gemini_local.md` |
| `e2b` | `opencode_local` | `manual-qa/environment-matrix/e2b/opencode_local.md` |
| `e2b` | `pi_local` | `manual-qa/environment-matrix/e2b/pi_local.md` |

Use this exact issue body template, replacing the bracketed values:

```md
Use your configured default environment.

Work only inside the project workspace.

Task:
1. Create parent directories if needed.
2. Open or create `[relative file path]`.
3. Append exactly one line:
   `PASS candidate: [adapter] on [environment] - [absolute date]`
4. Save the file.
5. Leave a Paperclip comment that includes the file path you changed.
6. Mark the issue done.

Constraints:
- Do not edit any other file.
- Do not rename files.
- If you cannot start, connect, or save the file, leave a comment with the exact error text and stop.
```

Issue creation rules:

- project: `QA_PROJECT_NAME`
- assignee: the matching QA matrix agent
- execution workspace: leave at the project default
- create all 12 issues before triggering any run

## 9. Run the Matrix

After all issues exist:

1. Open each agent detail page.
2. Click `Run now` once for each matrix agent.
3. Do not change agent config, environment config, or the project workspace while runs are active.
4. Wait until every run reaches a terminal state.

Retry policy:

- one rerun is allowed for an obvious expired login or expired external session
- otherwise, do not retry during the QA pass

## 10. Verify Local Sync

Use the local QA workspace as the verification root:

```bash
cd "$QA_PROJECT_WORKSPACE_CWD"
git status --short
find manual-qa/environment-matrix -type f | sort
```

Expected outcome for a fully passing run:

- one file exists for each matrix row
- each file contains the expected marker line
- `git status --short` shows only the expected QA files as modified or newly created

Also verify in the browser for each row:

- the issue reached `done`
- the agent left a comment
- the run log shows the environment was actually used

## 11. Reporting Template

Report one row per issue using this format:

| Environment | Adapter | Agent | Issue | Run | Result | Local file present | Failure stage | Exact error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ssh` | `claude_local` | `QA SSH Claude` | `...` | `...` | `pass` | `yes` | `-` | `-` |

Failure stage should be one of:

- `prereq`
- `plugin install`
- `environment probe`
- `run start`
- `lease acquire`
- `workspace sync in`
- `adapter exec`
- `file mutation`
- `workspace sync back`
- `issue/comment completion`

Add a short summary block after the table:

- total rows
- pass count
- fail count
- blocked/prereq count
- which failures are product bugs vs host-prep problems

## 12. Optional Follow-up Automation Targets

If this playbook later needs less clicking, automate these exact surfaces first:

- `POST /api/plugins/install`
- `POST /api/companies/:companyId/projects`
- `POST /api/projects/:id/workspaces`
- `POST /api/companies/:companyId/environments`
- `POST /api/companies/:companyId/agents`
- `POST /api/companies/:companyId/issues`

Do not change the execution model when automating. Keep the same matrix, file paths, pass/fail rules, and shared project workspace.
