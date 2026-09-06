# Direct live Runner protocol evals

This is the provider-backed, one-turn protocol qualification layer in
`paperclipai/paperclip-evals/evals/paperclip-runner`. It is intentionally
separate from both the browser full-stack model E2E and the stress-derived
workflow schedule in `runner-workflow-evals.md`.

The canonical unit of work is one live roster plus one authored case. A full
campaign selects every `rosters/live-*.json` file at one immutable
`paperclip-evals` commit. That includes the complete 35-case provider rosters
and the smaller ACPX Codex control roster. The native resume reliability gate
is not a normal one-turn roster: it requires its separately governed external
resource campaign and remains opt-in.

Managed-provider evidence identifies the immutable deployed provider artifact:
Claude Managed uses its Agent version, while AgentCore uses its qualification
revision. Transport API or beta versions remain separate protocol metadata and
must not replace that runtime identity in a report.

## Hosted campaign

Use the `Runner Direct Live Protocol Evals` workflow. Dispatch the workflow
from the default branch and provide:

- `target_branch`: the Paperclip branch to build and test;
- `evals_sha`: an exact 40-character commit from
  `paperclipai/paperclip-evals`;
- `rosters`: `all` for the entire direct suite, or a comma-separated diagnostic
  subset;
- `max_infrastructure_retries`: zero through three, applied only when an
  attempt explicitly reports a retryable infrastructure failure.

The authorization job resolves the Paperclip branch to a commit and verifies
the supplied eval commit before any checkout. A short-lived bot token generated
from `COMMITPERCLIP_KEY` authorizes each checkout of the private eval repository;
the token is masked and is never forwarded to a provider process. The workflow
uses the same numeric actor
allowlist, protected `runner-e2e-paid` environment, RunsOn fleet selector, and
`RUNNER_E2E_MAX_PARALLEL` ceiling as the full-stack E2E workflow. Two balanced
GitHub matrices keep each matrix below GitHub's 256-job limit while keeping
their combined concurrency at or below that shared ceiling. Runner TypeScript,
the native daemon, provider dependencies, and the attempt viewer are built
once and reused by every cell. Because the complete suite requires two matrix
shards, this workflow accepts a shared concurrency ceiling from 2 through 100.

`all` is intentionally literal. A disabled driver, missing remote profile, or
unavailable provider is retained as an infrastructure result; it is not
silently omitted. In particular, the ACPX Pi roster remains visible while Pi
is disabled in the current Runner. Use a roster subset only for diagnosis, not
to claim the full campaign is green.

A provider turn that reaches a durable failed, interrupted, or otherwise
non-completed terminal still produces an attempt artifact and is scored as a
behavior result. It is an infrastructure failure only when the harness cannot
produce usable evidence, such as an unavailable provider, invalid profile, or
transport failure. Automatic retries therefore never rerun a measured behavior
failure merely to improve its score.

## Required protected configuration

The paid jobs read only the credential selected for each roster:

- `OPENAI_API_KEY` for native Codex and ACPX Codex;
- `ANTHROPIC_API_KEY` for ACPX Claude and Claude Managed;
- `OPENROUTER_API_KEY` for native OpenCode and ACPX Pi;
- short-lived GitHub OIDC workload identity for AWS AgentCore.

Claude Managed also requires the four nonsecret
`PAPERCLIP_CLAUDE_MANAGED_*` profile variables. AgentCore requires the
nonsecret `PAPERCLIP_AWS_AGENTCORE_*` profile variables, including
`PAPERCLIP_AWS_AGENTCORE_EXECUTION_ROLE_ARN` and the immutable
`PAPERCLIP_AWS_AGENTCORE_QUALIFICATION_REVISION`; the eval fails closed when
that deployed revision differs from the pinned roster config. The workflow
writes the GitHub OIDC token to a mode-`0600` file and never forwards long-lived
AWS access keys.
Provision the AgentCore stack with `--github-oidc-provider-arn` so that scoped
role admits only the `paperclipai/paperclip` repository's protected
`runner-e2e-paid` environment as its web-identity subject.
Scheduled runs additionally require `RUNNER_PROTOCOL_EVAL_NIGHTLY_ENABLED=true`
and the pinned `RUNNER_PROTOCOL_EVALS_SHA` repository variable.

## Reports and history

Each cell uploads its immutable run directory to an access-controlled Actions
artifact. The trusted report job merges all expected cells, represents missing
cell artifacts as infrastructure failures, and invokes the report program from
the pinned eval commit. The full artifact contains the canonical Evalbook grid,
read-only Runner issue-thread attempt pages, and raw immutable run records.

Public publishing uses a separate projection and a separate trusted OIDC job.
The projection retains model/config identity, status, usage totals, and check
outcomes but removes provider session identifiers, transcripts, semantic-tool
payloads, state revisions, traces, remote profile identities, and raw failure
text. The same Evalbook `report` command renders that projection, so the public
grid and test pages have the standard Evalbook layout. The publisher rejects
scripts, remote resources, symlinks, unknown paths, broken links, raw session
fields, and credential-shaped values.

S3 publication is additive:

```text
runner-protocol-evals/
  index.html
  history.json
  latest.json
  latest-green.json
  campaigns/
    gha-<run-id>-<run-attempt>/
      index.html
      latest.html
      inventory.html
      tests/*.html
      attempts/*.html
      campaign.json
      bundle-manifest.json
```

Campaign files use immutable cache headers and a digest manifest. Reusing a
campaign ID with different bytes fails closed. Only the root history and
pointer files are mutable, and the publisher never deletes objects. The root
history retains at most 200 records, reserving one record for the latest green
campaign when it would otherwise fall outside that window so its pointer stays
valid.

The publishing job uses dedicated `RUNNER_PROTOCOL_EVAL_HISTORY_*` variables
when present and falls back to the existing Runner E2E history role, region,
bucket, and public base URL. Its default top-level prefix is
`runner-protocol-evals`, distinct from `runner-e2e`. The AWS role must allow
additive writes and reads for that prefix.

## Local publisher checks

These tests make no provider or AWS calls:

```sh
pnpm --filter @paperclipai/paperclip-runner test:runner-protocol-eval-publish
```

To inspect the catalog without executing it, point the command at a local
evals checkout:

```sh
pnpm --filter @paperclipai/paperclip-runner \
  report:runner-protocol-eval:catalog -- \
  --evals-root /path/to/paperclip-evals \
  --campaign-id gha-1-1 \
  --output /tmp/runner-protocol-eval-catalog.json
```
