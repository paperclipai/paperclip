# Adapter Authoring Notes

In-repo notes for adapter authors. The user-facing guide lives at
[`docs/adapters/creating-an-adapter.md`](../../docs/adapters/creating-an-adapter.md);
this file holds invariants that are easy to violate from inside the adapter
package itself.

## No-remote-git contract (cross-run persistence)

The local execution-workspace cwd is the only persistence boundary across
runs. No adapter may depend on a git remote for cross-run state.

Why: Paperclip resolves a local execution workspace (a worktree) for each
heartbeat. Code state is carried forward by syncing that local cwd to wherever
the agent actually runs — over ssh, into a sandbox, into a managed runtime —
and then syncing changes back when the run finishes. Treating a `git remote`
as the source of truth (`git push` from inside the agent, fetch on the next
wake) breaks dependent issues that are gated on the local worktree being
caught up, and breaks isolated execution workspaces that have no remote
configured at all.

How to apply:

- Never `git push` from adapter runtime code. Never assume the local worktree
  has any `git remote` configured. If you need data from the previous run,
  read it from the local cwd Paperclip handed you.
- If your adapter runs the agent on a different host (ssh, sandbox, remote
  container), use the round-trip helpers in `@paperclipai/adapter-utils`:
  [`prepareWorkspaceForSshExecution`](../adapter-utils/src/ssh.ts) bundles the
  local cwd to the remote dir before the run, and
  [`restoreWorkspaceFromSshExecution`](../adapter-utils/src/ssh.ts) syncs
  remote-side changes (including new git commits) back into the local cwd
  after the run. Both run with no `git remote` configured.
- If your adapter runs the agent locally, you can read and write the cwd
  directly — same invariant applies: changes that future runs need must live
  in the local cwd by the time `execute()` returns.
- A failed sync-back is a run-level error. The heartbeat records
  `workspace_finalize=failed` on the execution workspace, which gates
  dependent issue wakes until the next successful finalize. Do not swallow
  restore errors.
- A transported workspace copy *may* carry the local workspace's `origin`
  remote URL so that branches in the copy stay publishable by the agent or an
  operator who holds credentials — the transport helpers copy the URL as
  metadata only. The copy is allowlist-based and fails closed
  (`sanitizeGitRemoteUrl`): http(s) URLs are stripped of userinfo, query, and
  fragment; `ssh:`/`git:` scheme URLs are stripped of password and query;
  scp-like `user@host:path` passes through (the syntax has no password slot);
  every other shape — filesystem paths, unknown schemes — is dropped rather
  than risk persisting an embedded secret. This does not weaken the contract:
  sync-back through the local cwd remains the only cross-run persistence
  path, the helpers never fetch from or push to that remote, and a workspace
  without an `origin` transports exactly as before.

The invariant is pinned by the `no-remote-git contract` case in
[`packages/adapter-utils/src/ssh-fixture.test.ts`](../adapter-utils/src/ssh-fixture.test.ts),
which asserts that a remote-only commit propagates to the local worktree
through `prepareWorkspaceForSshExecution` → `restoreWorkspaceFromSshExecution`
with no git remote configured at any point.

A static check enforces the rule before runtime ever sees it:
[`scripts/check-no-git-push.mjs`](../../scripts/check-no-git-push.mjs) scans
adapter and runtime source (`packages/adapters/`, `packages/adapter-utils/`,
`server/src/`, `cli/src/`) and fails the `policy` CI job if any unapproved
`git push` invocation is added. If you are building an operator-configured
path that legitimately must push, add a
`// paperclip:allow-git-push: <reason>` comment on the line (or the line
above) so the opt-in shows up in code review.

For the architecture-level write-up of cross-run persistence, see
[`docs/guides/board-operator/execution-workspaces-and-runtime-services.md`](../../docs/guides/board-operator/execution-workspaces-and-runtime-services.md#cross-run-persistence-no-remote-git-contract).

## Credit-billed lanes: do not trust the CLI's cost field

Coding CLIs report `costUsd` from an API-shaped price table: separate input,
output, and *discounted* cache-read rates. Some billers do not sell tokens that
way. GitHub Copilot meters agent traffic against premium credits, where a cache
read costs exactly as much as a fresh input token.

Reconciled against a real Copilot org bill, passing the CLI number through
understated that lane by **12.3x**, because ~99% of a long-running agent
workload's tokens are cache reads.

So an adapter that can route through such a biller must run its result through
[`applyTokenRateCard`](../adapter-utils/src/token-rate-card.ts) instead of
forwarding `costUsd` and hard-coding `billingType: "unknown"`:

```ts
const priced = applyTokenRateCard({
  biller,
  model,
  usage,
  reportedCostUsd: parsed.usage.costUsd,
  env: runtimeEnv,
});
// → { costUsd, billingType, pricingSource }
```

Billers with no rate-card entry keep the adapter-reported cost and billing type,
so this is safe to apply unconditionally. Operators can add or override entries
per deployment with `PAPERCLIP_TOKEN_RATE_CARD_JSON`, which is also how a lane
that is genuinely not billed (a free tier) gets priced at `$0` instead of
carrying a shadow price:

```sh
PAPERCLIP_TOKEN_RATE_CARD_JSON='{"google":{"usdPerThousandTokens":0,"billingType":"fixed","note":"AI Studio free tier"}}'
```

Known limitation: the built-in `github-copilot` rate is *blended*. GitHub does
not publish a per-model token multiplier for credit-metered usage, so the total
reconciles while the split between models (Opus vs Sonnet) is approximate. When
a real multiplier is known, add it to `modelMultipliers` rather than forking the
rate.
