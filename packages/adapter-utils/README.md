# @paperclipai/adapter-utils

Shared utilities for Paperclip adapters: process spawning, environment
injection, sandbox/SSH transport, workspace sync, and the round-trip helpers
that move code between the local execution-workspace cwd and wherever the
agent actually runs.

For the adapter-author guide see
[`docs/adapters/creating-an-adapter.md`](../../docs/adapters/creating-an-adapter.md)
and the in-repo notes at [`packages/adapters/AUTHORING.md`](../adapters/AUTHORING.md).

## No-remote-git contract

The local execution-workspace cwd is the only persistence boundary across
runs. No adapter may depend on a git remote for cross-run state.

Adapters that run the agent on a different host should use the SSH round-trip
helpers in [`src/ssh.ts`](./src/ssh.ts):

- `prepareWorkspaceForSshExecution({ spec, localDir, remoteDir })` — bundles
  the local cwd (tracked files, dirty edits, untracked additions, and the git
  history needed to reconstruct it) to `remoteDir` before the run starts. Runs
  with no `git remote` configured.
- `restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir, ... })` —
  syncs the remote cwd back into `localDir` after the run, including any new
  commits the agent created. Also runs with no `git remote` configured.

`prepareRemoteManagedRuntime` in
[`src/remote-managed-runtime.ts`](./src/remote-managed-runtime.ts) wraps both
calls for adapters that want a per-run remote workspace and an automatic
`restoreWorkspace()` finally hook.

The invariant is pinned by the `no-remote-git contract` case in
[`src/ssh-fixture.test.ts`](./src/ssh-fixture.test.ts), which asserts that a
remote-only commit propagates to the local worktree through the
prepare → restore round-trip with no git remote configured at any point. Do
not regress that test.

## Sandboxed network fetches (the net-fetch door)

Sandbox providers may intentionally deny direct outbound traffic, so a lane's
own `curl`/DNS fails even when the host resolves fine. A network error from
inside a sandbox is never evidence that an external service is down. Instead
of raising an infrastructure blocker, sandboxed adapter runs use
`PAPERCLIP_NET_FETCH_URL` — a run-scoped bridge endpoint the HOST fulfills:

```sh
curl -sS -X POST "$PAPERCLIP_NET_FETCH_URL" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"url":"https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=example"}'
```

The response is a JSON envelope: `{url, status, headers, body, bytes}` (body
is UTF-8 text — the door targets JSON/text APIs). Optional manifest field
`maxBytes` lowers the response cap for that request; it can never raise it.

Enforced host-side (see [`src/sandbox-net-fetch.ts`](./src/sandbox-net-fetch.ts)):

- **GET only**, `http`/`https` only, no credentials in URLs.
- **Deny-default domain allowlist.** Built-in defaults cover the standard job
  and social APIs; additions live in the operator config file
  `<instance-root>/net-fetch-allowlist.json` (override with
  `PAPERCLIP_NET_FETCH_ALLOWLIST_FILE`), shape
  `{"allowlist": ["extra.example"], "companies": {"<companyId>": ["per-co.example"]}}`.
  A malformed config never widens access. Entries match the exact hostname
  and its subdomains on a dot boundary.
- **Public destinations only.** The host resolves the hostname, requires a
  public unicast address, and pins the socket to it — the door is not a path
  to loopback, RFC1918, or link-local services, and cannot be rebound.
- **Response size cap** (2 MiB default) and a bounded timeout. Redirects are
  returned, not followed.
- **No credential pass-through.** Lane-supplied headers are never forwarded;
  the run token and bridge token never leave the host.
- **Company-scoped audit log.** Every request — allowed or denied — appends
  `{ts, runId, companyId, url, method, outcome, status, bytes, durationMs}`
  to `<instance-root>/companies/<companyId>/logs/net-fetch.jsonl`.
