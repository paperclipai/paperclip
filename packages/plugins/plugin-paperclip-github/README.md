# @paperclipai/plugin-paperclip-github

Typed GitHub operations for paperclip agents.

## What this plugin does

Replaces every `gh` shell command an agent would write with a typed,
auditable, refusal-aware tool. Each call:

- authenticates as a per-company **GitHub App** installation (not a PAT)
- mints a fresh installation token cached for ~59 minutes
- writes one `ctx.activity.log` entry per success and per failure
- enforces compliance refusals in code (not in prose)

## Tool surface (v0.1)

| Tool | Caller | Purpose |
|------|--------|---------|
| `github_open_pr` | Engineer agents (via Workspace Operator) | Open a draft PR; refuses without an issue reference |
| `github_get_pr` | Merge Director | One round-trip readiness signal: state, mergeable, checks, review decision |
| `github_get_check_runs` | Build Verifier | Read check runs for a PR head SHA |
| `github_create_check_run` | Build Verifier | Publish evidence as a check run; refuses thin (`<200 char`) details |
| `github_enqueue_merge` | Merge Director | Add to merge queue; refuses on failing checks, draft, or unapproved review |
| `github_list_issues` | Delivery Lead | List intake tasks; excludes PRs |

## Refusal rules (in code, not in prose)

| Rule | Tool | Code |
|------|------|------|
| Completed check run must carry ≥200 chars detail | `github_create_check_run` | `evidence_too_thin` |
| Completed check run must have a `conclusion` | `github_create_check_run` | `missing_conclusion` |
| Merge queue must be enabled | `github_enqueue_merge` | `merge_queue_disabled` |
| Can't enqueue a draft | `github_enqueue_merge` | `pr_is_draft` |
| Can't enqueue a closed PR | `github_enqueue_merge` | `pr_not_open` |
| Can't enqueue with failing checks | `github_enqueue_merge` | `failing_checks` |
| Can't enqueue with `CHANGES_REQUESTED` | `github_enqueue_merge` | `review_not_approved` |
| PR body must reference an issue | `github_open_pr` | (auto-appends `Fixes #<issueId>`) |

These are the compliance company's hard rules — see
`doc/company-packages/compliance-first-ai-company/README.md` Rules section
— now enforceable. Audit Lead reviewing this directory is the
source-of-truth audit.

## Instance config

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `appId` | secretRef | yes | GitHub App numeric ID |
| `privateKeyPem` | secretRef | yes | App private key PEM (rotated quarterly) |
| `installationId` | secretRef | yes | The repo-scoped installation ID |
| `repo` | string | yes | `owner/name` |
| `defaultBranch` | string | no | Default base for `github_open_pr`. Default `main`. |
| `mergeQueueEnabled` | boolean | no | When false, `github_enqueue_merge` refuses. Default `true`. |

Operator stores the three secret values in the Paperclip secret store with
any names they choose, and plugin config records only the reference strings.
Plaintext secrets never leave the worker's resolve call.

## Provisioning a GitHub App

1. Create a GitHub App (`Settings → Developer settings → GitHub Apps → New`).
2. Permissions (fine-grained, minimum needed):
   - **Repository contents**: read & write
   - **Pull requests**: read & write
   - **Issues**: read & write
   - **Checks**: read & write
   - **Metadata**: read (implicit)
3. Install the App on the target repository — note the installation ID.
4. Generate and download a private key (PEM).
5. Configure plugin instance in Paperclip UI with the three secret references.

## Building

```bash
pnpm --filter @paperclipai/plugin-paperclip-github build
pnpm --filter @paperclipai/plugin-paperclip-github test
pnpm --filter @paperclipai/plugin-paperclip-github typecheck
```

## What's intentionally NOT in v0.1

- GitHub Projects v2 integration
- Discussions API
- Multi-repo support (one plugin instance ↔ one repo)
- Webhook receiver (next iteration — will emit `github.pr.merged` etc. on the
  internal event bus so Merge Director gets a push instead of polling)
- UI panel (operator config is enough for now)
- Repository ruleset / CODEOWNERS read APIs (next iteration)

## Why not just call `gh` from codex?

| `gh` shell from codex | This plugin |
|-----------------------|-------------|
| LLM parses text output of `gh pr view` | Typed `GetPrResult` from one GraphQL call |
| Auth = whatever `GITHUB_TOKEN` is in the env | Per-company GitHub App identity, signed commits possible |
| No audit trail unless agent remembers to log | Every call writes `ctx.activity.log` automatically |
| Hard rules live in AGENTS.md prose | Hard rules are enforced in `src/audit.ts` + per-tool refusals |
| Same token across all 27 agents | One App identity per company, ratchet-able permissions |

## Related plans

- `doc/plans/2026-05-14-plugin-paperclip-github-design.md` — full design,
  including v0.2 surface (webhook receiver, Projects v2, etc.)
- `doc/company-packages/compliance-first-ai-company/agents/merge-director/AGENTS.md`
- `doc/company-packages/compliance-first-ai-company/agents/build-verifier/AGENTS.md`
