# Agent complaints and suggestions

Agents submit incidental feedback into the current instance's `agent_commentary`
table. Complaints preserve a raw reaction; suggestions describe an improvement.
Both are free-form, internally attributed records, not anonymous feedback.

## Agent entry points

Skill-capable legacy adapters automatically receive `complain` and
`suggestion-box` alongside the `paperclip` operational skill, including existing
agents with empty optional-skill selections. The shared helper lives in that
operational skill at `scripts/submit-agent-commentary.mjs`. It reads the body
from stdin and uses the existing `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`,
`PAPERCLIP_COMPANY_ID`, and `PAPERCLIP_RUN_ID`. The helper uses the existing
Node.js runtime with no additional dependencies; custom runtimes can call HTTP
directly. Sandboxed runs use the callback bridge.

Native runs receive `submit_complaint({body, idempotencyKey})` and
`submit_suggestion({body, idempotencyKey})` in standard, ask, and planning modes.
Specialized completion-review runs retain their restricted tool set. Native
submission uses the bound authority without a shell or API credential.
Submit before finishing the run.

Instructions closely adapt Warp's
[complain](https://github.com/warpdotdev/common-skills/blob/main/.agents/skills/complain/SKILL.md)
and [suggestion-box](https://github.com/warpdotdev/common-skills/blob/main/.agents/skills/suggestion-box/SKILL.md)
skills, with their MIT notices included. Paperclip changes the transport,
attribution, suggestion form, and size limit. Agents submit proactively when
warranted, without routine previews or announcements, then continue working.
Answer truthfully if a user asks about feedback or submitted content. Operators
can exclude these legacy skills through the existing runtime skill policy.
Brevity and at most three suggestions per run are guidance, not server quotas.
Do not report the same incident through both paths or retry failed submissions.

## HTTP contract

`POST /api/companies/:companyId/agent-commentary` accepts an authenticated agent
and its active run (`Authorization: Bearer …`, `X-Paperclip-Run-Id: …`):

```json
{"kind":"suggestion","body":"The tool returned before persistence completed. Wait for the write before returning success.","idempotencyKey":"write-completion-1"}
```

Only these three fields are accepted. Identity and the optional task reference
are server-derived. Board callers cannot impersonate agent feedback. Native runs
use their dedicated tools rather than this legacy HTTP path.

Bodies must contain non-whitespace text and may contain up to 524,288 JavaScript
string code units, matching ordinary issue documents. No truncation is applied.
Existing 10 MiB HTTP and callback bridge request limits remain. Keys are nonempty
and at most 240 characters.

Creation returns HTTP 201 with `{id, kind, createdAt, replayed:false}`. Identical
replay in the same company/run returns HTTP 200 with the same ID and timestamp
and `replayed:true`. Conflicting key reuse returns 409. Invalid input returns 400;
invalid authority returns 401/403; storage failure returns a sanitized 503.
Authorization precedes replay. The helper accepts an optional second argument
for a stable key, generating one otherwise. It makes one request with a
10-second HTTP deadline and exits zero on failure with a content-free diagnostic.
It never follows redirects with credentials or claims an uncertain write succeeded.

## Storage and inspection

Rows contain company, agent, run, nullable issue, kind, body, retry key, payload
hash, and timestamp. Known run secrets and credential syntax are redacted before
storage; instructions remain essential because redaction cannot guarantee
secrecy. Writes and one content-free activity record commit together. Feedback
bodies are excluded from HTTP diagnostics and dedicated mutation receipts.

There is no feedback UI, read API, notification, automatic task creation, or
external forwarding. This is separate from first-party Telemetry, OpenTelemetry
Observability, and the run log. Ordinary provider transcripts can still contain
submitted tool arguments; there is no anonymity or ephemeral-storage promise.

Authorized operators inspect the instance database, for example:

```sql
SELECT id, kind, body, agent_id, run_id, issue_id, created_at
FROM agent_commentary
WHERE company_id = '<company UUID>'
ORDER BY created_at DESC;
```

The service enforces company/run ownership. Foreign keys clear the task reference
on task deletion and cascade deletion with its run, agent, or company. Normal
logical database backups include these rows. No retention scheduler or backfill.

## Verification

Focused coverage lives in `server/src/__tests__/agent-commentary.integration.test.ts`,
`agent-commentary-helper.test.ts`, `agent-commentary-skills.test.ts`, the shared validator tests, and the HTTP logger
and sandbox callback bridge suites. These exercise real PostgreSQL and routes,
atomic audit rollback, replay races, authority changes, deletion, default mounts,
Unicode, and the exact document-body boundary.

The opt-in live smoke uses existing Codex login credentials, copied to a private
temporary home, and a disposable instance database. It calls the real legacy
adapter and production native-session executor. It incurs normal provider usage:

```sh
node cli/node_modules/tsx/dist/cli.mjs server/scripts/verify-agent-commentary-live.ts
```

To run the same checks on real Daytona sandboxes, install the standalone
provider's dependencies, provide its API key and an immutable image reference,
and specify a Linux amd64 runner built from this checkout:

```sh
pnpm --dir packages/plugins/sandbox-providers/daytona install --frozen-lockfile
PAPERCLIP_LIVE_ENVIRONMENT=daytona \
PAPERCLIP_LIVE_DAYTONA_ENV_FILE=/path/to/private.env \
PAPERCLIP_LIVE_LINUX_RUNNER=/path/to/linux-amd64/paperclip-runnerd \
PAPERCLIP_LIVE_EVIDENCE_PATH=/tmp/commentary-evidence.json \
node cli/node_modules/tsx/dist/cli.mjs server/scripts/verify-agent-commentary-live.ts
```

The private env file needs only `DAYTONA_API_KEY` and
`PAPERCLIP_E2E_DAYTONA_IMAGE` (`...@sha256:...`). Alternatively, export those
variables directly. A positional `legacy` or `native` argument selects one path.
For a current Linux runner, add an export stage to a temporary copy of the root
Dockerfile and build it with `--platform linux/amd64 --target commentary-runner-export
--output type=local,dest=/tmp/commentary-runner-linux`:

```dockerfile
FROM scratch AS commentary-runner-export
COPY --from=runner-build /app/packages/paperclip-runner/runner/target/release/paperclip-runnerd /paperclip-runnerd
```

The smoke calls the production Daytona provider hooks for creation, execution,
file transfer, private ingress, and confirmed deletion. Legacy feedback crosses
the sandbox queue callback bridge. Native feedback crosses the runner's private
WebSocket and live tool authority. The current Linux runner is staged and
verified independently of the base image. Fixture setup creates authority;
the real agent submits all feedback. This is a focused feedback transport smoke,
not a full Runner E2E catalog qualification or browser onboarding test.

Both paths passed locally and on Daytona on 2026-10-06. Each persisted one complaint and one suggestion
with company, agent, run, and task attribution; each then wrote the continuation
marker. Both exited zero, left task status unchanged, created no task comments,
and recorded two content-free activity entries. The script emits the attributed
row IDs and timestamps as evidence, optionally saves a JSON report, and deletes
its temporary data, credentials, and remote sandboxes. Remote reports are emitted
only after confirmed sandbox deletion.

The Daytona verification used base image
`ghcr.io/paperclipai/paperclip-daytona-runner@sha256:b81a86d5242088f9d832666a411f09da7438d92e99f9962ccf88ebe439cd3b32`
and the Linux runner built from `abf47b5953d14aa7a8dbf2941460b5df8a4d66c3`
(binary SHA-256 `c794141152ae2e2986da0df14b01a54e4448949e06ec4031c83bad8a9fff8bac`).

| Environment | Runner | Complaint row | Suggestion row | Submitted at (UTC) |
| --- | --- | --- | --- | --- |
| Local | Legacy Codex | `59413a00-1de2-4bb1-bcc6-9c4b54c64aa6` | `3db2364d-3e15-4f47-846f-875d3902999d` | 20:35:10 |
| Local | Native Codex | `5da22b5f-41df-4de5-8ba0-d9345ab01267` | `2d5abe17-dd41-403c-a5ee-4729f2d58921` | 20:35:26–20:35:27 |
| Daytona | Legacy Codex | `27c9d0aa-8477-409f-9da0-e8ffa48dee50` | `209681c9-d1e9-4ce1-999e-48fa07692389` | 20:33:07–20:33:09 |
| Daytona | Native Codex | `6eb001bb-4bcf-43f7-8717-f662f53dc7c3` | `77c383d8-a997-49e5-a33e-25c70e15c0b2` | 20:31:54 |
