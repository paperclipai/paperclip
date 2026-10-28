# Tool access boundaries

Baseline: `efc2ddc7bf19ec319b21cd294e71e5a4932c16f4`.
`server/src/services/tool-access.ts` has 21,525 lines and 829,519 bytes.
Imports account for 293 lines. The service factory spans 18,366 lines,
including its public method implementations and service wiring.
The largest functions are connection setup (1,468 lines), OAuth callback
completion (644), OAuth start (613), and grant refresh (611).

The first batch contains three dependent PRs. Each PR targets its predecessor.
Existing exports remain compatible. No branch is merged as part of this batch.

| Order | Responsibility and destination | Estimated move / net reduction | Contract | State and effects | Verification |
| --- | --- | --- | --- | --- | --- |
| 1 | GitHub access discovery, `services/tool-access/github-access-discovery.ts` | 290 / 288 lines | Token or headers and request function to normalized repository/account metadata | GitHub pagination and response validation; no stored grants or shared state | Existing public exports, paginated PAT and managed access, malformed responses, retry classification, GitHub service integration |
| 2 | Connection method configuration and projection, `services/tool-access/connection-methods.ts` | About 330 / 310 lines | Reviewed method and raw settings to validated settings; connection settings and tool input to projected headers/schema/arguments | Pure transforms; provider-specific argument policy stays in its existing module | Configuration rejection, managed defaults, header safety, legacy methods, setup and discovery integration |
| 3 | OAuth protocol handling, `services/tool-access/oauth/` | About 1,500 / 1,400 lines | Guarded requests and connection metadata to discovered endpoints; registration request to validated client material | Network interpretation and endpoint policy; persistence and refresh leases stay in the coordinator | Existing discovery, DCR, CIMD, scope, redaction, issuer and endpoint-security tests; real local protocol fixture |
| 4 | Profile resolution and review, `services/tool-access/profiles/` | About 1,500 / 1,400 lines | Company, agent, selectors and current catalog to effective profiles and review decisions | Scoped queries and profile mutations; preserve assignment locks and caller transactions | Binding precedence, exclusions, company isolation, new-tool review and lightweight projections |
| 5 | Connection token brokering, `services/tool-access/token-broker/` | About 1,400 / 1,300 lines | Authorized run and token request to issuance result | Run/membership locks, rate limit, credential exchange, hashed issuance audit | Revocation races, scope restriction, unavailable/disabled broker, exchange failure and secret redaction |

Rows 4 and 5 are follow-up candidates, not part of the initial batch. Reassess
their contracts after the first three cuts. Keep authorization, current grant
checks, company isolation, audit, and transaction ownership with their existing
owners. Do not pass the full service context into a new module.

Existing extracted owners include tool-access policy, profile entry validation,
binding precedence, credential bindings, MCP transport and endpoint guards,
runtime supervision, managed Cloud connectors, Vercel Connect, and individual
provider policies. New modules import those owners directly and never import
the compatibility service entry point.

Run relevant tests before and after each move, with one database test worker.
Compare moved bodies against the base. Run repository typecheck, full tests,
and build at the batch handoff. Record setup failures separately from behavior
failures, and leave unavailable checks unverified.

## First extraction

GitHub access discovery preserves all six moved function bodies exactly.
The service retains grant selection, credential resolution, refresh retry,
membership locking, revision checks, persistence, and webhook updates.
The original service becomes 21,237 lines / 820,116 bytes; the new module is
294 lines / 9,722 bytes. Public-path tests pass before and after: 13 focused
tests and 11 selected GitHub service cases using disposable PostgreSQL.
The initial test attempt could not resolve the unbuilt plugin SDK; building
the existing workspace prerequisites resolved that setup failure.

## Second extraction

Connection method selection, settings validation, and header/schema/argument
projection now live in `tool-access/connection-methods.ts`. Inputs use a small
settings shape with required config and transport, independent of database rows.
The service and gateway retain their existing entry points. Provider policies
remain in the Honcho, Google Chat, and Gmail modules and are called in the same
order. No configuration snapshots or caches are added.

All 11 moved function bodies and the private record parser match the baseline.
The original service becomes 20,917 lines / 808,777 bytes; the new module is
359 lines / 12,665 bytes. The full service suite (466 cases) and provider-policy
coverage pass before and after; the combined post-move run passes 506 tests.
Server TypeScript checking passes. The first typecheck exposed that the public
ToolConnection DTO allows absent config; the module now declares the required
validated settings shape directly instead of adding internal fallback checks.

## Third extraction

OAuth protocol handling now has explicit owners for endpoint policy, metadata
interpretation and discovery, client registration/token exchange, provider error
normalization, and the public client metadata document. Each owner accepts
settings or named request capabilities. None imports the database or the parent
service. Connection URL normalization stays with connection-method settings.

Registration returns validated client material before the coordinator stores it.
Token exchange returns normalized token fields without the unused raw provider
payload. The coordinator retains registration single-flight state, refresh
leases, current membership and grant checks, secret writes, audit records,
transaction ownership, and callback state validation. Endpoint policy reads the
existing live private-endpoint setting through a callback. It does not snapshot
options or create another cache.

Thirty-seven moved function bodies match after syntax normalization. Registration
request/validation and persistence statements match their original halves.
Preflight takes explicit defaults and a clock callback. Remaining coordinator
function bodies match except for these deliberate delegation points.

The original service becomes 19,293 lines / 749,158 bytes, a reduction of 2,232
lines across the stack. The seven OAuth modules total 1,697 lines; the largest
has 582 lines. Connection-methods grows to 368 lines with URL normalization.

A new route integration fixture uses a real local HTTP OAuth/MCP server and a
disposable PostgreSQL database. It covers public and Basic-authenticated clients,
discovery, registration, PKCE token exchange, callback completion, secret storage,
catalog review, and connection activation. Both cases passed before and after
the move. The combined post-move protocol/service run passed 508 tests.
The first fixture run asserted a nonexistent catalog enabled field; the assertion
now checks persisted active status and reviewer identity. An initial typecheck
exposed optional method defaults across the extraction boundary; the coordinator
passes the already-validated defaults explicitly. No runtime fallback was added.
Repository-wide typechecking and module-boundary checks pass. The PR records
the full test and build results for the batch handoff.

## Next ownership cuts

The service still coordinates grant lifecycle, profile resolution, token
brokering, and app setup. Profile resolution/review is the next candidate because
it can own scoped queries and projection without importing OAuth protocol code.
Token brokering follows after its authorization, issuance audit, and locking
contract is mapped. The large setup and callback functions should shrink through
those ownership cuts rather than by distributing their local variables into a
shared service context.

## Continued stack: coordinator below 5,000 lines

The user authorized continuing the stack after PRs #17144, #17146, and #17147.
All three remain open. Start each dependent PR from its predecessor; do not merge.
The new baseline is `3dc46c132408556ecb31038a9b9621ac20aacefc`, at 19,293 lines.

The next cuts follow ownership, with a measured target of fewer than 5,000 lines
in the entry point. Reassess the estimates and ordering after each cut.

| Boundary | Approximate reduction | Owner and contract | State and verification |
| --- | ---: | --- | --- |
| Profile management and effective assignments | 1,500 | Profile service owns scoped queries, mutations, review and summaries; assignment resolver consumes installed connections | Preserve caller transactions, lock ordering, precedence, exclusions, and lightweight reads |
| Connection token broker | 1,700 | Authorized run and issuance request to credential lease; provider exchange separated from admission | Keep run/membership checks, rate limits, scope restriction, issuance audit and cleanup in one flow |
| Runtime administration and diagnostics | 1,500 | Stdio templates, supervisor controls, health and activity projections | Same supervisor instance and live clock; public routes and real runtime controls |
| Connection credentials and refresh | 2,800 | Current grant and actor to usable credentials; separate registration and refresh owners | Preserve process registration flights, per-service refresh flights, database leases and current authority checks |
| OAuth authorization lifecycle | 2,700 | State admission, authorization request and provider-specific callback completion | Keep state consumption and callback finalization ordering; local HTTP OAuth/MCP integration and denial/revocation cases |
| Catalog and provider discovery | 1,900 | Connection to normalized descriptors and reviewed catalog; aggregator inventory has its own owner | Preserve discovery caches, credential access, failure classification and catalog publication transactions |
| Connection grants, installs and removal | 2,300 | Company-scoped connection lifecycle and audience operations | Preserve revocation/assignment lock ordering, current membership, teardown and secret ownership |
| Example installation, if still needed | 600 | Reviewed examples to installed application/profile plus smoke results | Preserve idempotency, approved runtime and policy decisions |

Shared support is limited to explicit actor/transaction types, stable identifiers,
and assignment-lock functions. It must not become a service-context bag. The
entry point should retain cross-domain app setup and access finalization, while
subsystems own their implementation. Existing public imports remain compatible.

Run the full public service baseline, then each boundary's meaningful tests
before and after its move. Review normalized bodies and every wiring change.
Run full typecheck/build at the batch handoff and require current-head CI gates.
The prior batch's interrupted local full suite remains unverified; its passing
isolated retry does not replace the missing full-run result.

### Profile ownership extraction

Profile management now takes only the database and clock. Pure projections and
lightweight catalog columns live beside it. Effective assignment resolution has
three explicit capabilities: validate the agent, load installed connections, and
project full catalog entries. Shared assignment locks keep their bodies and call
order. Transactions still enclose the same reads, locks and writes.

The entry point is 17,752 lines / 698,511 bytes. The profile modules contain 1,370
lines, with the largest at 886. All 329 pre-existing function and method bodies
match normalized syntax across the move. The baseline and post-move runs pass
466 public service cases plus 33 profile validation, assignment and publication
cases. Server typechecking and the module-boundary gate pass. Existing tests
exercise both full catalog DTOs and lightweight assignments; no new behavior or
fixture-only test was added.

### Connection token broker extraction

The broker owns run admission, explicit mint grants, rate limits, selected grant
checks, issuance and audit. Configuration parsing, endpoint policy, exchange,
and issuance storage are separate modules. The service receives the existing
secret service, policy service, audit function, clock and two connection/grant
operations. The issuance transaction still acquires the responsible membership
lock before resolving the parent credential and performing the exchange. It
stores only the token hash. Private-host policy still reads live environment
values on each request. No resource, cache or timer is created by the factories.

The entry point is 16,100 lines / 644,119 bytes. The six broker modules total
1,721 lines; the largest is 755. All 294 pre-existing function/method bodies
match normalized syntax. Two new public-route tests passed before production
changes and after extraction. They use real HTTP and disposable PostgreSQL for
Pages and RFC 8693 exchanges, plus a failing upstream request, and assert that
issuance/audit rows contain no token material. The complete public service and
HTTP rebinding run passes 495 cases. Server typechecking and module boundaries
pass. These fixtures do not claim live third-party qualification.

### Runtime and activity ownership extraction

Slot persistence and operator controls share the existing runtime supervisor.
The health reader receives the same live deployment options, clock and trusted
host getter. Activity projections and company-scoped history/usage reads live
separately from the action review queue. The queue retains its existing unsigned
request grace period and invalid-signature cancellation writes.

The entry point is 14,877 lines / 600,156 bytes. Five destination modules total
1,282 lines, with no module larger than 426 lines. All 256 pre-existing bodies
match normalized syntax. The public service and unsigned review-queue coverage
pass before and after (469 combined cases). Server typechecking and module
boundaries pass. No new supervisor, background loop or runtime cache is created.

### Credential ownership

- Moved OAuth client settings, credential persistence, client registration, refresh leases, connection/grant refresh, GitHub continuity, Vercel credential access and credential selection behind named factories.
- `tool-access.ts`: 14,877 → 12,019 lines. Registration single-flight remains process-wide; refresh maps and GitHub sweep state remain per service. The live cloud connector getter and existing secret client are passed through.
- The real HTTP/PostgreSQL OAuth fixture now also proves concurrent refresh across two service instances, one token exchange, durable rotated credentials and authenticated use of the new token. Its two cases passed before the move.
- After extraction, 470 public service/integration cases, server typecheck and module boundary checks pass. All 233 pre-existing function/method bodies match by normalized syntax comparison.

### Authorization lifecycle

- Separate state validation/consumption, authorization initiation, direct OAuth callback, managed-cloud callback, Vercel callback, catalog completion and explicit identity promotion. Shared setup policy, personal identity checks and organization-grant persistence have explicit owners.
- `tool-access.ts`: 12,019 → 8,997 lines. The largest new module is 700 lines. Callback-specific state consumption order, membership locks, transaction-scoped secret writes and promotion cleanup stay intact.
- Before/after: all 470 public service and real HTTP/database integration cases pass. Server typecheck, module-boundary and whitespace checks pass; all 182 previous function/method bodies match by normalized syntax comparison.

### Catalog ownership

- Separate guarded remote HTTP, descriptor risk policy, discovery, publication, default access, cached reads, health, attention and aggregator account synchronization.
- `tool-access.ts`: 8,997 → 6,418 lines. New owners range from 39 to 492 lines. Remote options remain live; catalog flights and aggregator sync jobs retain per-service lifetime. Publication locks and transaction-scoped default access remain unchanged.
- Before/after: 470 public service/HTTP integration cases plus 44 catalog-publication, HTTP rebinding and aggregator-sync cases pass. Server typecheck and module-boundary checks pass. All 157 previous function/method bodies match by normalized syntax comparison.

### Connection access and removal; final target

- Extract credential-reference validation, grant audiences/delegations, installations and removal. Each owner keeps its locks, audit writes and cleanup order. Removal uses the existing supervisor and secret client, retains the Slack mutation lease, and keeps access revocation with resumable secret cleanup.
- `tool-access.ts`: 6,418 → **4,820 lines / 198,002 bytes**. The full stack started at 21,525 lines / 829,519 bytes. The four new modules have 75, 603, 350 and 658 lines.
- Removal, grant resolution and the strengthened real HTTP OAuth journey passed before extraction (13 cases). The final combined public-path run passes 525 cases across seven suites. Full repository typecheck and build pass. Module-boundary and whitespace checks pass; all 94 previous function/method bodies match by normalized syntax comparison.
- The earlier local full-suite attempt remains interrupted and unverified. PR descriptions retain that limitation and original CI failures alongside current-head CI outcomes.
- The requested size target is met. App setup, finish/reconnect orchestration, local template definitions and examples remain in the coordinator; further extraction is outside this batch.

### Merge integration

- The first eight PRs landed on master. The catalog extraction was replayed after the Braintrust connector policy change in #17141. Risk classification and publication retain that policy in their extracted owners; setup retains its policy call.
- The final entry point is 4,821 lines / 198,065 bytes. All 157 catalog and 94 connection-lifecycle method bodies match their updated bases by normalized syntax comparison.
- The integrated stack passes 601 targeted cases across nine suites, including Braintrust lifecycle and connector-policy coverage. Server typecheck, module-boundary and whitespace checks pass. Fresh CI and reviews are required for both updated PR heads before merge.
