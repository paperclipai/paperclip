# Formal QA

Formal QA is a sealed, autonomous review lane for pull requests. It creates an
independent code-review decision after a trusted GitHub workflow and check run
pass for an exact pull-request head.

Formal QA does not merge a pull request. It does not publish a GitHub status.
It does not activate an agent fleet. A separate readiness controller can read
the terminal review receipt and perform a separately authorized action.

## Trust policy

An instance administrator creates one versioned policy for a project
workspace. The policy fixes these values:

- GitHub repository
- reviewer agent
- required workflow ID
- required check name
- required GitHub App ID
- enabled state

The reviewer must use the `codex_local` adapter. A policy update creates a new
version. A request cannot replace policy values with caller data.

Use `GET /api/projects/{id}/formal-qa-policy` to read the policy. Use
`PUT /api/projects/{id}/formal-qa-policy` to create or replace it. Both routes
require an instance administrator.

## Autonomous lifecycle

The heartbeat scheduler runs the following sequence when scheduling is not
suppressed:

1. Discovery reads open pull requests for each enabled policy. It scans each
   policy at most once every two minutes per server process.
2. Discovery creates an inert, idempotent preparation for each ready exact
   head. It observes drafts but does not create a run until GitHub marks the
   pull request ready for review.
3. The issuer reads the pull request twice. It also reads the exact commit,
   tree, required check, and protected workflow result. It rejects drift,
   pagination ambiguity, a draft, a failed check, and a policy change.
4. The checkout service fetches only the issued head into a clean bare mirror.
   It creates a detached worktree and verifies the exact head and tree.
5. The review service seals a source manifest from Git objects. Tracked
   symlinks stay inert. The service hashes blobs through one bounded batch
   reader and never follows a link target.
6. The review service creates a dedicated heartbeat run. The run receives no
   issue, generic workspace, runtime service, credential, or mutation tool.
7. Codex can only list, read, and search the sealed source. It has a disposable
   home and no mounted checkout. It must return one schema-valid decision.
8. PostgreSQL revalidates live policy and exact authority before it accepts an
   approved or rejected decision. It recomputes the decision digest.

The scheduler can resume a committed issuance whose checkout did not finish.
It can also recover a checkout with a durable `creating` receipt. Semantic
duplicates link to one canonical preparation. Expired nonterminal records
become explicit terminal records instead of remaining queued.

## Pause, cancellation, and process loss

Scheduling suppression stops discovery, issuance, checkout creation, and new
reviews. It does not consume new GitHub or model work.

A cancellation aborts the Formal-QA provider and converges the review, run,
wakeup request, and execution workspace. A late provider result cannot replace
the cancelled state.

After unexpected process loss, Paperclip can retry the same sealed run once.
It first revalidates the policy, expiry, and checkout. A second process loss
fails the run closed. Restart recovery converges a terminal review with its
run, wakeup request, and execution workspace.

## Source and output bounds

The sealed source manifest permits at most 25,000 entries, 64 MiB per blob,
256 MiB of total blob data, and 16 MiB of canonical manifest JSON. A single
source read returns at most 512 KiB. Search returns at most 100 results and
processes at most 2 MiB per request.

Formal-QA run-log events contain fixed lifecycle metadata only. Provider text,
source bytes, search excerpts, prompts, credentials, and checkout paths never
enter the run log. See [Run-Log Events](run-log-events.md#formal-qa-run-log-events).

## API evidence

The following read routes expose durable evidence:

- `GET /api/companies/{companyId}/formal-qa-preparations`
- `GET /api/formal-qa-preparations/{id}`
- `GET /api/companies/{companyId}/formal-qa-reviews`
- `GET /api/formal-qa-reviews/{id}`

The Board can also create an inert request with
`POST /api/companies/{companyId}/formal-qa-preparations`. This endpoint is an
idempotent recovery and test surface. Normal enabled-policy operation does not
require a person to post this request.
