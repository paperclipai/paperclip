# Braintrust

Updated: 2026-10-21. Status: US OAuth connected and exercised against an
authorized account; US API-key and both EU methods still require live account
qualification. The remaining qualification gaps are listed below.

Braintrust is a P2 resource connection using Paperclip's existing remote MCP
transport, vault, catalog, access profiles, policy evaluation, run-scoped gateway,
and audit. Sign-in tokens are never reused as resource tokens; id.paperclip.ing
never stores resource tokens; no connections hub on the ID service.

## Methods and setup

The curated definition is authored in
[`scripts/app-definition-overrides/braintrust.json`](../../scripts/app-definition-overrides/braintrust.json)
and regenerated into the shared catalog. All methods use Streamable HTTP, S4
risk, and the same read/write capability profile.

| Method key | Account region | Authentication | MCP resource |
| --- | --- | --- | --- |
| `mcp-oauth` | US | OAuth; recommended default | `https://api.braintrust.dev/mcp` |
| `mcp-api-key` | US | API key | `https://api.braintrust.dev/mcp` |
| `mcp-eu-oauth` | EU | OAuth | `https://api-eu.braintrust.dev/mcp` |
| `mcp-eu-api-key` | EU | API key | `https://api-eu.braintrust.dev/mcp` |

Open **Apps → Braintrust** or `/apps/connect?source=braintrust`, choose access,
then select the method for the account's region. OAuth registers a client
dynamically and requests only `mcp`. No client ID or secret is entered manually.
For an API key, create a separate key in Braintrust **Settings → API keys**, then
paste it into Paperclip's password field. Paperclip projects the write-only
credential as `Authorization: Bearer <key>`. See the official
[MCP setup guide](https://www.braintrust.dev/docs/integrations/developer-tools/mcp).

Braintrust OAuth and API keys inherit their account's permissions. Paperclip
cannot grant an issued key additional access. See Braintrust's
[authentication model](https://www.braintrust.dev/docs/admin/authentication).
Use the normal personal or shared credential identity and agent selection.
Personal invocation credentials remain owned by their user; shared credentials
use the company vault. Client-registration credentials are separate from
invocation credentials. Agents receive gateway access, never the provider key.

There is no Paperclip project filter: project IDs in tool arguments do not
establish an access boundary. Resource authorization remains with Braintrust,
while Paperclip enforces company, grant, agent, task, and action policy.

Self-hosted Braintrust uses **Connect your own MCP server** with the deployment's
MCP URL. See the [generic remote MCP guide](./GENERIC-REMOTE-MCP.md). This
connector does not configure Paperclip's Braintrust trace exporter.

## Public protocol evidence

Unauthenticated probes on 2026-10-21 returned an HTTP 401 challenge from both
regional MCP resources. Each challenge identified its own protected-resource
document, with the exact `/mcp` resource and same-origin authorization server.

| Metadata or operation | US | EU |
| --- | --- | --- |
| Protected resource | `https://api.braintrust.dev/.well-known/oauth-protected-resource/mcp` | `https://api-eu.braintrust.dev/.well-known/oauth-protected-resource/mcp` |
| Authorization server | `https://api.braintrust.dev/.well-known/oauth-authorization-server` | `https://api-eu.braintrust.dev/.well-known/oauth-authorization-server` |
| Authorization | `https://api.braintrust.dev/oauth/authorize` | `https://api-eu.braintrust.dev/oauth/authorize` |
| Token | `https://api.braintrust.dev/oauth/token` | `https://api-eu.braintrust.dev/oauth/token` |
| Registration | `https://api.braintrust.dev/oauth/register` | `https://api-eu.braintrust.dev/oauth/register` |

Both servers advertise `authorization_code` and `refresh_token`, scope `mcp`,
PKCE `S256` and `plain`, and token authentication `client_secret_post`,
`client_secret_basic`, and `none`. Paperclip uses PKCE S256 and declares only
`ownershipModes: ["dcr"]`. Neither metadata document advertised CIMD or a
revocation endpoint. No dynamic registration, consent, token exchange, or
authenticated tool discovery was performed by these public probes.

## Actions and governance

The Braintrust connector owns the reviewed tool-risk inventory. The connector
policy registry selects it and declares catalog review behavior; the shared
connection service applies those policies. Retrieval tools are reads, including SQL, schema and
experiment inspection, object lookup, trace inspection, chart previews,
documentation search, and skill loading. Loading a provider skill is a governed
read; it does not install a Paperclip skill.

`edit_dataset_rows` is destructive because rows can be permanently deleted.
`set_automation_status` is destructive because activation can enable retention
or delivery automation. Other mutations and execution tools are writes,
including evaluations, evaluator/facet/preprocessor tests, dataset additions,
patterns, dashboards, alerts, online scoring, and Topics processing. Evaluations
and model-backed processing can incur provider costs. Unknown tools default to
write. Provider annotations may raise risk but cannot downgrade reviewed
mutations. The
[permission reviews](./tool-method-permission-reviews.json) record the scope and
provider-permission rationale for every method.

Risk classification does not change the central action defaults: discovered
actions initially use Paperclip's current **Allowed** defaults. Operators can
set actions to **Ask first** or **Off** on **Permissions**. Existing decisions
survive reconnect and refresh. After initial discovery, new or changed tools
are quarantined for review; reconnect and refresh preserve that setting.

## Recovery and removal

**Save & exit**, cancellation, **Finish setup**, and reconnect use the existing
setup controller. Resume the saved connection and its exact regional method.
An invalid or expired key needs replacement; OAuth access failures need fresh
authorization. Do not switch regions to repair a credential error. An
insufficient-permission failure requires the owner to authorize an account or
key with the intended Braintrust access.

Remove the connection in Paperclip to clear its local credentials and tool
access. Deactivate an API key in Braintrust separately to invalidate copies
outside Paperclip. API keys are displayed once; expired keys require replacement,
as described in the
[authentication documentation](https://www.braintrust.dev/docs/admin/authentication).
OAuth provider-side revocation is unqualified: the public metadata advertises
no revocation endpoint, so local removal must not be described as remote token
invalidation.

## Qualification record

Public metadata is protocol evidence, not proof of account authorization or
tool execution. An existing signed-in US account was authorized for a temporary
personal connection in an isolated source-checkout instance on 2026-10-21.

| Method | Public regional metadata | Connect / authenticated discovery | Bounded read / disposable write | Real run gateway / refresh or reconnect | Local removal / provider revocation / secret inspection |
| --- | --- | --- | --- | --- | --- |
| `mcp-oauth` | pass, US | pass; 49 tools | pass; synthetic insert and readback | pass; process-agent runs and OAuth reconnect; token expiry/refresh not forced | removal and structural redaction pass; remote revocation unqualified |
| `mcp-api-key` | pass, US; does not validate a key | not run; no test key supplied | not run | not run | not run |
| `mcp-eu-oauth` | pass, EU | not run; available account uses US data plane | not run | not run | not run |
| `mcp-eu-api-key` | pass, EU; does not validate a key | not run; no EU account/key supplied | not run | not run | not run |

The live US connection discovered 17 reads and 32 non-read actions. Provider
annotations raised several write classifications to destructive; unreviewed
names remained writes. `list_recent_objects` performed a bounded read.
`edit_dataset_rows` created one synthetic row in a new disposable dataset, and
`sql_query` read it back. Both ran through real process-agent heartbeats and
run-scoped gateway sessions. The qualification harness delivered the gateway
capability through a private temporary file; this does not qualify automatic
credential delivery for a native CLI harness. No provider credential was sent
to the process agent and no evaluation/model execution was invoked.

Catalog refresh and OAuth reconnect retained the same connection, US method,
49 actions, and changed-tool quarantine configuration. A subsequent bounded
read succeeded. The provider returned `openid profile email offline_access` in
the token response scope despite the authorization request containing only
`mcp`; Paperclip retained that discrepancy as provider metadata. Access-token
expiry and refresh were tested with fixtures, not forced on this live grant.

Cleanup deleted the synthetic row, verified an empty result, and removed the
new empty dataset in Braintrust after explicit approval. Local connection
removal revoked two vault secrets and one grant, removed the installation and
49 profile entries, and rejected a subsequent call with `tool_not_found`.
Qualification gateway sessions were revoked and their private files deleted.
The owned server and database were stopped and the disposable instance data
was removed.
Remote OAuth token invalidation remains unqualified because no revocation
endpoint is advertised.

Connection/catalog API responses contained no raw credential fields. The
isolated server log had no bearer values, access/refresh-token values, or OAuth
callback codes under credential-shaped scans. This was a structural redaction
check, not an exact decrypted-token search. Non-submitted key canaries were
absent from browser storage during the separate UI walkthrough. Fixture tests
provide exact canary redaction assertions. The sanitized
[qualification record](./braintrust-qualification-2026-10-21.json) separates
live, browser, and simulated-provider evidence.

Qualify each method independently in an owned isolated instance. Record the
revision, deployment, region, credential identity, discovered inventory, action
decision, and audit correlation. Use synthetic resources for writes; prove
Allowed, Ask-first, Off, quarantine, wrong-owner, and cross-company behavior
through the real run-scoped gateway. Verify cancellation/resume and reconnect
without duplicate connections or regional changes. Inspect API responses,
browser storage, logs, and stored secret references without copying tokens or
customer traces into evidence. Fixture-backed verification establishes
Paperclip behavior only; record its commands/results separately from live
provider proof, following the
[connector playbook](./CONNECTOR-PLAYBOOK.md#step-9-align-with-production-validation).

### Deterministic verification

On 2026-10-21, the Braintrust service fixture exercised all four methods with a
simulated provider and the actual encrypted vault, database, catalog, policy,
and run-scoped gateway. It covered OAuth DCR/PKCE and cancellation/resume,
personal/shared credential ownership, allowed reads and writes, approval and
Off decisions, schema-change quarantine, refresh/reconnect, wrong-owner and
cross-company denial, revocation, and redaction. See
[`braintrust-connection.test.ts`](../../server/src/__tests__/braintrust-connection.test.ts)
and the connector-owned
[`risk.ts`](../../server/src/services/connectors/braintrust/risk.ts).

The catalog suite validates all four reviewed contracts. Apps setup tests cover
each region/authentication choice and retrying the saved EU OAuth connection.
Brand validation checks the official local artwork; provenance is recorded in
[`braintrust-brand-provenance-2026-10-21.json`](./braintrust-brand-provenance-2026-10-21.json).
These checks establish Paperclip behavior with fixtures, not live Braintrust
account compatibility.

The isolated browser walkthrough passed 15 checks covering Apps and direct-link
entry, all four method choices and reloads, password-field validation,
cancellation, personal/shared access controls, and official light/dark artwork.
Its first pass exposed missing pre-auth caveats: warnings were present in the
definition but were not rendered by the setup form. The capability summary and
key helper now show account permissions, costs, permanent deletion, and
automation risks before authorization; the repeated walkthrough passed.
