# Setup Paperclip

## Governed Worktree Hooks

Execution workspace provision and teardown hooks are host-executed. Keep them
repo-managed and versioned in the project checkout, for example:

```sh
bash ./scripts/provision-worktree.sh
bash ./scripts/teardown-worktree.sh
```

Paperclip rejects inline shell snippets, heredocs, remote URLs, missing files,
and untracked hook scripts before handing a realized workspace `cwd` to an
adapter. Agent API keys cannot create or mutate host-executed commands through
project, issue, agent override, or execution-workspace update paths.

Hook subprocesses receive only the governed environment allowlist: selected
`PAPERCLIP_WORKSPACE_*` values, `PAPERCLIP_PROJECT_ID`, `PAPERCLIP_AGENT_ID`,
`PAPERCLIP_COMPANY_ID`, `PAPERCLIP_ISSUE_ID`, minimal shell/path variables, and
the local Paperclip config fields required by the bundled worktree init script.
Output evidence is truncated and redacted before persistence.

Default hook timeout is 300 seconds. Operators may lower or raise it with
`PAPERCLIP_WORKSPACE_HOOK_TIMEOUT_MS`; the effective value is capped by
`PAPERCLIP_WORKSPACE_HOOK_TIMEOUT_MAX_MS` (default cap 900 seconds).

Closing an execution workspace first archives the record with a persistent
`metadata.closeSnapshot`, then attempts runtime stop, cleanup, teardown, and
artifact removal. Cleanup failures are non-destructive: the workspace moves to
`cleanup_failed`, keeps the close snapshot, and records cleanup warnings for
manual follow-up.
