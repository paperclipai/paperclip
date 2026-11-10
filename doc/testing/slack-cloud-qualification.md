# Local Slack App/Cloud qualification

This opt-in qualification uses the normal App owners, a companion Cloud checkout,
real PostgreSQL, and controlled Slack/Codex protocol boundaries. It does not call a
model or Slack, deploy a tenant, or prove Neon suspension. Ordinary tests skip this
one case unless the explicitly named fixture URL and owned state file are present.
The runner supplies the state file; do not construct a receipt or a trusted key set.

Use Node 24 for App, Node 22 for Cloud, and Python 3.9 or newer. Install and build
both checkouts through their normal repository commands first. In the companion
Cloud checkout, `npm run build:test` must emit its own current source. App needs its
normal workspace prerequisites and server typecheck (`pnpm --filter
@paperclipai/server typecheck`). The runtime helper does not install dependencies,
compile a substitute program, copy another checkout's output, or start PostgreSQL.

Create one fresh, caller-owned App/Cloud test database pair on the same loopback
PostgreSQL cluster. The names must be `sleep2_slack_form_<name>_app_test` and
`sleep2_slack_form_<name>_cloud_test`. Provide the matching `/postgres` admin URL.
The URLs must use `postgres://`, an explicit port, and test-only credentials. Never
point the helper at a production database. Normal migration owners apply the full
retained executable migration history; this helper neither substitutes a schema
nor drops databases.

Run from the App checkout with these environment variables set:

```sh
export PAPERCLIP_CLOUD_REPO_ROOT=/path/to/owned/cloud-checkout
export PAPERCLIP_SLACK_NODE24=/path/to/node24/bin/node
export PAPERCLIP_SLACK_NODE22=/path/to/node22/bin/node
export PAPERCLIP_SLACK_TEST_DATABASE_URL=postgres://paperclip@127.0.0.1:55448/sleep2_slack_form_local_app_test
export SLACK_EVENT_TEST_DATABASE_URL=postgres://paperclip@127.0.0.1:55448/sleep2_slack_form_local_cloud_test
export PAPERCLIP_TEST_POSTGRES_ADMIN_URL=postgres://paperclip@127.0.0.1:55448/postgres
python3 server/src/__tests__/helpers/slack-cloud/run-enabled-quiet.py /path/to/fresh-output-directory
```

The runner starts the actual Cloud owner host and exactly one whole normal Vitest
case. The controlled CLI uses only the minted current-run token to check out its
admitted task, post its attributed reply, and complete the task through ordinary
APIs. Its canonical CLI final message lets normal presentation reuse that comment.
The controlled Slack endpoint must receive the exact useful text and provider ID;
a database publication or synthetic receipt cannot replace that observation.

Each phase keeps the endpoint and connection enabled. After normal work settles,
the case waits for actual used App-worker PostgreSQL sockets to close with the
normal 60-second idle default, inside the existing 95-second settlement budget.
An already-required useful/query call proves the PG write counter is live. It
samples scalar counters immediately before and after the original 30-second window,
with the end sample taken before later inspection queries. The window requires
zero PG writes, connect attempts/connections/closes, live/peak PG sockets, outbound
requests and non-PG connection attempts. It then admits fresh signed work plus its
duplicate, requires a second distinct useful result, and repeats the same window.
No query text, wire payload, token, or private key is recorded by the counters.

The plaintext same-worker hooks do not establish a cross-process or OS-wide socket
census. Missing Vitest-worker EXIT evidence is reported explicitly, even when its
final PG counters and sampled process-group absence are known. Real detached useful
helpers and version probes require their own entry and EXIT 0 evidence. The runner
joins owned groups and closes the normal Cloud/App owners before returning. It
retains failed evidence and does not mark a failed attempt green after a retry.

Keep the output directory private: it contains diagnostic logs and source/owner
identity receipts. State containing synthetic fixture credentials stays in a
mode-0700 temporary root and is not copied into the report. A caller may inspect
and remove successful fixture databases only after all owners close. This test
does not qualify managed JWKS distribution/rotation, Photon, Discord, Cloud's own
PostgreSQL quiet, deployed sleep, or physical suspension.
