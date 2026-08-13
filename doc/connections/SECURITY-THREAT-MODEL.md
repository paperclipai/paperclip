# Connections Security Threat Model

Audience: engineers implementing or reviewing integration work on the Apps v2
substrate.

Post-read action: identify the mandatory authorization, credential, audit, and
negative-test requirements before adding a new app, connection, transport, or
provider wrapper.

Source: harvested from [PAP-2359](/PAP/issues/PAP-2359) and mapped onto the
Apps v2 object model accepted in [PAP-13211](/PAP/issues/PAP-13211). The security
decisions survived the Connections v1 retirement; the v1 implementation details
did not.

Connections v3 adds forward security surfaces that later phases must threat-model
in detail: subject-bound token requests, workspace/user grants, provider triggers,
and the managed connector-service callback/webhook relay. Until those phases
land, treat all four as untrusted boundaries: bind subjects and grants to the
company, fail closed on revocation, authenticate and deduplicate triggers, and
never trust relay-supplied tenant or connection identifiers without signed
context and server-side ownership checks.

## Required Security Decisions

1. **Credentials live only in `company_secrets`.** Connections store secret refs
   and redacted metadata. Raw OAuth access tokens, refresh tokens, API keys, app
   private keys, webhook secrets, and remote MCP bearer tokens must not live in
   connection config, plugin config, issue comments, activity logs, exports, or
   agent-visible payloads.
2. **Connection operations are company-scoped and brokered by Paperclip.**
   Agents do not receive long-lived provider credentials. Plugin/provider code
   receives the minimum resolved material for a single invocation.
3. **Complete mediation is mandatory.** Tool calls, sync jobs, webhooks, catalog
   refreshes that affect permissions, and broker projections re-check current
   connection status, secret state, profile/policy state, resource filters, and
   actor/company ownership at execution time.
4. **Default policy is deny-by-default.** New connections grant no agent-visible
   access until an explicit profile/binding/policy path exists.
5. **Broad providers require resource filters.** GitHub needs repo/org bounds,
   Slack needs channel/workspace bounds, Google Drive/Docs needs drive/folder/doc
   bounds, and equivalent broad providers need provider-specific bounds before
   agent grants are usable.
6. **Write/admin actions are explicit opt-ins.** Read access does not imply write
   access. Destructive or newly changed write actions default to review.
7. **Revocation is immediate and failure-closed.** Revoked secrets, disabled
   connections, expired policies, missing secret refs, or failed health checks
   block new execution and queued mutation work.
8. **External content is untrusted.** Provider responses, chat messages,
   documents, webhook payloads, and remote MCP outputs may contain prompt
   injection and must not widen grants or bypass approvals.

## Protected Assets

- OAuth tokens, refresh tokens, app-installation tokens, API keys, webhook
  signing secrets, and remote MCP auth material.
- Connection metadata: provider, workspace/account ids, resource filters, health
  state, transport config, and status.
- Subject/grant metadata, provider tenant identifiers, trigger registrations,
  and connector-service relay routing state.
- Governance state: catalog entries, risk classes, quarantine state, profiles,
  bindings, policies, action requests, and trust rules.
- Paperclip objects mutated by integrations: issues, comments, documents,
  projects, goals, activity rows, plugin entities, work products, and artifacts.
- Agent runtime capability surface: the exact tools exposed into a heartbeat.
- Audit trail: call events, action-request decisions, secret access events,
  webhook deliveries, and activity entries.

## Actors And Trust Boundaries

Actors:

- Board user or operator.
- Company-scoped agent.
- Plugin worker or provider adapter code.
- External provider API.
- External webhook sender.
- Remote MCP server.
- Attacker controlling a different company, compromised agent, compromised
  external account, malicious external document/message, or malicious upstream
  tool schema.

Trust boundaries:

1. Board/API boundary: human-authenticated requests into the API.
2. Agent/API boundary: bearer agent keys and run-scoped tokens.
3. Server/plugin boundary: plugin workers are not the authorization boundary.
4. Server/provider boundary: vendor APIs and remote MCP servers are outside the
   trust perimeter.
5. Webhook boundary: inbound requests are attacker-controlled until signature
   validation and dedupe pass.
6. Connector-service relay boundary: callbacks and trigger deliveries remain
   untrusted until signed context resolves the company, connection, grant, and
   subject server-side.
7. External-content boundary: provider data is untrusted even when fetched
   through an authenticated connection.

## Flow Requirements

### Connection Creation And Authentication

Threats: spoofed OAuth callback, state replay, cross-company secret binding,
forged app-installation metadata, forged remote MCP metadata, and token leakage.

Required controls:

- OAuth start rows are short-lived and scoped to company, app/provider, requested
  scopes, creator, connection, and redirect URI. Use PKCE when supported.
- OAuth callbacks reject missing, expired, replayed, mismatched-state, and
  mismatched-redirect requests.
- API-key and app-installation flows write secret material to `company_secrets`
  first, then persist only refs and redacted account metadata on the connection.
- Create/update routes validate same-company ownership for every referenced
  secret, app, connection, agent, user, project, routine, and issue.
- Health and auth failures transition failure-closed: `missing_secret`,
  `degraded`, `failed`, `auth_required`, or disabled equivalents.
- Error payloads and logs redact provider responses that may contain credentials.

### Profile, Binding, And Policy Changes

Threats: non-admin actors widening access, IDOR against another company's agent
or connection, implicit writes, and transient broadening during replacement.

Required controls:

- Only authorized board/operator paths can create, update, or revoke connection
  grants, profiles, bindings, and policies in V1.
- Every write validates same-company ownership across connection, principal,
  creator, referenced catalog entries, and target scopes.
- Grant/profile replacement is atomic where possible. Avoid broad allow windows
  during multi-step updates.
- Expired or disabled policy state is absent at read and execute time.
- Write/admin access requires explicit catalog selectors or policy matches.
- Broad provider grants without resource filters are rejected rather than
  interpreted as provider-wide access.

### Catalog Refresh And Tool Exposure

Threats: upstream schema drift adding destructive tools, provider metadata
spoofing, and agents seeing tools without current permission.

Required controls:

- The server derives agent-visible tools from current profile, binding, policy,
  catalog, and connection state. Providers do not self-register tools directly
  into agent sessions without host filtering.
- New or changed write/destructive catalog entries are quarantined until reviewed.
- Catalog entries carry stable schema/version hashes so approvals and trust rules
  stop applying when schemas drift.
- Agent tool-list routes return only tools that pass current company, profile,
  binding, policy, catalog status, and connection status checks.
- Read tool output remains untrusted content and cannot mutate grants or
  profiles.

### Tool Execution

Threats: BOLA/IDOR, excessive agency, prompt injection, secret disclosure,
resource-filter bypass, and replaying old approval decisions.

Required controls at call time:

- Actor belongs to the connection's company.
- Connection is enabled and in a usable status.
- Secret refs resolve to usable, non-revoked secret versions.
- Effective profile exposes the requested catalog entry.
- Policies allow the exact request or require an action request.
- Tool/action risk does not exceed the allowed path.
- Resource identifiers satisfy provider-specific filters.
- Approval-derived trust rules match current catalog schema hash and exact
  reviewed argument shape.
- Arguments and results are redacted before audit and agent-visible return.

### Sync Jobs And Scheduled Ingest

Threats: queued work continuing after revocation, broad provider crawls, and
storing data outside approved filters.

Required controls:

- Each job run resolves connection state and re-checks profiles/policies/resource
  filters at run start.
- Revocation, disablement, missing secret refs, or expired grants prevent future
  job starts.
- Sync cursors are scoped to a connection and to the allowed resources.
- Job config can narrow resource filters but never widen them.
- Revoked/invalid scope failures emit audit/activity events and fail closed.

### Webhooks

Threats: spoofing, replay, tampering, wrong-company routing, and unaudited
provider-origin mutations.

Required controls:

- Validate provider signature or authenticity material before dispatch.
- Persist and dedupe delivery ids before mutation.
- Resolve webhook secrets from `company_secrets`; never copy them into inline
  config.
- Route webhook payloads only to the owning company/connection. Ignore request
  body ids until the signed/provider-authenticated envelope resolves the
  connection.
- Apply resource filters before storing external mappings or mutating Paperclip.
- For revoked/disabled connections, acknowledge where provider semantics require
  it, log the filtered/drop outcome, and do not mutate Paperclip state.

### Import, Export, And Portability

Threats: secret disclosure, cross-company principal binding, and imports starting
with broad active access.

Required controls:

- Company export includes provider declarations, display metadata, redacted
  secret refs, profiles, and policy shape only. It excludes secret values and
  refresh tokens.
- Import restores connections in an unusable state until destination-company
  secret refs are remapped and validated.
- Imported profiles/bindings/policies become active only when referenced
  principals and connections resolve inside the destination company.

## Required Negative Tests

Cross-company isolation:

- Board user from company A cannot read/update/delete company B's app,
  connection, catalog entry, profile, policy, action request, or gateway session.
- Agent from company A cannot list or invoke company B tools.
- Create/update routes reject secret, agent, user, project, routine, issue, app,
  and connection ids from another company.
- Webhooks for company A cannot mutate company B entities even if external ids
  collide.

Ungoverned or overbroad access:

- Agent without an effective profile/binding cannot see the connection's tools.
- Read-only grant/profile cannot invoke write/admin/destructive tools.
- Missing catalog selector, disabled catalog entry, or quarantined catalog entry
  denies execution.
- Empty resource filters are rejected for broad providers.
- Tool execution against a disallowed repo/channel/folder/doc/project is denied
  even if the upstream token can access it.

Revocation and failure-closed behavior:

- Revoked secret version, disabled connection, archived app, expired policy, and
  missing secret ref block execution immediately.
- Queued sync/webhook work after revocation logs and does not mutate.
- Health checks on invalid credentials do not leak provider secret material.

OAuth and callback integrity:

- Missing, expired, mismatched, and replayed OAuth state is rejected.
- Mismatched redirect URI is rejected.
- Callback cannot bind credentials into a company other than the OAuth start
  company.

Webhook integrity:

- Missing or invalid signature is rejected.
- Duplicate delivery id is deduped without repeating side effects.
- Valid webhook outside the resource filter is logged as filtered and dropped.

Redaction and agent safety:

- API responses, activity rows, issue comments, action requests, exports, and
  tool-call audit never contain raw secret values.
- External content cannot widen grants, create policies, or approve its own
  privileged tool call.
- Remote MCP outputs are treated as untrusted content and cannot bypass
  ask-first gates.

## Residual Risks

- Plugin workers are trusted runtime code today, not a hard sandbox. Keep
  authorization in core server paths.
- Remote MCP providers remain supply-chain and prompt-injection surfaces. Use
  narrow default profiles, schema hashing, changed-tool quarantine, and
  board-supervised rollout.
- Provider OAuth/app-installation scopes may be broader than Paperclip resource
  filters. Paperclip must enforce the narrower internal filter.
- High-risk writes still need good UX. Default them to ask-first, dry-run, or
  draft semantics until product copy and review flows are proven.
