# Connector Playbook: Add A Vendor As A Catalog Entry

This playbook is the repeatable template for adding a vendor to the Apps catalog as data, not as a plugin. It follows the accepted connections framework in [PAP-13211](/PAP/issues/PAP-13211), the first-30 rollout matrix in [PAP-2432](/PAP/issues/PAP-2432), and the production validation scope in [PAP-12373](/PAP/issues/PAP-12373).

Use it when Paperclip acts on an external system through a governed connection: a stored credential, a capability catalog, access profiles and policy rules, and audit. Inbound integrations, such as an external client acting on Paperclip, use gateway or webhook guidance instead.

## Output

A complete connector proposal produces:

- A catalog manifest entry with user-facing app metadata.
- Transport and auth configuration.
- Credential secret refs into `company_secrets`; never raw env values.
- Action catalog metadata with risk classes, schemas, resource filters, and quarantine defaults.
- Default profile and policy behavior for read, write, and destructive actions.
- A smoke checklist aligned to [PAP-12373](/PAP/issues/PAP-12373): connect, discover catalog, allowed read call, ask-first write call, denied/quarantined call, revoke, and audit evidence.

## Step 1: Confirm It Is A Catalog Entry

Default to a catalog entry when the vendor can be represented as metadata plus a transport:

- The connection points at a remote MCP endpoint, an approved local stdio template, or a generated shim over a documented API.
- The setup flow only needs normal fields, OAuth redirect handling, resource filters, policy defaults, and health/catalog checks.
- The vendor does not need its own database tables, background workers, custom issue-thread interactions, or dedicated UI pages.

Use a plugin only when the integration needs code that cannot fit inside the common connection model:

- Product surface: custom pages, dashboards, panes, or rich configuration UI beyond schema-driven forms.
- Data model: plugin-owned tables, migrations, or long-lived local state.
- Execution: workers, schedulers, webhooks, sync loops, file processors, or vendor-specific runtimes that are not a simple transport shim.
- Packaging: a third party wants to ship the integration as an extension package.

A plugin may bundle one or more catalog entries, but it must still create normal applications, connections, credential refs, catalog entries, profiles, policies, and audit events. Plugin code must not bypass the gateway, policy engine, `company_secrets`, changed-action quarantine, or call-event audit log.

## Step 2: Classify The Reuse Path

Classify the vendor before writing metadata. Use the [PAP-2432](/PAP/issues/PAP-2432) matrix terms so rollout planning, security review, and QA can compare providers consistently.

| Reuse path | Use when | Typical transport | Examples from the matrix |
| --- | --- | --- | --- |
| MCP-direct | The vendor exposes an official or stable MCP server whose tools map cleanly to Paperclip grants. | `mcp_remote`; `local_stdio` only for approved trusted templates. | Linear, Notion, Sentry, Vercel, Exa, Apify, Context7. |
| OpenAPI-shim | The vendor has a documented REST/OpenAPI surface but no stable MCP server, and a generated/thin shim can expose safe actions. | Shim service or approved template that presents an MCP-compatible catalog to Paperclip. | Datadog, Apollo, QuickBooks, Ramp/Brex, Zendesk. |
| Vendor-deep-wrapper | The vendor boundary depends on app-installation tokens, event validation, rich domain semantics, resource grants, or high-risk writes. | Vendor-specific wrapper behind the same connection model. | GitHub, Slack, Google Workspace writes, Atlassian, Microsoft 365, Cloudflare, Figma, Stripe, Salesforce, HubSpot, Intercom, PagerDuty. |

Record the classification in the proposal along with the transport and the reason a lighter path is or is not enough.

## Step 3: Pick Auth And Credential Ownership

Choose one auth mode:

- OAuth: user or workspace authorization through Paperclip-owned OAuth app registration. Use for vendors with delegated scopes and revocation APIs.
- API key: operator-supplied token or key. Use only when scopes can be constrained and the key is stored as a `company_secrets` ref.
- App-installation: bot/app token, GitHub App installation, Slack bot token, or similar installation credential.
- None: public/read-only systems or first-party fixtures that do not require vendor credentials.

Credentials always live in `company_secrets` with redacted metadata and versioned material. The catalog entry records the secret binding shape, not the secret value:

```json
{
  "credentialSecretRefs": [
    {
      "configPath": "credentials.authorization",
      "label": "Linear OAuth access token",
      "required": true
    }
  ],
  "credentialRefs": [
    {
      "name": "Authorization",
      "placement": "header",
      "key": "Authorization",
      "prefix": "Bearer ",
      "secretId": "<resolved at connect time>"
    }
  ]
}
```

Do not add durable vendor credentials to agent env, project env, runtime env, adapter config, issue comments, screenshots, logs, fixture JSON, or plugin config. Agents receive a run-scoped gateway token; Paperclip resolves the vendor credential server-side and audits the call.

## Step 4: Author The AppDefinition

Author an `AppDefinition` as the canonical data record for the app and every supported connection method. It must explain what the operator gets without exposing protocol details in prosumer surfaces. Developer docs can mention transport, MCP, shim, and gateway terms; the Apps gallery copy should use plain app/action language.

Capture:

- `key`: stable lowercase app key, e.g. `linear`.
- `name`, `logoUrl`, `tagline`, `description`: user-facing metadata.
- `methods`: explicit combinations of `transport` (`mcp_remote`, `rest_api`, `local_stdio`), `authKind` (`oauth`, `api_key`, `none`), and `ownership` (`platform_shared`, `platform_provisioned`, `customer`, `dcr`).
- Stable connection UID namespace used to form `{namespace}/{slug}` addresses.
- `credentialFields`: labels, vendor-call placement, header key, prefix, help URL, and required state. User-facing labels should be sanitized by the Apps UI copy layer. The saved value is always a `company_secrets` ref, not an env entry.
- `oauth`: provider key, scopes, authorization URL, token URL, metadata URL if applicable.
- `urlPatterns`: URLs that can identify this app during paste/import flows.
- `recommendedDefaults`: access and risk defaults, especially ask-first risk levels.
- `availability`: whether the connector is generally available, gated by deployment config, or needs vendor registration.

Keep `AppDefinition` metadata deterministic and company-scoped at install time. Global catalog data names capabilities; company connection and grant rows hold the configured instance, subject/provider tenant, secret refs, resource filters, status, health, and audit history.

## Step 5: Model Resource Filters

Every connector proposal needs resource filters before write actions are enabled. Filters are part of the connection configuration and must be enforced by the gateway or wrapper, not only by UI affordances.

Common filter dimensions:

- Account boundary: workspace, org, team, tenant, site, portal, realm, account.
- Resource boundary: repo, channel, page, database, project, zone, file, folder, dashboard, issue queue.
- Object boundary: issue status, labels, branch, environment, object type, record type, field list, attendee domain.
- Egress boundary: domain allow/deny list, result limits, content category, attachment/file-type limits.
- Mutation boundary: create-only, draft-only, comment-only, no delete, no external send, dry-run required.

The connection health and catalog discovery steps should fail or warn when required filters are absent for S3/S4 providers.

## Step 6: Define The Action Catalog

List each initial action before implementation. Do not rely on vendor tool names alone; Paperclip needs normalized metadata for review, policy, and audit.

For each action, capture:

- Stable tool name and user-facing title.
- Description in operator language.
- Input and output schema.
- Read/write/destructive flags and risk level.
- Resource filter fields used by the action.
- Redaction plan for arguments and results.
- Expected audit fields.
- Whether the action is enabled, disabled, or quarantined by default.
- Negative access case: ungranted actor, disallowed resource, revoked connection, or cross-company attempt.

Risk classes:

| Risk | Examples | Default |
| --- | --- | --- |
| `read` | Search, list, fetch metadata/content inside allowed resources. | Active when profile includes the app or read risk level. |
| `write` | Create issue, add comment, update status, append block, trigger redeploy. | Ask-first unless the default profile or a reviewed policy narrows it further. New/changed write tools start quarantined when discovered after initial review. |
| `destructive` | Delete, refund, cancel production deployment, send external message, broad tenant mutation. | Quarantined. Requires explicit operator review and usually a `require_approval` policy even after review. |

Changed-action quarantine is mandatory: if catalog refresh finds a new or schema-changed write/destructive action, the entry stays hidden from agents until an operator reviews and re-enables it. Do not mark a changed action active just because a previous action with a similar name was active.

## Step 7: Select The Wizard Path

The wizard path comes from auth mode and transport:

| Auth mode | Operator path | Stored result |
| --- | --- | --- |
| OAuth | Gallery card -> Connect -> vendor consent -> callback -> configure filters -> health/catalog -> access defaults. | OAuth token material in `company_secrets`; connection metadata redacted. |
| API key | Gallery card -> paste key -> configure filters -> health/catalog -> access defaults. | Key material in `company_secrets`; no raw key returned after save. |
| App-installation | Gallery card -> install app/bot -> callback or paste installation identifier -> configure filters -> health/catalog -> access defaults. | Installation credential in `company_secrets`; installation account metadata redacted. |
| None | Gallery card -> configure allowed resources -> health/catalog -> access defaults. | No vendor secret; connection row still carries config and audit scope. |

The operator should see Apps, Connections, and Review language. Keep protocol language behind Developer/Advanced copy.

## Step 8: Apply Governance Defaults

Governance is automatic because every catalog entry becomes a normal tool-access object:

1. Catalog status gates first: `disabled` and `quarantined` deny immediately.
2. Profiles decide which actors can see catalog entries. Bindings can target company, project, agent, routine, or issue scopes.
3. Policies decide whether a visible action is allowed, blocked, rate-limited, or requires approval.
4. Ask-first calls create action requests with signed arguments. Approval applies only to the reviewed argument shape and unchanged schema hashes.
5. Every decision and call writes audit with actor, run, issue, connection, catalog entry, decision, reason code, redaction summary, outcome, and latency.

Recommended defaults for a new catalog entry:

- Create a read-friendly default profile only when read actions are low or medium risk and resource filters are present.
- Set `recommendedDefaults.askFirstRiskLevels` to `["write", "destructive"]` unless the connector is read-only.
- Add an explicit block or quarantine for destructive actions until SecurityEngineer review.
- Add rate-limit policy for search/fetch APIs, vendor quota-sensitive APIs, and paid APIs.
- Require approval for any external send, deploy, refund, delete, tenant-wide mutation, or action that can expose private customer data outside Paperclip.

## Step 9: Align With Production Validation

[PAP-12373](/PAP/issues/PAP-12373) owns real-vendor gallery smoke evidence and connector validation. Do not duplicate that issue's screenshot/evidence matrix in this playbook. A connector proposal should instead state exactly how it will be validated there:

- Connect succeeds against the real vendor using production-like OAuth/app/key setup.
- Catalog discovery produces the expected actions and quarantines new/changed risky actions.
- An allowed read call succeeds through the gateway.
- A write call opens ask-first review and succeeds only after approval.
- A blocked/quarantined action cannot be listed or invoked by an agent.
- Revocation removes tools and blocks execution immediately.
- Activity/audit rows prove actor, run/issue context, resource id, decision, reason code, and outcome.

If a gallery card cannot pass this path against a real vendor, de-list it or mark it unavailable until the missing auth, transport, or governance dependency is fixed.

## Template

Copy this section into a connector proposal or implementation issue.

```md
## Vendor

- App key:
- App name:
- Owner:
- First-30 classification: MCP-direct / OpenAPI-shim / vendor-deep-wrapper
- Reason for classification:
- Security tier: S1 / S2 / S3 / S4
- Plugin needed? No / Yes, because:

## Transport And Auth

- Transport:
- Endpoint or approved template:
- Auth mode: OAuth / API key / app-installation / none
- OAuth scopes or key scope:
- Credential owner: company / user-delegated / app-installation
- Secret storage: company_secrets refs only
- Revocation behavior:

## Resource Filters

- Required filters:
- Optional filters:
- Write-enabling filters:
- Filters enforced by:

## Manifest

- key:
- name:
- tagline:
- authKind:
- transportTemplate:
- credentialFields:
- oauth:
- urlPatterns:
- recommendedDefaults:
- availability:

## Actions

| Tool | Risk | Default status | Filters | Approval default | Audit fields | Negative case |
| --- | --- | --- | --- | --- | --- | --- |
| | read/write/destructive | active/quarantined/disabled | | allow/ask-first/block | | |

## Wizard Path

- User path:
- Configuration steps:
- Error states:
- Redacted metadata shown:

## Governance Defaults

- Default profile:
- Profile bindings:
- Policies:
- Quarantine rules:
- Rate limits:

## Validation Hook

- Real-vendor smoke issue:
- Connect evidence:
- Catalog evidence:
- Allowed read:
- Ask-first write:
- Denied/quarantined case:
- Revoke:
- Audit:
```

## Appendix: Linear Dry Run

This dry run applies the template to Linear, one of the [PAP-2432](/PAP/issues/PAP-2432) Batch A providers.

### Vendor

- App key: `linear`
- App name: Linear
- First-30 classification: MCP-direct with a thin GraphQL/resource-filter wrapper if the hosted MCP server cannot enforce all filters itself.
- Reason for classification: Linear has a hosted MCP endpoint shape in the current gallery, and the first-30 matrix calls Linear a direct MCP/GraphQL thin-wrapper provider.
- Security tier: S2, because it exposes product planning data and narrow issue mutations but not payments, tenant admin, or production infrastructure.
- Plugin needed: No. The default gallery card, OAuth connect, resource filters, action catalog, profiles, policies, and audit cover the required UX. A plugin would only be warranted later for custom Linear dashboards or background sync workers.

### Transport And Auth

- Transport: `mcp_remote`
- Endpoint: `https://mcp.linear.app/mcp`
- Auth mode: OAuth
- OAuth scopes: `read` and `write` initially, with writes governed by profiles and ask-first policies.
- Credential owner: company connection backed by user/workspace consent.
- Secret storage: OAuth token material stored as `company_secrets` refs; no token in agent env, project env, comments, logs, or screenshots.
- Revocation behavior: disabling or revoking the connection immediately removes Linear tools from agent sessions and denies brokered execution on the next gateway check.

### Resource Filters

- Required filters: workspace, team.
- Optional filters: project, label, cycle, issue status.
- Write-enabling filters: team plus project or label/cycle filter for create/update; comment-only writes may allow team-only with explicit policy.
- Enforced by: gateway policy selectors, wrapper-side argument validation, and vendor request construction. UI filter pickers are convenience only, not the enforcement boundary.

### Manifest Sketch

```json
{
  "key": "linear",
  "name": "Linear",
  "tagline": "Create, update and read tickets.",
  "authKind": "oauth",
  "transportTemplate": {
    "transport": "mcp_remote",
    "url": "https://mcp.linear.app/mcp"
  },
  "credentialFields": [],
  "oauth": {
    "provider": "linear",
    "scopes": ["read", "write"],
    "authorizationUrl": "https://linear.app/oauth/authorize",
    "tokenUrl": "https://api.linear.app/oauth/token"
  },
  "urlPatterns": ["https://mcp.linear.app/*"],
  "recommendedDefaults": {
    "access": "all_agents",
    "askFirstRiskLevels": ["write", "destructive"]
  }
}
```

### Actions

| Tool | Risk | Default status | Filters | Approval default | Audit fields | Negative case |
| --- | --- | --- | --- | --- | --- | --- |
| `linear.search_issues` | read | active after catalog review | workspace, team, project, label, status | allow when profile includes Linear reads | query summary, team/project ids, result count | Granted agent cannot search a disallowed team. |
| `linear.get_issue` | read | active after catalog review | workspace, team, issue id | allow when profile includes Linear reads | issue id, team/project ids | Ungranted agent cannot list or invoke the tool. |
| `linear.create_issue` | write | active only after review; changed versions quarantined | workspace, team, project, label | ask-first by default | team/project ids, title hash, created issue id | Missing project/team filter denies. |
| `linear.comment_issue` | write | active only after review; changed versions quarantined | workspace, team, issue id | ask-first by default | issue id, comment body redaction summary | Agent cannot comment on a disallowed issue. |
| `linear.update_issue_status` | write | active only after review; changed versions quarantined | workspace, team, issue id, allowed statuses | ask-first unless a trust rule covers exact shape | issue id, old/new status if returned | Revoked connection blocks retry. |

No destructive Linear action should ship in the first pass. If a future delete/archive/bulk-update action appears during catalog refresh, it starts quarantined and needs explicit SecurityEngineer review before any policy can expose it.

### Wizard Path

1. Operator opens Apps and selects Linear.
2. Operator clicks Connect and completes Linear OAuth.
3. Paperclip stores OAuth material in `company_secrets` and shows redacted workspace/account metadata.
4. Operator selects workspace/team/project filters and confirms default ask-first writes.
5. Paperclip runs health check and catalog refresh.
6. Operator binds the Linear read profile to a company, project, agent, routine, or issue scope.
7. Write actions stay ask-first until the operator approves calls or creates narrow trust rules.

### Governance Defaults

- Default profile: include Linear read actions for the selected scope; exclude write actions unless the operator opts in.
- Policy defaults: require approval for create, comment, and status updates; block any unreviewed destructive action.
- Quarantine: new or schema-changed write actions receive `quarantineReason: "pending_review"` and are hidden from agent tool lists.
- Rate limits: apply a per-connection query/write budget to protect vendor quota and avoid noisy issue edits.
- Audit: log connect, config/filter changes, grant changes, action requests, allowed/denied calls, revoke, and catalog quarantine events.

### Validation Hook

Linear's real-vendor evidence belongs in [PAP-12373](/PAP/issues/PAP-12373). The smoke pass should prove:

- OAuth connect succeeds with Paperclip-owned Linear app registration once [PAP-12372](/PAP/issues/PAP-12372) provides credentials.
- Catalog discovery returns the expected Linear issue actions.
- A read call against an allowed team succeeds.
- `linear.create_issue` opens ask-first review and only executes after approval.
- A call against a disallowed team/project is denied.
- Revocation removes Linear tools and blocks execution.
- Audit rows include company, connection, run/issue, agent/user actor, tool, decision, reason code, and outcome.
