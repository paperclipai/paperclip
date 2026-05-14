# Copilot Local Adapter Security Runbook

Status: required gate before `copilot_local` runtime rollout  
Last updated: 2026-05-06  
Audience: Paperclip operators and adapter implementers

This runbook defines the minimum security gate for running GitHub Copilot CLI as
a Paperclip local adapter, especially from WSL2/Linux hosts. It applies before
any live Paperclip agent is migrated to `copilot_local`.

## Reviewed Sources

- GitHub Docs, "Authenticating GitHub Copilot CLI", reviewed 2026-05-06:
  <https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli>
- GitHub Docs, "GitHub Copilot CLI command reference", reviewed 2026-05-06:
  <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference>
- GitHub Docs, "Allowing and denying tool use", reviewed 2026-05-06:
  <https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools>
- GitHub Docs, "GitHub Copilot CLI programmatic reference", reviewed 2026-05-06:
  <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference>

## Gate Summary

Do not migrate live agents or enable scheduled heartbeats on `copilot_local`
until all of these are true:

1. The adapter implementation has a PR with tests for auth failures, command
   args, permission defaults, JSON/JSONL parsing, timeout, and nonzero exit.
2. The adapter does not default to `--allow-all`, `--yolo`,
   `--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls`, or
   `COPILOT_ALLOW_ALL=true`.
3. A read-only smoke command passes in the same WSL2/Linux runtime that will run
   Paperclip.
4. The operator has approved a live-agent migration comment or issue naming the
   agent ids, auth mode, `COPILOT_HOME`, permissions, rollback path, and evidence.
5. Any browser automation, remote steering, transcript gist upload, package
   publish, release publish, or other external upload remains disabled unless a
   board-approved Gate 4 explicitly allows that action.

## Authentication

Copilot CLI supports interactive OAuth with `copilot login` and non-interactive
environment-token auth. For Paperclip automation, prefer one of these two modes:

- Local operator setup: run `copilot login` under the same OS user that runs
  Paperclip, with `COPILOT_HOME` set to the Paperclip-managed agent home.
- Headless setup: bind a Paperclip secret to `COPILOT_GITHUB_TOKEN`. Use a
  user-owned fine-grained PAT with the Copilot Requests account permission, or
  another supported token type approved by GitHub's current docs.

Token lookup precedence is security-significant:

1. `COPILOT_GITHUB_TOKEN`
2. `GH_TOKEN`
3. `GITHUB_TOKEN`
4. OAuth token from the system keychain or Copilot config
5. GitHub CLI fallback from `gh auth token`

Adapter implementation requirements:

- Scrub inherited `GH_TOKEN` and `GITHUB_TOKEN` unless the adapter config
  explicitly opts into using them. These variables can silently override
  `copilot login`.
- Prefer `COPILOT_GITHUB_TOKEN` for Paperclip-managed secrets because it is
  specific to Copilot CLI.
- Reject or warn on classic `ghp_` PATs for Copilot auth; GitHub's docs say
  classic PATs are not supported by Copilot CLI.
- Treat BYOK provider variables such as `COPILOT_PROVIDER_API_KEY` as secrets.
  BYOK can still send prompts and code context to the configured provider.

## `COPILOT_HOME`

`COPILOT_HOME` contains Copilot configuration, auth state, sessions, plugins,
MCP configuration, logs, and other state. It must not live in a repository,
project workspace, git worktree, or any path likely to be copied into PRs,
attachments, run logs, or support bundles.

Safe default:

```text
~/.paperclip/instances/<instanceId>/companies/<companyId>/copilot-home/<agentId>
```

Operator checklist:

- Create the directory with owner-only permissions (`0700` on Linux/WSL2).
- Set `COPILOT_HOME` per agent by default. Use a shared company-level home only
  after an explicit operator decision to share account state across agents.
- Set `COPILOT_CACHE_HOME` and `--log-dir` under the same Paperclip-managed
  state root when possible, not inside the repo.
- Never commit or attach `config.json`, `settings.json`, `mcp-config.json`,
  Copilot logs, session exports, keychain fallback files, cache files, or copied
  `COPILOT_HOME` directories.

## Permission Defaults

Paperclip runs local adapters without an interactive human permission prompt, so
the adapter must pass a deliberate permission set.

Required defaults:

- Use programmatic mode with `-p` or `--prompt`, `--output-format=json`, and
  `--no-ask-user`.
- Do not use broad allow-all flags or `COPILOT_ALLOW_ALL=true` by default.
- Scope filesystem access to the realized workspace with `--add-dir=<cwd>`.
- Do not use `--allow-all-paths` by default.
- Do not enable remote steering with `--remote` or `--connect` by default.
- Do not enable transcript sharing with `--share-gist` by default.
- Do not enable all GitHub MCP tools by default.

Recommended starter policy for a read-only smoke:

```sh
copilot -p "Reply with exactly: ok" \
  --output-format=json \
  --no-ask-user \
  --add-dir "$PWD" \
  --available-tools="grep,glob,view" \
  --allow-tool="read" \
  --deny-tool="write,shell,memory,url"
```

Recommended starter policy for controlled issue work:

```sh
copilot -p "$PAPERCLIP_PROMPT" \
  --output-format=json \
  --no-ask-user \
  --add-dir "$PAPERCLIP_WORKSPACE_CWD" \
  --available-tools="bash,grep,glob,view,create,edit,apply_patch" \
  --allow-tool="read,write" \
  --deny-tool="read(.env),read(**/.env),shell(git push),shell(npm publish),shell(pnpm publish)"
```

Tune shell and URL access per company/project. Deny rules take precedence over
allow rules, including when a broad operator override is active.

## Secret Redaction

Never print token values, Copilot config files, full environment dumps, MCP
headers, or transcript shares into Paperclip comments, issue documents, tests,
fixtures, or logs.

Adapter requirements:

- Pass `--secret-env-vars` for every configured secret variable, including
  `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`,
  `COPILOT_PROVIDER_API_KEY`, `OTEL_EXPORTER_OTLP_HEADERS`, and any MCP server
  secret env var.
- Redact command metadata before logging. Paperclip's shared redactor must cover
  OpenAI keys, bearer tokens, JWTs, `gh*_*` GitHub tokens, and fine-grained
  `github_pat_*` tokens.
- Do not call `copilot mcp ... --show-secrets` inside a heartbeat.
- Keep `--log-level` at the lowest useful level for normal runs. Debug/all logs
  require operator approval and must be reviewed before sharing.

## Smoke Test

Run these probes in the same WSL2/Linux environment that Paperclip will use:

```sh
command -v copilot
node --version
copilot --version
COPILOT_ALLOW_ALL=false copilot -p "Reply with exactly: ok" \
  --output-format=json \
  --no-ask-user \
  --add-dir "$PWD" \
  --available-tools="grep,glob,view" \
  --allow-tool="read" \
  --deny-tool="write,shell,memory,url"
```

Pass criteria:

- `copilot` resolves to the intended Linux/WSL2 binary, not an unintended
  Windows shim.
- The Node version visible to the Copilot CLI satisfies the current Copilot CLI
  requirement.
- The prompt exits successfully and returns only non-sensitive output.
- Paperclip captures no raw token, config file, MCP header, or private path
  beyond the existing home-path redaction policy.

## Rollback

If `copilot_local` behaves unexpectedly:

1. Pause the agent in Paperclip.
2. Reassign or switch the agent back to its previous adapter config.
3. Reset the issue session before retrying with a different adapter.
4. Disable scheduled heartbeats until the operator reviews the failed run.
5. Preserve `COPILOT_HOME` for forensic review. Do not delete, rotate, move, or
   print secrets from it during the incident.

## Live-Agent Migration Gate

Before migrating a live agent, create a Paperclip issue or comment with:

- agent id and current adapter
- target `copilot_local` adapter config excluding secret values
- auth mode and secret binding names, not secret values
- exact `COPILOT_HOME`, `COPILOT_CACHE_HOME`, and log directory
- permission args and any explicit broad override
- smoke evidence
- rollback owner and command/config action
- board approval when the config enables browser automation, remote steering,
  external uploads, publication, or broad allow-all permissions

Keep the migration in `in_review` until approval is explicit. Do not infer
approval from assignment, silence, or a passing smoke.

## Blocking Findings Against TIV-262

These are required before the implementation issue can be treated as ready for
runtime rollout:

- High: `copilot_local` must fail closed on broad permission flags. Broad
  `--allow-all` style behavior can only be an explicit operator override with
  issue evidence and board/Gate 4 approval when it enables external upload,
  browser automation, or publication.
- High: inherited `GH_TOKEN`/`GITHUB_TOKEN` must not silently decide Copilot auth
  unless explicitly configured, because they outrank stored OAuth state after
  `COPILOT_GITHUB_TOKEN`.
- Medium: the adapter must isolate `COPILOT_HOME` outside repo/workspace paths
  and must not copy it into work products, attachments, session shares, or logs.
- Medium: test fixtures and run logs must prove fine-grained `github_pat_*`
  values are redacted if they appear in command metadata or CLI output.
