# Public Paperclip MCP connection

The first-release implementation connects an external assistant **as a person**
to one explicitly selected company. It exposes first-party task operations and
keeps normal Paperclip authorization, scheduling, attribution, budgets and
approvals. The existing named agent gateways and native runner checks remain
separate. The accepted roadmap is in
[the implementation plan](plans/2026-09-30-paperclip-public-mcp-and-plugins.md).

## Enable an instance

Apply database migrations with the normal instance upgrade workflow. In Paperclip,
open **Settings → Experimental → Assistant connections (MCP)** and turn it on.
Instance administrators can change this setting. It is off by default and takes
effect immediately without restarting the server.

Use the instance's configured authentication public URL, or explicitly set:

```sh
PAPERCLIP_PUBLIC_URL=https://YOUR-PAPERCLIP-HOST
```

The retired `PAPERCLIP_PUBLIC_MCP_ENABLED` variable has no effect. The persisted
`enablePublicMcp` setting controls discovery, sign-in, tools and event delivery.
Turning it off blocks new calls and deliveries; already delegated work continues.
Connection management and revocation remain available. Turning it back on allows
unexpired connections and subscriptions to resume.

The URL must be an origin without a path, credentials, query or fragment. HTTP
is allowed only for localhost/loopback development. The feature is disabled by
default. Use authenticated deployment with real user accounts and company
memberships; local implicit board authority and agent/board API keys cannot
approve user OAuth connections. Configure `TRUST_PROXY` correctly at your edge.

The endpoint is `POST /mcp/paperclip`, using stateless Streamable HTTP with JSON
responses. GET/SSE sessions are unnecessary. Each invocation verifies its bearer
token again; normal API endpoints do not accept these OAuth tokens. Public
installation requires a reachable HTTPS deployment. Private self-hosted
instances require a directly reachable endpoint; no managed relay is included.

## Connect an assistant directly

After the instance is enabled and reachable, an existing team member can connect
without a store listing. For Codex CLI:

```sh
codex mcp add paperclip --url https://YOUR-PAPERCLIP-HOST/mcp/paperclip
codex mcp login paperclip --scopes paperclip:read,paperclip:write,offline_access
```

For Claude Code:

```sh
claude mcp add --transport http paperclip https://YOUR-PAPERCLIP-HOST/mcp/paperclip
```

Open Claude Code's `/mcp` menu and authenticate the Paperclip server. Both flows
open browser sign-in and consent: review the selected organization (or choose one for a direct instance connection) and review the write-access checkbox. It starts checked when the assistant requests
writes and your organization role allows them; uncheck it for read-only access. Read-only consent cannot delegate work.

Ask the assistant to identify the connected organization and list its agents, then ask
it to delegate a small task to an available agent. The returned task link is the
durable reference. In a later conversation, ask for that task's progress and
report. Configure the agent's provider credentials, execution environment and
budget in Paperclip before expecting it to run; the assistant connection does
not supply them. Revocation is available at `/assistant-connections`.

The optional [workflow packages](../integrations/assistant-plugins/README.md)
teach team review, delegation and result retrieval. Build them for the same
endpoint before installing locally. Public ChatGPT/Codex and Claude directory
installation requires the separate deployment and submission work below.

## Identity and consent

- Protected-resource discovery: `/.well-known/oauth-protected-resource/mcp/paperclip`.
- Authorization-server discovery: `/.well-known/oauth-authorization-server`.
- Public-client registration: `/mcp/oauth/register`.
- Authorization, token and revocation endpoints: `/mcp/oauth/authorize`,
  `/mcp/oauth/token`, `/mcp/oauth/revoke`.
- Browser consent: `/mcp-connect/:requestId`.
- User connection management: `/assistant-connections`.

Consent identifies the registered client and callback origin. Client names are
self-reported; verify the receiving domain before approving an unexpected request.
The hosted organization chooser also identifies the original client and callback
origin before its tenant handoff.

Dynamic registration uses public clients, exact registered HTTPS redirect URIs
(or HTTP loopback), authorization code flow, S256 PKCE and exact resource
binding to the endpoint. Authorization requests expire in ten minutes; codes
expire one minute after consent and are single-use. Access tokens expire in
fifteen minutes. `offline_access` issues a thirty-day rotating refresh token;
replaying a consumed refresh token revokes its entire grant. Tokens and codes
are hashed at rest. `paperclip:read` is required; `paperclip:write` adds only task
creation and comments. Scope expansion requires a new consent flow.

Each grant records the person, client, company, resource and scopes. Membership
and company availability are rechecked at execution. Instance admin status does
not elevate a grant beyond that company's role. Consent/revocation require an
authenticated browser and the configured origin. Client registration does not
fetch redirect URLs or accept arbitrary tool destinations. Rate limiting at the
public edge is required in addition to the bounded per-process auth limiter.
Registration also has a database-enforced limit of 60 new clients per minute and
10,000 unconsented clients shared across replicas. Expired authorization requests
and never-consented clients older than one hour are collected during
registration. Clients with grants are retained, preserving their connections and
audit/mutation history.

Revocation blocks future calls; it does not cancel already delegated work or
undo in-flight mutations. Manage existing tasks and execution in Paperclip.
Audit records identify the human caller and connection/client for mutations.
OAuth credential bodies and redirect locations are redacted from HTTP logs.

## Tool surface

| Tool | Effect |
| --- | --- |
| `paperclip_connection` | Person, company, scopes, connection management link |
| `paperclip_list_agents` | Safe agent summary and availability |
| `paperclip_list_projects` | Safe project summary |
| `paperclip_search_tasks` | Bounded task search with offset pagination |
| `paperclip_read_task` | Current task plus recent comments/history |
| `paperclip_create_task` | Assigned task, submitted to existing scheduling |
| `paperclip_add_comment` | Human feedback; may wake or queue work |
| `paperclip_list_deliverables` | Documents and work-product references |
| `paperclip_read_document` | Durable document body |
| `paperclip_pending_approvals` | Pending approvals and existing decision links |

Every company-scoped call requires its explicit authorized company ID. The
server emits bounded projections rather than agent configurations or upstream
credentials. URLs include the company's prefix so unrelated browser company
selection cannot redirect the user to a different team's approval interface.

Writes require a UUID `requestId`, unique per intended action. A durable receipt
is reserved before dispatch, keyed by person, company, operation and request ID (with the originating grant recorded for audit). Matching
retries, including after a new authorization grant, replay the recorded result; changed arguments are rejected. A concurrent
or unconfirmed result is reported as `outcome: unknown`. Inspect the task and
comments before another action; never retry with a new ID to force success.
A known HTTP rejection is recorded and replayed as `outcome: rejected`.

The REST bridge dispatches only paths constructed by the closed tool catalog,
with a request-local verified actor. Existing handlers enforce all domain checks
and own their transaction/scheduling semantics. Receipts do not turn existing
asynchronous scheduling into an exactly-once execution guarantee. Creating a
task is not proof that an agent started or finished it.

## Hosted onboarding and release gates

When `PAPERCLIP_CLOUD_API_ORIGIN` is present, consent links to the existing Cloud
`/orgs/new` flow in a separate tab. Provisioning, mission/template selection,
model credentials, execution capacity and spending remain owned by Cloud.
Installing a plugin never provisions a company or starts paid agents.

This repository implements the instance-side connection and vendor packages.
The companion Cloud implementation supplies the stable public resource, an
account-to-stack OAuth broker, explicit organization selection and a return from
hosted organization creation. Its public connection screen resumes normal
sign-in, lists authorized organizations, reports provisioning/sleeping states,
and links to tenant setup for mission, templates, execution and spending.

The Cloud broker forwards the original PKCE challenge to tenant OAuth, validates
the resulting person, and wraps tenant credentials in encrypted tokens bound to
client, workspace and resource. Every call rechecks current Cloud membership and
verified routing; the tenant rechecks company permissions and revocation.
Cloud stores request metadata and code hashes, not raw tenant tokens. Unknown
mutation outcomes preserve the existing request-ID receipt contract.

Deploy both sides before hosted use. Cloud's tenant front door forwards only
exact discovery, OAuth protocol and MCP paths without minting human authority;
consent and management retain normal browser entry. The Cloud broker remains
opt-in and requires its own durable OAuth state and encryption key from the
provider secret store. Installing these source packages does not deploy an
endpoint, open signup, register a listing, or provision execution capacity.

Before release, exercise actual ChatGPT/Codex and Claude connections against a
staging HTTPS deployment, including client registration, consent, refresh,
revocation, reconnect, task delegation and retrieval from another conversation.
Prove scheduled execution on a controlled agent and the new-user Cloud return
journey. Local OAuth interoperability has been verified with Codex CLI 0.153.4
and Claude Code 2.1.245, using disposable Cloud/tenant fixtures. Protocol tests,
CLI login and local package validation do not replace these release gates.

External sessions acting as agents, task leases and third-party granted tools
remain the second/third releases; do not add generic executors to this public
catalog to implement them.

Registration also enforces shared source quotas (6 per minute and 30 unconsented
clients) using a resource-bound hash of the trusted request IP; raw addresses are
not stored. Configure trusted proxies correctly. Authorization starts atomically
remove expired requests and enforce 10 pending-consent requests per client and 1,000
instance-wide, independently of further client registrations. Existing grants
remain usable when anonymous registration or authorization is throttled.

## Task monitoring with MCP Events

The same authenticated endpoint now supports MCP 2.0 (`2026-07-28`) alongside
legacy MCP. It advertises `events` through `server/discover` and implements
`events/list`, `events/subscribe`, and `events/unsubscribe`. MCP 2.0 requests
include matching `MCP-Protocol-Version`/`Mcp-Method` headers, per-request version
and client-capability metadata, and `Mcp-Name` for tool calls. Existing
initialize-based clients keep the ten-tool connection.

| Event | Required filters | Payload |
| --- | --- | --- |
| `paperclip.task.status_changed` | `companyId`, `taskId`; optional `statuses` | Task ID, status, company ID and task link |
| `paperclip.task.comment_created` | `companyId`, `taskId` | Task/company IDs, comment ID and task link |
| `paperclip.task.document_updated` | `companyId`, `taskId` | Task/company IDs, document key, revision and task link |

In an Events-capable ChatGPT Work Cloud chat or dot, ask, for example:
“Watch this task. When it finishes, read its report and tell me the result.”
The host supplies a callback URL and signing secret and owns refresh/unsubscribe.
Rescan the plugin's MCP server to discover the event catalog. Installing or
connecting alone does not start monitoring. Claude and other clients without
Events support can continue retrieving results through the read tools.

Callback and hosted-authority verification reserve durable capacity before any
remote request. Across replicas, at most 2 verifications per grant, 8 per company
and 32 per instance can run concurrently. Attempts are bounded to 30 per grant,
200 per company and 1,000 per instance per minute, including failed verification.
New monitors reserve subscription quota before verification; leases expire after
one minute. Network waits hold no database transaction, and expired, cancelled
or revoked requests cannot finalize a subscription.

Delivery uses a verified HTTPS callback, Standard Webhooks HMAC signatures,
public-address DNS pinning on every connection, and no redirects. Callback URLs,
current/previous signing keys and hosted authorization proofs are encrypted with
the existing instance secrets master key. Back up that key with the database.
Callback bodies contain bounded references, not comment/document text; clients
must read current authorized state before responding or taking an action.

Subscriptions last at most 24 hours (default), with a 30-second minimum. Hosted
subscriptions last at most five minutes and never outlive the broker access
proof: refresh the OAuth token before refreshing a subscription when necessary.
The tenant verifies that proof through the fixed `PAPERCLIP_CLOUD_API_ORIGIN`
broker before each delivery, checking current Cloud membership as well as local
company membership, grant revocation and task access. A compatible Cloud broker
must be deployed first for hosted Events. Direct connections to a Cloud tenant
without a broker authority proof cannot create event subscriptions.

Subscriptions and delivery receipts persist across restarts. Activity is scanned
without a moving timestamp high-water mark; unique receipts prevent duplicate
queue entries and concurrent workers claim deliveries atomically. Delivery is
at least once, with up to six attempts and exponential backoff. IDs stay stable
across retries while signatures receive fresh timestamps. HTTP 410 stops a
monitor; 413 and other permanent failures are not retried. Secret rotation signs
with both keys for five minutes. Expired subscriptions and their receipts are
removed on the next admission or after seven days; active quotas are 20 per
grant, 100 per company and 1,000 per instance. Unsubscribe frees the subscription and its receipts.

This release returns `cursor: null`: it does not offer protocol replay after an
expired/stopped subscription. Use task history and document tools to recover
missed changes. In-flight requests may finish during unsubscribe/revocation;
subsequent attempts recheck access. Events are data, and may be duplicated or
out of order. Do not post comments merely to acknowledge comments or documents,
which would risk a feedback loop. Approval decisions remain in Paperclip.

See [OpenAI's MCP Events guide](https://developers.openai.com/plugins/build/mcp-events)
for currently supported client surfaces. Actual staging ChatGPT subscription,
plugin rescan and event-triggered response are still deployment acceptance gates;
local protocol and paid model tests do not establish store/UI readiness.

## Storybook previews

Run `pnpm storybook` and open the **Assistant connections** group. The stories
render the production consent, connection-management, and Experimental pages,
including read-only roles, loading, empty, unavailable, pending, revoked, and
failed-save states. Interactive stories verify organization-switch consent reset,
revocation, and settings rollback. All MCP actions use per-story in-memory
fixtures; no credentials are issued and no work is delegated.

The Cloud repository's `web` Storybook has **Assistant connections / Hosted
connection** for sign-in, organization selection, and the create-and-return
flow. OAuth redirects between the two services remain mocked in these previews.

### Guided assistant walkthrough

Open **Assistant connections → Start here → Guided walkthrough** for a
presenter-led story about Alex connecting Acme Research. Each step explains
where Alex is, what to try, what happens next, and a question to discuss.
Next/Back and numbered chapters control the explanation independently of the
interactive product preview; Reset this screen restores that step’s fixture.
Each screen starts fresh, so sample state does not persist between chapters.

The Cloud walkthrough covers sign-in, choosing or creating an organization,
readiness, and the handoff. The Paperclip walkthrough covers the experimental
setting, organization consent, example delegation and retrieval conversations, and
revocation. Assistant conversations are explicitly illustrative; product
screens use isolated service fixtures. No paid work or real OAuth runs here.

Local cross-links expect Paperclip Storybook on port 6106 and Cloud on 6107.
The default scripts use port 6006; launch these in separate terminals with
explicit overrides:

```sh
# From the Paperclip repository's ui/ directory:
pnpm exec storybook dev --port 6106 --config-dir storybook/.storybook --no-open

# From the paperclip-cloud repository's web/ directory:
npm run storybook -- --port 6107
```

When published elsewhere, open the companion Storybook separately. Each
walkthrough works independently. **Navigation check** is a separate interaction
story so the presentation itself never advances automatically.

### One organization from Cloud through consent

Cloud selects an organization once and sends its registry company ID as the
optional OAuth `company_id` parameter. Paperclip persists it as
`mcp_oauth_requests.requested_company_id`, filters the consent response to that
company, and rejects approval for any other company even if the user belongs to
both. It is a scope restriction, never a substitute for active membership or
explicit read/write consent. A deleted, archived, or inaccessible company cannot
fall back to another one. The UI shows the fixed organization and permissions,
with cancel/reconnect guidance if it is unavailable.

Direct instance requests without `company_id` retain their organization picker.
There is no separate “team” entity in this flow. Cloud’s organization maps to its
stack’s primary Paperclip company; the stack is hosting infrastructure. The hosted
walkthrough uses **Consent → Hosted organization**; direct selection, read-only,
and unavailable-organization variants remain separately inspectable.

Apply the additive nullable request-column migration before running this tenant
version, and deploy tenant support before the Cloud broker that sends the binding.
Existing direct requests and grants are unchanged.
