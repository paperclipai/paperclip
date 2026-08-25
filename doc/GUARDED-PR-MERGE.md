# Guarded pull-request merge

`.claude/scripts/lane.mjs` is the repository-standard command for merging a pull
request. It is the only sanctioned merge path: `gh pr merge` is denied because it
can land a pull request without the gates below.

```sh
node .claude/scripts/lane.mjs merge <PR_NUMBER> [--auto] [--repo owner/name] [--dry-run] [--json]
```

## What it guarantees

A merge is the one irreversible step in the delivery path. The command pins the
pull request's head SHA on its first read, evaluates every gate against that
pinned SHA, **re-reads and re-evaluates immediately before the transport runs**,
and then hands the pinned SHA to GitHub so GitHub itself rejects the call if the
head moved in between. A push that lands mid-validation aborts the merge; it
never races it.

Gates, all required:

| Gate | Rule |
| --- | --- |
| State | pull request is `OPEN` and not a draft |
| Branch | not `CONFLICTING`; mergeability must be computed, not `UNKNOWN` |
| Approval | at least one `APPROVED` review from someone **other than the PR author**, filed against the pinned head SHA |
| Review | no outstanding `CHANGES_REQUESTED` |
| Checks | every reported check on the pinned head is green — pending or unreported is **not** green |
| Method | squash, always; there is no flag to change it |

An approval filed against an earlier commit is reported as `stale_approval`, not
silently accepted. A later `COMMENTED` review does not erase an approval; a
`DISMISSED` review does.

## `--auto`

`--auto` is the only behavior modifier, and it means exactly one thing: instead
of merging now, arm GitHub's native auto-merge (squash, pinned to the validated
head) so the merge fires when required checks finish.

- Approval and head pinning are still enforced up front.
- **Pending or unreported** checks are tolerated — that is the point of the flag.
- An **already-failed** check still blocks. An auto-merge armed behind a red
  check never fires and silently strands the pull request.

Use `--auto` only when the assigned issue authorizes waiting for checks. After
the command returns, re-read the pull request and record whether it is armed or
merged — command success alone is not delivery evidence.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | merged, armed for auto-merge, already merged, or a clean `--dry-run` |
| `1` | the gates passed but the GitHub transport failed |
| `2` | usage error (unknown or denied flag, missing PR number) |
| `3` | a gate refused the merge; nothing was attempted |

Exit `3` is a decision, not a fault: the command prints each denial with a stable
code (`missing_independent_approval`, `stale_approval`, `checks_not_green`,
`checks_failed`, `merge_conflict`, …) so the operator knows exactly what to fix.

## When the transport is unavailable

The command talks to GitHub through `gh api` — REST `PUT …/pulls/{n}/merge` with
the pinned `sha` for a direct merge, and the `enablePullRequestAutoMerge`
mutation with `expectedHeadOid` for `--auto`. It never invokes `gh pr merge`, so
the repository deny holds inside the guard as well as outside it.

If GitHub refuses with 403/404, the command reports `transport_unavailable` and
says so explicitly: **the gates passed, only the transport is blocked.** GitHub
masks "this identity lacks `push`" as a 404 on the merge endpoint, which is what
made this failure expensive to diagnose (EZEAA-871). The remedy is to grant the
merging identity `push` on the repository or route the merge to an identity that
has it. There is no fallback to `gh pr merge`, and adding one would defeat the
guard.

## Denied flags

These are rejected by name with an explanation rather than ignored:

`--admin`, `--merge`, `--rebase`, `--squash`, `--force`, `--body`,
`--match-head-commit`.

## Verifying a change to the command

```sh
pnpm test:lane
```

The tests stub the `gh` boundary, so they exercise the pinning and
re-validation sequence — head moved between reads, approval dismissed between
reads, pending vs. failed checks under `--auto` — without touching the network.
`--dry-run` is read-only and safe against a live pull request.
