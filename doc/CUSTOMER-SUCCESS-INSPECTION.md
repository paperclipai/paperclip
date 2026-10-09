# Cloud customer-success inspection support

Paperclip exposes `/api/customer-success/v1/run-authority` and `/read` for the
coordinated Cloud inspection broker. This foundation supports one registered
Paperclip agent; bot creation, scheduling, scoring and reporting are separate.

The authority endpoint is disabled unless
`PAPERCLIP_CUSTOMER_SUCCESS_AUTHORITY_ENABLED=true`. It accepts only a strict,
current instance/company-derived managed-run JWT. It requires the authenticated
agent's existing provisioned Ed25519 identity and an active running heartbeat;
paused, cancelled/stopped, finished and unsupported-runtime agents are rejected.
No identity GET provisions keys. Normal API JWT compatibility remains unchanged;
legacy signatures are rejected specifically at this authority boundary.

Tenant reads are disabled unless
`PAPERCLIP_CUSTOMER_SUCCESS_INSPECTION_ENABLED=true`. Configure the public-only
`PAPERCLIP_CUSTOMER_SUCCESS_INSPECTION_JWKS` and the stable HTTPS
`PAPERCLIP_CUSTOMER_SUCCESS_CLOUD_ORIGIN`. Cloud provision/roll delivers the trust
configuration. The persisted runtime stack identity is authoritative; an explicit
`PAPERCLIP_CLOUD_STACK_ID` is usable on operator-configured qualification stacks.
Cloud's dedicated inspection key is distinct from the inspecting agent's key.

The tenant verifies a maximum-sixty-second, audience/type-bound Ed25519 permit
with exact stack, query, grant, registered key/agent/run, request and binding
version. It calls Cloud's permit-consumption endpoint before reading, so replay
fencing and every inspection record live in Cloud. Cloud remains responsible for
stack eligibility, seven days from creation/pooled claim, human older-stack
approval, active source-run checks, limits, revocation and audits. The source run
bearer is never forwarded to tenants.

The namespace terminates before actor middleware. It never creates users,
memberships, sessions, run-identity snapshots, activity records or read receipts.
All database readers run inside repeatable-read, read-only transactions. An
explicit catalog avoids existing GET side effects such as skill reconciliation,
instruction recovery/adoption and provider-trace cleanup. There is no arbitrary
GET proxy, write operation or credential-resolution operation.

The catalog in `services/customer-success-inspection.ts` covers companies,
directory/membership/permission metadata, agents/config/instruction revisions and
public identity, tasks/comments/documents/interactions, approvals/decisions,
routines/schedules, projects/workspaces/stored repository assignments, skill
sources/versions, execution events/trace metadata, activity/costs, work products/
assets/attachments, and existing readable connections/installs/grants/catalogs.
`packages/shared/src/customer-success.ts` is the versioned wire contract and is
mirrored byte-for-byte in the private Cloud broker; update both together.

`list`/`get` readers enforce company scope and bounded pagination. Special
operations read instruction files without repair, installed skill snapshots,
existing run logs, workspace files through the current file-resource service,
and company-scoped storage assets. Workspace context uses an owning task and
existing project/workspace checks. Binary envelopes and inclusive byte ranges
pass through Cloud; ranges cap at 1 MiB, JSON at 2 MiB, and lists at 100 rows.
Remote or unsnapshotted resources report unavailable; large content requires
pagination or download ranges. No storage credentials or bypass URLs are issued.

Existing config/event/run redactions and path/symlink/secret-file/size restrictions
remain in use. Authentication account/session, secret, private-key/encrypted-key
and raw provider-trace tables/readers are excluded. Identity-enabled trace
suppression stays intact. No new prose/file scanner is added; arbitrary pasted
secrets in otherwise readable content may be present.

Deploy this support first, then Cloud's migration/broker/admin UI. Keep both
inspection and Cloud policy disabled until staging and internal canary checks
pass. Wake only idle sleeps through Cloud's existing controller; normal startup
and background writes after wake are separate from the inspection read. Existing
human login/Slack alerts are unchanged.

Focused verification:

```sh
pnpm exec vitest run server/src/__tests__/customer-success.test.ts \
  server/src/__tests__/agent-auth-jwt.test.ts server/src/__tests__/agent-identity.test.ts
# Coordinated qualification, with the sibling Cloud build:
PAPERCLIP_INSPECTION_CLOUD_DIST=/absolute/path/paperclip-cloud/dist \
  pnpm exec vitest run server/src/__tests__/customer-success-cloud.test.ts
```

The coordinated test uses two disposable local PostgreSQL databases, a real
managed process with the existing identity/env injection, a PostgreSQL-backed
Cloud broker, HTTP permit consumption, the existing wake controller with a local
provider, and bounded binary file reads. It tests durable replay fencing and
never touches a customer. Cloud's operations document covers enrollment,
capability grants, exclusions, approval/expiry/revocation, audit retention and
rollback. During rollback, disable Cloud policy first, disable tenant inspection,
and preserve identity material and Cloud audit history.
