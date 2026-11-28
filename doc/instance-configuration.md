# Instance configuration switches

Environment switches and startup configuration that are not part of everyday local development.

## Internal Connection Token Brokers

Paperclip Cloud connector identities support `development`, `test`, `staging`,
and `production`. To enroll a self-hosted instance against the test broker, set
`PAPERCLIP_CLOUD_CONNECTOR_BASE_URL=https://test.paperclip.app`; its environment
is inferred as `test`. Managed instances also receive
`PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT=test`. Standard Cloud broker hosts reject
identities for another environment, and enrollment keys remain local to the
selected broker.

Connection token exchanges carry a resolved parent credential, so their URLs
are public-only by default even in local/private deployments. To intentionally
use an internal broker, configure an exact hostname allowlist:

```sh
PAPERCLIP_TOKEN_BROKER_ALLOWED_HOSTS=broker.internal.example,10.0.0.42
```

Entries are comma- or whitespace-separated exact hostnames (no wildcards). The
host configured by `PAPERCLIP_PAGES_API_URL` is included automatically. Every
broker hostname is resolved once and the request is pinned to the approved
address; IPv4 and IPv6 link-local destinations remain denied even when their
host is allowlisted.

## HTTP Adapter Private Endpoints

HTTP adapters can call public HTTP(S) endpoints by default. Requests use the
same DNS-pinning guard as remote connections, do not follow redirects, and
reject loopback, RFC1918/private, and link-local or cloud-metadata destinations.

Server owners can opt a trusted private service in with a comma-separated list
of exact origins:

```sh
PAPERCLIP_HTTP_ADAPTER_PRIVATE_ENDPOINT_ALLOWLIST=http://hooks.internal.example:8080,https://10.0.0.42
```

Each entry must contain only a scheme, hostname, and optional port. Paths,
credentials, query strings, fragments, and wildcards are ignored. Matching is
by exact normalized origin, so allowing one port does not allow another.
Link-local destinations remain denied even when explicitly listed.

## Company Deletion Toggle

Company deletion is intended as a dev/debug capability and can be disabled at runtime:

```sh
PAPERCLIP_ENABLE_COMPANY_DELETION=false
```

Default behavior:

- `local_trusted`: enabled
- `authenticated`: disabled

## Chat query compilation reuse

Set `PAPERCLIP_CHAT_IDLE_OPTIMIZATIONS=true` to reuse the compiled
receipt-reaction and Telegram maintenance candidate queries. Only `true`
enables it; the default is `false`. Restart after changing it. The startup log
reports the selected mode.

Each execution reads the database with fresh clock, limit, and action-ID
parameters. The cache holds compiled query objects, never rows, credentials, or
authorization decisions. Operations still resolve current credentials and
permissions.

This option works with the current commit/deadline-driven chat queues. It does
not change wakeups, retry deadlines, recovery scans, publication ordering,
receiver discovery, or the `DATABASE_PREPARED_STATEMENTS` driver setting.
GitHub's scoped workers retain their own service lifetime. Allocation and memory
savings have not been measured for the current worker implementation.

## Cloud startup configuration

Cloud stores nonsecret startup choices in a private PostgreSQL singleton.
Bootstrap connection credentials stay in the supplied environment. A bounded
one-time config-file seed preserves existing choices, then later starts use the
database without loading home `.env` files or repairing worktree config. See
[Cloud runtime configuration](cloud-runtime-configuration.md) for field ownership,
secret handling, initialization order and migration interfaces.
