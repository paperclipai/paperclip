# ADR: Agent Access MVP and MCP Runtime Slots

Date: 2026-06-05

Status: Accepted for MVP implementation contracts, pending SecurityEngineer and UXDesigner validation gates.

Source issues:

- PAP-10341 accepted plan revision 2.
- PAP-10383 Phase 0C architecture ADR.
- PAP-10381 SecurityEngineer threat model, currently in progress when this ADR was written.
- PAP-10382 UXDesigner design feedback, currently in progress when this ADR was written.

## Context

Paperclip needs governed MCP/tool access for agents. The product should not become a raw `mcp.json` editor or an adapter prompt convention. The control plane must own which tools an agent can discover, which calls can run, which credentials are available, which calls need review, and how every decision is audited.

Paperclip already has useful primitives:

- Company-scoped records and company-boundary checks.
- Agent API keys and heartbeat run identity.
- Issues, comments, issue documents, interactions, approvals, and work products.
- Secret-backed environment bindings and secret access events.
- Plugin tool discovery/execution routes that accept board and agent actors.
- A Paperclip MCP server package that exposes Paperclip REST operations outward as MCP tools.
- Execution workspaces and runtime service concepts.

The gap is the governed access layer between agents and external tool/application capabilities. Current plugin/MCP surfaces are useful, but they do not provide a single default-deny policy engine, durable invocation ledger, runtime-slot supervisor, redacted audit model, or approval-safe tool execution path.

## Decision

Build the MVP as **Agent Access**, exposed in the product as **Tools & Access**. MCP is a transport and integration type, not the user-facing product concept.

The CTO accepts the default-deny gateway architecture from PAP-10341 with these MVP decisions:

1. MVP clients are Paperclip agents only. External human AI clients are out of scope.
2. MVP connections are managed company connections only. Personal/user-owned OAuth connections are deferred.
3. External tools are default deny. No profile or explicit allow means no discovery and no execution.
4. Paperclip is the enforcement gateway. Agents connect to Paperclip, not directly to upstream MCP credentials or ungoverned upstream configs.
5. The gateway governs Paperclip plugin tools, Paperclip self-MCP tools, and upstream MCP tools through one policy/audit/invocation model.
6. Remote HTTP MCP is preferred for MVP examples and customer-facing usage.
7. Local stdio MCP is allowed only from board/admin-created command templates, through supervised runtime slots with pooling, idle TTL, per-company/per-host caps, and no agent-supplied command strings.
8. Ordinary write/destructive tool calls use issue-thread action cards with stored reviewed arguments. Broad trust or policy changes use formal approvals.
9. First examples are synthetic fixtures, then Paperclip self-read, GitHub triage, and approval-gated outbox/social examples.
10. The UI home is Company Settings > Tools & Access, with effective tools visible on agent details and runtime slots visible in settings.

## Product Concepts

`Tool Application`

A company-visible tool source. MVP types are `mcp_http`, `mcp_stdio`, `paperclip_plugin`, and `paperclip_self`. Future types such as `a2a` can be added behind the same concepts.

`Connection`

An admin-managed access instance for an application. It stores transport configuration and secret references, not raw secret values. MVP supports managed company connections only.

`Tool Catalog Entry`

A snapshot of a discoverable tool/resource/prompt from a connection, including schema hash, title/description, risk classification, read/write/destructive flags, last seen time, and review state.

`Access Profile`

A reusable bundle assigned to company defaults, agents, projects, routines, or issues. Profiles select which applications, connections, and tools may become visible/callable.

`Policy`

Server-evaluated rule that can allow, block, require approval, redact, rate-limit, or defer because runtime capacity is unavailable. Policies are evaluated from authoritative Paperclip state, not model-provided context.

`Gateway Session`

A short-lived per-run session minted by Paperclip. It exposes only allowed tools for that run and prevents upstream credentials from reaching the agent process.

`Invocation`

Durable ledger row for every tool attempt. It records idempotency identity, policy decision, approval state, execution status, argument/result hashes or safe summaries, and links to run/issue/agent/company.

`Tool Call Audit Event`

Durable redacted event for discovery, allow, deny, approval requested, approval accepted/rejected, execution started, result returned, timeout, runtime failure, and policy/rate-limit decisions.

`Runtime Slot`

Managed lifecycle unit for a local stdio MCP process or remote session handle. Runtime slots are visible, supervised, capped, and reusable. They are not hidden per-agent child processes.

## Data Model Boundary

Add company-scoped storage under a Tools & Access namespace. Names are provisional, but the contracts are not:

- `tool_applications`: company, app identity, type, status, owner/admin metadata.
- `tool_connections`: company, application, managed connection kind, transport config, secret refs, enabled flag, health.
- `tool_catalog_entries`: company, connection, tool name, schema, risk tags, version/hash, review/quarantine state.
- `tool_profiles`: company, profile name, description, status.
- `tool_profile_entries`: company, profile selectors for app/connection/tool/risk.
- `tool_profile_bindings`: company, profile binding target: company, agent, project, routine, or issue.
- `tool_policies`: company, rule type, priority, selectors, condition JSON, effect, enabled flag.
- `tool_invocations`: company, run, issue, actor, connection, tool, args hash, idempotency key, approval state, execution status.
- `tool_action_requests`: company, invocation, issue interaction/approval links, canonical signed reviewed args, preview.
- `tool_call_events`: company, invocation/run/issue/agent links, decision, reason code, redacted summaries, result size, latency.
- `tool_runtime_slots`: company, connection, workspace scope, credential scope, trust scope, status, provider ref/process id, idle TTL, caps, last error.
- `tool_rate_limit_counters`: company-scoped counters by policy window.

Do not overload `principal_permission_grants` as the tool-resource policy store. Use it only for administrator capabilities such as:

- `tools:admin`
- `tools:manage_connections`
- `tools:manage_profiles`
- `tools:view_audit`
- `tools:use`
- `tools:manage_runtime`

All foreign keys must enforce company boundaries. Raw secrets must not be copied into these tables. Secret values resolve only at gateway/runtime execution time.

## Gateway and Session Model

At heartbeat invocation time, Paperclip resolves the authoritative agent, issue, project, routine, workspace, adapter, and run records. It then creates a gateway session tied to that run.

The adapter receives only Paperclip gateway configuration:

- gateway base URL;
- short-lived session token;
- optional generated MCP config pointing at Paperclip;
- no upstream MCP server credentials;
- no unfiltered upstream tool config.

For `tools/list`, the gateway evaluates visibility policy and returns only allowed descriptors. Hidden tools are omitted.

For `tools/call`, the gateway:

1. authenticates the gateway session and run;
2. canonicalizes requested tool identity and arguments;
3. creates or finds an invocation ledger row;
4. evaluates policy from server state;
5. writes an audit event for allow/deny/approval/defer;
6. returns `403` or structured denial for unauthorized direct calls;
7. creates an issue-thread action card when approval is required;
8. starts or reuses a runtime slot when needed;
9. executes upstream with minimal explicit arguments and scoped secrets;
10. validates/redacts result before returning it to the agent;
11. writes result/failure audit events and updates the invocation.

Agent-supplied `runContext` may remain for compatibility, but it is never authoritative. It must be checked against the authenticated run, agent, project, and company before use.

## Policy Engine Shape

Implement `toolAccessPolicyService` as a deterministic service that returns:

- `allowed`
- `visibility`: `visible` or `hidden`
- `effects`: `allow`, `block`, `require_approval`, `redact_arguments`, `redact_result`, `rate_limited`, `defer_runtime`
- `matchedPolicyIds`
- `reasonCode`
- `redactionPlan`
- `rateLimitState`
- `runtimeSlotRequirements`

Inputs are:

- authenticated actor principal;
- authoritative run, agent, issue, project, routine, workspace, and company records;
- adapter/client type;
- requested application, connection, catalog entry, and tool;
- normalized arguments;
- request/network context where available;
- current runtime slot health and capacity.

Precedence:

1. hard safety denies: company mismatch, archived app, disabled connection, missing secret, invalid run/session, unsafe command template;
2. explicit block policies;
3. approval-required policies;
4. profile membership and explicit allow policies;
5. content validation and redaction;
6. rate limits;
7. runtime availability/defer checks;
8. default deny.

Policy decisions must be unit-tested with stable fixtures. Discovery and execution must use the same policy engine so a tool hidden from `tools/list` also rejects direct calls.

## Invocation Ledger

Every call attempt creates or resolves an invocation. The ledger is required for all tools, not only write tools, because denied reads and approval waits must be auditable.

For write/destructive tools, idempotency identity must include company, connection, tool, canonical args hash, issue/run context, and a policy-provided idempotency key when available. Retries must not duplicate external side effects.

Approval-required calls store canonical reviewed arguments. Approval execution must use exactly those stored arguments, not a fresh model-provided payload.

Store safe summaries, hashes, sizes, and pointers. Do not store raw secret values. Large outputs should become bounded summaries plus artifacts/references rather than unbounded transcript/audit bodies.

## Audit Model

Audit is a first-class feature, separate from generic activity logging. Activity logs capture administrative mutations. Tool audit captures runtime access decisions and upstream outcomes.

Audit events must include enough to answer:

- who requested the tool;
- which company, run, issue, project, routine, and workspace were involved;
- which application, connection, and tool were targeted;
- what policy decision was made and why;
- whether approval was requested or used;
- whether execution happened;
- latency, result size, timeout/error class, and runtime slot identity where relevant;
- redaction markers and hashes instead of sensitive values.

Audit reads require `tools:view_audit` or board/admin access. Agent-facing transcript links may show summarized decision/result state, but raw audit details remain subject to audit permissions.

## Runtime Supervisor and Runtime Slots

The runtime-slot strategy is explicit:

- Remote HTTP MCP is preferred. It uses no local process. Paperclip proxies requests with timeouts, retries where safe, auth, and audit.
- Local stdio MCP runs only from board/admin-created command templates stored in managed connections.
- Agents never provide raw commands, args, cwd, env, or secret refs for stdio runtime creation.
- Default slot identity is `(companyId, connectionId, workspaceScope, credentialScope, trustScope)`.
- Workspace-sensitive servers are scoped to project or issue execution workspaces.
- Different secret scopes require different slots.
- High-risk or untrusted templates may force per-run slots.
- Idle slots stop after a configurable TTL.
- Per-company and per-host caps prevent process explosion.
- Backpressure returns a structured defer/rate-limited result and writes audit.
- Runtime slots expose status, health, last used, pid/provider ref, owner scope, last error, stop/restart actions, and idle policy in the UI.

Recommended initial defaults:

- remote HTTP fixture: always prefer for first demos;
- local stdio fixture: one fixture template only at first;
- idle TTL: short in dev/test, configurable for production;
- caps: conservative defaults, enforceable before broad stdio rollout;
- stdout/stderr: redacted, bounded, and linked to runtime health, not streamed wholesale into prompts.

## Fixture Catalog

Phase 1 fixtures should be isolated from production behavior but contract-aligned:

- Echo/calculator/time: read-only discovery and execution.
- Synthetic todo/KV: safe stateful reads/writes and idempotency tests.
- Outbox email: draft/preview/send-to-outbox with approval-gated send.
- Mock social/blog: preview/publish/unpublish with approval-gated publish.
- Paperclip self-read: list issues, get issue context, read plan document, list recent runs.
- Paperclip self-governed write: add comment draft, create child issue draft, update plan draft.
- Filesystem sandbox: scoped list/read/write/propose patch inside a temp root.
- Hostile MCP: malicious metadata/results, false annotations, oversized outputs, schema changes, secret-looking values.
- Slow/crashing/stateful stdio: sleep, crash, restart, increment, large result.
- Fake OAuth/missing secret: secret resolution and no-secret-leak tests.

Minimum smoke checks:

- allowed read appears in transcript and audit;
- unauthorized tool is hidden and direct call returns `403`;
- approval-gated write creates a pending action card and does not execute upstream;
- approved action executes stored reviewed arguments once;
- retry does not duplicate side effects;
- missing secret fails closed with value-free audit;
- changed/new write tool is quarantined until review;
- malicious metadata/result is sanitized or blocked;
- local stdio lazy-starts, reuses a slot, idles down, and records health;
- remote HTTP fixture works without local process;
- cross-company access is rejected at discovery, execution, audit, and secret resolution;
- large output is bounded;
- rate limit returns a clear denial/defer result and audit event.

## API Surfaces

Use board/admin endpoints under `/api/companies/:companyId/tools/...`:

- applications: list/create/update/archive;
- connections: create/update/test/disable/health/catalog refresh;
- profiles: create/update/delete entries and bindings;
- policies: create/update/test;
- audit: list/filter by run/issue/agent/tool/decision/outcome;
- runtime slots: list/stop/restart/inspect;
- examples: list/install fixtures/run smoke where supported.

Use gateway endpoints under `/api/tool-gateway/...`:

- mint/read run-bound gateway session where invoked by Paperclip runtime;
- list allowed tool descriptors for the session;
- execute tool through policy, invocation, audit, and runtime supervision;
- read pending invocation/action result.

Existing `/api/plugins/tools` discovery/execution must be wrapped, filtered, or migrated so plugin tools obey the same policy and audit model. Compatibility is acceptable during migration, but there must not be a second ungoverned agent tool path after the MVP enforcement work lands.

## UI Surfaces

Primary navigation:

- Company Settings > Tools & Access.

Required views:

- Overview: enabled apps, active connections, denials, high-risk calls, rate-limit events, runtime slot count.
- Applications: catalog, risk tags, tool list, health, owner/admin.
- Connections: managed credentials, secret binding status, transport settings, test connection, last used.
- Profiles: bundle builder and bindings to agents/projects/routines/issues.
- Policies: MVP rule builder using app/connection/tool/risk/agent/project/issue selectors.
- Runtime: local stdio slots and remote session health, idle state, errors, stop/restart.
- Audit: searchable timeline with run/issue links and redacted details.
- Examples: install safe fixtures and run smoke checks.
- Agent detail: effective profiles and allowed tools.
- Run transcript: tool call/denial/action-card links to audit/invocation records.

UX language should prefer App, Connection, Tool, Profile, Policy, Runtime, Audit, and Example. Use MCP as a connection type detail.

UI must never be the enforcement boundary. Designs must make default deny, approval wait, denied direct call, missing secret, runtime failure, and changed-tool quarantine states obvious.

## Approval Model

Write/destructive tool calls can be:

- denied;
- executed immediately if policy allows;
- converted into an issue-thread action card if policy requires review.

Issue-thread action cards are the MVP review path for ordinary external writes. They must show a safe preview, target app/tool, redacted arguments, policy reason, and execute/cancel controls. Acceptance executes only the stored reviewed arguments once.

Formal approvals are reserved for broader trust/policy changes, high-risk connection changes, and any action that changes future autonomy rather than a single invocation.

Unattended runs fail closed when approval is required and no valid issue-thread or approval path exists.

## Security Reconciliation

At ADR time, PAP-10381 had no completed threat-model document or comments. This ADR accepts the default architecture but leaves explicit security validation gates:

- SecurityEngineer must sign off on gateway-as-enforcement before Phases 2-8 are PR-ready.
- SecurityEngineer must approve or amend runtime-slot scoping, command-template safety, slot isolation, and stdout/stderr handling.
- Implementers must treat upstream MCP metadata and annotations as untrusted hints.
- The gateway must be the context firewall. Upstream tools receive explicit args and minimal trace context, not full issue threads, prompts, company data, or board/session credentials.
- Missing secrets, disabled connections, changed write schemas, cross-company references, invalid run sessions, and unsafe stdio templates fail closed.
- Audit and transcripts must be redacted and bounded.
- Duplicate side effects are a release blocker until invocation idempotency is proven.

If PAP-10381 requests a stricter position, SecurityEngineer feedback supersedes this ADR for security controls and must produce a follow-up ADR revision before broad implementation proceeds.

## UX Reconciliation

At ADR time, PAP-10382 had no completed UX document or comments. This ADR locks product vocabulary and surface placement while leaving design details to UX:

- Surface name is Tools & Access, not MCP Settings.
- Settings pages are the administrative home.
- Agent detail and run transcript show effective access and per-call outcomes.
- Action cards live in issue threads.
- Runtime slots are visible in settings because local stdio processes are operator-managed infrastructure.
- Empty, denied, pending approval, missing secret, runtime error, rate-limited, and changed-tool quarantine states are required.

If PAP-10382 designs show a lower-friction flow that preserves server-side enforcement, UX can change layout and interaction details without changing the architecture. UX cannot move enforcement into UI-only state.

## Implementation Phase Contracts

Phase 1 can proceed with isolated fixtures and smoke harness work.

Phases 2-8 should use this ADR as the stable contract:

- Phase 2 implements company-scoped storage and shared validators.
- Phase 3 implements policy, effective profiles, invocation ledger, audit, and rate counters.
- Phase 4 implements gateway sessions and runtime supervisor MVP.
- Phase 5 implements managed connections, catalog refresh, secret refs, and changed-tool quarantine.
- Phase 6 implements Tools & Access UI and example installer against the API contracts.
- Phase 7 implements approval-gated action cards and content validation.
- Phase 8 implements progressive autonomy only after per-call approval is reliable.

Phase 9 validates the end-to-end release with QA, SecurityEngineer, CloudOpsEngineer, EvalsEngineer, and DevRel.

## Non-Goals

- Enterprise RBAC replacement.
- Project/issue privacy controls.
- External human AI clients.
- Personal OAuth/user-owned connections.
- Natoma-style shadow AI/EDR/MDM discovery.
- Public plugin marketplace distribution.
- Trusting adapter prompts, generated `mcp.json`, or upstream MCP metadata as enforcement boundaries.
- Arbitrary agent-provided stdio command execution.
- Keeping every local MCP server warm.
- Full MCP App iframe rendering.
- Real external sends/posts in default smoke tests.
- Broad progressive autonomy before per-call approval and idempotency are proven.

## Open Risks and Deferrals

- Security sign-off is still pending from PAP-10381.
- UX sign-off is still pending from PAP-10382.
- Runtime slot isolation depth is unresolved: process-only may be enough for trusted local dev, but container/sandbox isolation may be required for hosted or untrusted stdio templates.
- OAuth/resource-bound token handling for remote MCP is deferred beyond managed company secret refs.
- Plugin tool compatibility needs a staged migration to avoid breaking existing plugin consumers.
- Policy complexity can grow quickly; MVP must start with explicit allow/block/profile/rate/approval rules before rich ABAC.
- Audit storage needs retention and pruning rules once volume is known.
- Large result artifact strategy needs exact storage and UI contracts.
- Cross-company tests must be present before any gateway route ships.
- First-install demos should use synthetic or read-only providers until approval/idempotency are proven.

## Verification for This ADR

This ADR was checked against:

- PAP-10383 deliverables and acceptance criteria.
- PAP-10341 plan revision 2.
- `doc/GOAL.md`, `doc/PRODUCT.md`, `doc/SPEC-implementation.md`, `doc/DEVELOPING.md`, and `doc/DATABASE.md`.
- `packages/mcp-server/README.md` for the current Paperclip MCP server boundary.
- `server/src/routes/plugins.ts` for the current plugin tool access gap.

No code, schema, or runtime behavior changed in this ADR.
