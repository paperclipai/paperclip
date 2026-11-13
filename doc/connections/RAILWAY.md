# Railway

Updated: 2026-09-16. Status: implementation review; live provider qualification outstanding.

Railway appears in Apps and uses Paperclip's shared remote-MCP OAuth connection,
vault, catalog, grants, policies, gateway, and audit trail. It is a resource
connection, not Paperclip sign-in. No plugin or database migration is required.

## Connect and use

1. Open Apps → Railway → Connect.
2. Sign in to Railway and choose the workspaces offered on its consent page.
   If dynamic registration is rejected, supply a registered Railway OAuth client
   in the existing customer-client setup. Local loopback consent has succeeded;
   HTTPS and customer-client registration still require qualification. Do not supply a Railway project token to
   the hosted MCP endpoint.
3. Review the discovered actions. Install the connection for selected agents.
   Active actions start Allowed under the current product default. Choose Ask
   first for deployment actions or commands that need operator review.
4. Refresh actions to check API access. Paperclip uses the hosted `list-workspaces`
   read to discover a workspace, then makes a bounded project query with that
   explicit workspace ID and the actual OAuth credential before adding direct tools.
   Account-wide project queries are not valid probes for workspace-scoped consent.
   Railway documents OAuth access to GraphQL, but a hosted-MCP token is not
   assumed to have a suitable audience. Rejection leaves hosted tools available
   and direct operations unavailable. No other credential is used as a fallback.
5. Have an agent list projects, services and environments through the gateway,
   then inspect an explicit service/deployment target. Never paste OAuth tokens
   or private SSH keys into agent prompts or runtime configuration.

Use a public HTTPS Paperclip origin, or a loopback HTTP origin such as
`http://localhost:3100`. The shared callback is `/api/tools/oauth/callback`.
The configured canonical auth origin controls the callback. A plain HTTP tailnet
hostname is not loopback; use HTTPS or change the local canonical origin before
connecting. Loopback consent succeeded locally; HTTPS still needs live proof.

## Capabilities and policy

| Action | Scope and limits | Classification |
| --- | --- | --- |
| Hosted project/service listing and feature-flag reads | Actual discovered schemas; provider credential scope | Read for reviewed names |
| Other hosted actions | Actual discovered schemas; provider credential scope | Write or destructive |
| Hosted `railway-agent` and `accept-deploy` | Disabled at discovery and denied at dispatch, including normalized aliases | Destructive; unavailable |
| `paperclip-railway-list-projects`, `list-services`, `list-environments` | Explicit workspace ID for projects, project ID for services/environments; 1–100 results per page, cursor ≤512 characters | Read |
| `service-status`, `list-deployments`, `deployment-status` | Explicit project/environment/service IDs; deployment ID where applicable | Read |
| `read-logs` | Build/runtime; ≤500 lines; time bounds/filter; ≤64 KiB of log entries | Read; sensitive application data |
| `redeploy`, `restart`, `rollback` | Exact deployment membership checked before mutation | Destructive |
| `deploy-revision` | Unavailable: the provider mutation cannot atomically bind the approved repository and commit; old catalog entries and calls are blocked | Destructive; unavailable |
| `run-command` | Exact running deployment/container instance, ≤60 seconds, ≤64 KiB combined output | Destructive; broad privileged access |

Direct tool names have the `paperclip-railway-` prefix. Railway may not shadow
this reserved namespace. These are fixed first-party gateway operations, not a
REST catalog entry or arbitrary GraphQL passthrough. GraphQL responses have a
1 MiB hard limit, redirects are refused, provider error bodies are not surfaced,
and deployment mutations are never automatically retried. After a timeout or
ambiguous error, inspect status before retrying. Redeploy returns the provider's
resulting deployment ID; restart/rollback use the provider's
boolean result and exact target ID rather than inventing a new deployment ID.

Railway enforces the workspace/account permissions granted by consent. The
project/environment/service labels in the catalog are **not local allowlists**.
Dedicated operations verify that all supplied IDs belong to the same target.
They do not narrow a workspace-wide credential to one service. Use provider
access controls and explicit Paperclip action policies to constrain authorization.
Hosted tool arguments and filters do not establish authorization boundaries.

The broad hosted Railway agent can perform multiple internal operations; a
request to read logs does not make it read-only. Staged changes accepted by
`accept-deploy` cannot be bound to the exact changes reviewed here. Both are
blocked by a narrow provider policy. Other providers and global defaults are
unchanged. New or changed Railway schemas are quarantined after initial discovery,
including reconnect flows that normally enable newly discovered actions.

Source deployment (`paperclip-railway-deploy-revision`) is also blocked. The
`serviceInstanceDeployV2` mutation accepts a commit SHA but cannot atomically
verify the approved repository. A separate repository check can race a provider
configuration change. Paperclip therefore offers 11 direct actions and no source
deployment action. Calls saved by an older server are denied before upstream
execution, including normalized aliases; refreshing actions marks their catalog
entries disabled. Source deployment requires an atomic provider binding before
it can be re-enabled. Redeploy uses an existing deployment's previous image.

## Container access

The connection's Permissions page includes Container access:

1. Select an authorization and generate a dedicated Ed25519 key.
2. Register its **public** key in the Railway account associated with that
   authorization. Workspace key management can require workspace-admin rights.
3. Supply an independently verified `ssh.railway.com` known_hosts line. A key
   collected over an untrusted connection is not verification. No trust-on-first-use
   or host-key-check bypass is provided.
4. Enable access, then grant the Run command action to trusted agents.

The private key stays in the instance vault, attached to one exact grant.
Personal keys retain their owner binding. Each command resolves that grant's key
after normal company/run/grant/policy checks. It uses a fresh temporary directory,
0600 key files, a fixed system OpenSSH executable, a minimal environment, and no
ambient SSH agent, user configuration, host directory, forwarding, or shared
control socket. Files are removed on success, error, timeout and cancellation.
The process must confirm remote command completion; SSH exit code zero alone is
insufficient. Noninteractive commands receive no stdin.

SSH connects to a deployed service **container**, not the underlying Railway host.
The SSH username is a deployment **instance** ID, checked against that deployment.
Commands can read secrets, change data, and make network calls. They can accomplish
mutations internally even if a dedicated deployment action is Ask first. Per-tool
policy cannot approve each shell sub-operation. Log and command output is sensitive;
known credentials and recognized secret patterns are redacted, but arbitrary
application secrets cannot all be recognized.

The default gateway budget includes the requested command timeout plus ten seconds
for target checks, capped at sixty seconds. An explicit caller deadline takes
precedence and can stop the command earlier. Timeout/cancellation terminates the
local SSH connection. Remote child process
termination is not guaranteed. Persistent interactive sessions, file upload,
unrestricted Railway CLI use and arbitrary local workspace deployment are out
of scope. Source deployment is unavailable as described above.

Removing the container key deletes local private material and its grant binding
in one transaction, including for revoked grants or disconnected connections.
Reconnect preserves the key binding. Also remove the public key in Railway to
revoke provider-side enrollment. Revoking the grant blocks new upstream executions. The shared gateway can replay
already completed results from invocation history; a replay does not contact
Railway. Revocation does not recall commands already running remotely.

## Protocol qualification record

Public probes and official documentation checked 2026-09-13:

| Property | Evidence / remaining qualification |
| --- | --- |
| Endpoint | Exact `https://mcp.railway.com` or root slash; other paths, query strings and lookalike hosts are not bridged |
| Transport | Provider documents hosted MCP; unauthenticated Streamable HTTP initialize POST with JSON/SSE Accept returns HTTP 401 |
| Challenge | `Bearer realm="mcp", resource_metadata="https://mcp.railway.com/.well-known/oauth-protected-resource"` |
| Protected resource | Resource `https://mcp.railway.com`, issuer `https://backboard.railway.com`, header bearer |
| Authorization | `/oauth/auth?resource=https%3A%2F%2Fbackboard.railway.com` on issuer; generic OAuth flow binds the requested MCP resource |
| Token / registration | `/oauth/token`, `/oauth/register` advertised on issuer |
| Revocation endpoint | Not advertised in observed metadata; local gateway revocation is enforced independently |
| Registration | DCR advertised, customer client supported by docs; no CIMD advertisement. Loopback automatic consent succeeded; public HTTPS and customer-client consent unproven |
| PKCE | S256 advertised and exercised by deterministic fixture |
| Scopes | Advertised: openid, profile, email, offline_access, workspace:member. Request openid/offline_access/workspace:member with prompt=consent |
| Refresh | Refresh grant advertised; docs require offline_access and explicit consent. Fixture covers failure; live refresh pending |
| Tool schemas | Live tools/list captured locally: 46 hosted actions, including narrow `get-status` and `get-logs`; 44 active after the two blocked opaque actions |
| Plan / approval | Account and appropriate workspace permissions required; plan limits, app approval and SSH enrollment permissions need verification on the test account |

Sources: [hosted MCP](https://docs.railway.com/ai/mcp-server),
[OAuth](https://docs.railway.com/integrations/oauth),
[OAuth tokens](https://docs.railway.com/integrations/oauth/login-and-tokens),
[consent/scopes](https://docs.railway.com/integrations/oauth/scopes-and-user-consent),
[GraphQL](https://docs.railway.com/integrations/api),
[SSH](https://docs.railway.com/cli/ssh), and
[official CLI GraphQL schema and commands](https://github.com/railwayapp/cli/tree/ac4f16e5f3db047b941bf0b9ac3be388e7c73697).
Brand marks were sanitized from the inline SVG at
[Railway's official homepage](https://railway.com) on 2026-09-13. The original mark
contains the Railway train silhouette; the dark variant changes only its fill
for contrast. The public
manifest contains runtime artwork paths; this record retains source provenance.

## Recovery

- Cancelled consent: use Connect again; cancelled callback state cannot be reused.
- Expired/revoked OAuth or refresh failure: reconnect the affected authorization.
  Raw provider error descriptions and tokens are not shown.
- Insufficient API permissions: verify workspace access, reconnect, then refresh
  actions. Direct tools stay unavailable until the API probe succeeds.
- An older preview reported a generic deployment error immediately after consent:
  its API probe omitted the workspace ID. Refresh actions with the current server;
  reconnect is unnecessary when the selected workspace is already authorized.
  New direct actions remain quarantined until reviewed.
- Missing service or mismatched IDs: list current resources and use one consistent
  project/environment/service/deployment target. No mutation precedes validation.
- Railway unavailable/rate-limited: wait, inspect status, then retry deliberately.
- SSH not configured or host-key mismatch: verify enrollment and host identity
  through the provider; update the connection setup. Do not disable host checks.

## Verification and release gate

`railway.test.ts` covers fixed API dispatch, bounds, errors, target checks and
credential redaction, including source-deployment denial with no upstream request.
`railway-ssh.test.ts` covers isolated SSH state, completion,
output limits, timeout, cancellation and cleanup. `railway-connection.test.ts`
uses observed metadata with synthetic provider responses to exercise the shared
OAuth/catalog/grant/gateway lifecycle and denies retired source-deployment catalog
entries before refresh. The fixture explicitly does not claim an
authenticated provider tool capture. Shared generic MCP suites cover callback
state/issuer binding, consent cancellation and credential handling.

Independent security review accepted the architecture for local preview on
2026-09-13. The operator subsequently completed local consent. A follow-up live
check reproduced HTTP 200 with `Not Authorized` for account-wide projects, while
the same credential succeeded with an explicit workspace. After the fix, catalog
refresh reported API access available, 44 active hosted actions, two disabled
actions, and 12 new direct actions quarantined for review. Direct project,
service and environment reads succeeded; the inspected project had no services,
so deployment status and logs could not be exercised. No provider mutation ran.
That preview included source deployment; the 2026-09-16 security fix removes it
and blocks existing entries, leaving 11 supported direct actions.

Full release acceptance remains outstanding. The operator must identify a
disposable service and deployment for the remaining checks.
Required live proof: HTTPS and supported loopback consent; actual catalog capture;
agent gateway read/logs; rejected Ask-first write with no upstream mutation;
approved scoped redeploy and resulting deployment; refresh/reconnect; revoked
grant denial; enrolled SSH key, harmless command, wrong-target denial,
timeout/cancellation, key removal and provider cleanup. The successful direct
read diagnostic does not replace the required agent-through-gateway proof.

Regenerate with `pnpm connections:ingest-app-definitions --definitions-only` when
the external research corpus is unavailable. This preserves its ingestion report.
Run targeted suites, shared definitions, `pnpm check:token-gates`, then the full
repository checks before release. See [the verification record](RAILWAY-REVIEW.md) for actual results.

Rollback: remove Railway's curated slug/promotion and setup panel to stop new
setup; disable direct runtime dispatch if needed. Preserve connection rows,
grants, vault records and the generic remote-MCP path. Existing connections must
remain recoverable and disconnectable. Remove registered SSH keys deliberately;
do not delete provider projects or application data as rollback.
