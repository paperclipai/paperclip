# Connection-grants capability fan-out: design and safety proof

Date: 2026-10-27. This records the selected design before implementation.
See [implementation verification](2026-10-27-connection-grants-batch-verification.md)
for measured results and completed acceptance checks.

## Recommendation

Add one narrow, service-owned batch operation for describing which agents may
receive a connection installation. Factor the common installed-agent checks out
of the per-candidate loop. Keep authorization policy in its existing owner and
keep actual mutations on the existing fresh authorization path.

Start with board actors describing a direct, saved, non-AI connection. Preserve
the ordinary evaluator for delegated agents and complex resources until their
additional obligations have executable parity evidence. This is a bounded first
fix, not a general authorization cache or a rewrite of connection permissions.

The endpoint currently asks, for each candidate agent, whether the actor may
change the connection's installations. Each answer checks **all retained
installed agents**, followed by the candidate if it is not already installed.
A company installation expands to the company roster. For 100 candidates with
100 retained targets, this means 10,000 target evaluations before the other route
work. The proposed eligible path needs 100 retained-target evaluations, with
extra evaluations only for candidates outside that set.

Those retained checks are real policy obligations. The fix removes their repeated
execution; it must not remove their authority requirements.

## What the evidence establishes

The prior observation window contains two successful grants GETs lasting
56.506 and 66.388 seconds. There is no matching request trace attributing their
duration to this loop. See [the measurement record](2026-10-27-next-bottlenecks.md).
The source and local probes establish amplification, not the fraction of hosted
latency it causes or the eventual improvement.

The production path is:

- `server/src/routes/tool-access.ts`, `describeConnectionCapabilities`: selects
  the company roster and calls `connections:profiles` once per agent, with
  mutation authority and `readOnly: false`.
- `server/src/services/connection-management.ts`, `authorize`: resolves the
  saved connection, expands its retained installations, then checks the ordered
  target set. `capability` converts only errors with status 403 into denials;
  other faults escape.
- `server/src/services/authorization.ts`: owns membership and scoped permission
  decisions. Some subtree grants can read the whole company hierarchy for each
  target, so linear target evaluations do not guarantee linear rows read.

Three independent designs were compared: structural factoring, general lazy
request caching, and a narrow guarded batch. A separate judge selected the narrow
batch. The final design incorporates the structural candidate's preparation
continuation and differential test approach, plus the cache candidate's careful
first-visit ordering and separate work counters.

| Local experiment | Observed result | Limit |
| --- | --- | --- |
| Existing exported service, all-installed fixtures | 4 agents caused 16 target reads; 8 caused 64 | Synthetic database transport, not PostgreSQL |
| Handwritten factored terminal phase compared with the current service | Six static output/fault cases matched; target reads fell 16 to 4 and 64 to 8 | Treatment omits preparation and is not the proposed production implementation |
| General read-reuse experiment, 32 agents | Physical transport reads fell 3,168 to 36, but 1,024 target invocations remained | Demonstrates why caching alone can retain quadratic work |
| Existing policy with a grant scoped to one agent and no installations | Named candidate allowed; targetless request denied | Rules out an extra targetless authorization preflight |
| Existing service with an unavailable retained target | Normal capability denied; `mutation: false` shortcut allowed | Rules out bypassing retained installation checks |
| Existing continuation after membership removal | Fresh `reauthorize` denied | Does not prove a future batch's freshness |

All three local proof scripts were rerun successfully by the primary agent and
the independent judge. They execute unchanged exported services over synthetic
Drizzle transport. They are level-4 evidence for the exercised current-code
facts, not proof of the unimplemented batch, assembled HTTP equivalence,
PostgreSQL performance, or delegated-actor parity.

## Owning API and eligibility

The new operation belongs in `connectionManagementService`, beside `capability`.
Its only initial consumer replaces the `editableAgentIds` loop. Use a fixed
`connections:profiles` action and mutation-mode semantics rather than exposing
general action or read-only knobs. Accept the original actor, base connection
resource, ordered candidate IDs, and existing read context. Return positional
capability descriptions; the route derives the existing editable-ID list.

Do not return an authorization context, audit authority, reusable session, cache
handle, or continuation. Do not change the wire schema. Keep manager checks,
configure/use capabilities, membership gates, grant identity filtering, and
audience disclosure on their existing paths.

The initial optimized shape is deliberately explicit:

- Board actor; one direct saved connection whose actual saved purpose is not AI.
- No non-null profile, gateway, routine, project, or issue selector.
- No own `requestedProvider` or `requestedInstallCompanyIds` property, and no
  `selfServiceAgentInstalls: true` request.
- Validated, nonempty roster IDs in their original spelling and input order.
  Retained target IDs must also be canonical and nonempty. Unusual identifiers
  use the ordinary path rather than normalization: a saved empty target is a
  candidate-dependent selector in the legacy evaluator.

Use the saved connection's provider, purpose, and creator derivation, including
its ordinary personal-grant handling. Caller labels cannot establish eligibility.
Unsupported shapes retain the existing per-candidate evaluator. In particular,
AI pools, profile bindings and selectors, current/proposed gateway resources,
and delegated actor contexts keep all recursive checks.

## Evaluation algorithm

Extract private preparation, target evaluation, and completion primitives from
the existing evaluator. Both the ordinary and batch paths must consume these
same primitives; do not copy policy into the route or implement a second policy
engine. Ordinary authorization always starts with fresh private state.

1. An empty candidate list returns an empty result without authorization, as
   the current loop does.
2. Begin preparation for the first actual candidate in the current order.
   Discover eligibility during the normal saved-connection lookup. The private
   preparation frame is consumed exactly once. If ineligible, finish that same
   evaluation through the ordinary path, then evaluate the remaining candidates
   normally. Do not restart preparation to fall back.
3. For eligible inputs, form the same ordered set of retained installation
   targets, including the existing company-install expansion. Evaluate each
   retained target once, using the original check order: connection policy,
   applicable proposed-provider/resource trust checks, target existence, and
   principal-specific target authority. The shared primitive preserves these
   obligations even where the initial eligibility guard excludes some branches.
4. A retained-target 403 denies every candidate with the same current denial.
   A reached non-403 fault aborts the operation. Do not inspect later targets to
   discover a fault the original evaluator would not reach.
5. After the retained prefix succeeds, visit candidates in input order. A
   candidate already in the retained set uses the final retained decision,
   matching the current ordered-set behavior and success reason. An additional
   candidate uses the shared target primitive. Its 403 denies that candidate;
   a reached non-403 fault aborts. Return one result per input position.
6. With no retained installations, the candidate is the policy target. Do not
   add a targetless preflight: a grant scoped to that candidate may correctly
   allow it while denying an unspecified target.

For N candidate positions and S distinct retained targets, the target phase is
bounded by S + N evaluations, and often fewer when candidates are retained.
This is not a promise of S + N SQL statements. Authorization may still read
membership, grants, and hierarchy for each distinct target; complex fallback
keeps its present cost. Measure those separately before widening the change.

Avoid eager prefetch and `Promise.all` here. A denied retained target currently
prevents later target lookups. Loading those targets first changes which faults
are reached. Parallelizing the old loop also retains its total work.

## Two safety facts and the blast radius

**1. A displayed permission must retain every existing installation obligation
and its own target scope.** The batch cannot turn a denied or absent retained
target into editable siblings, substitute a targetless decision, or reuse an
allowed candidate's decision for a different candidate. Preserve positional
results, reason, operation, ordered deduplication, and the 403/fatal-fault boundary.
Existing-code counterexamples prove these shortcuts are unsafe. Actual old/new
service and route comparisons remain required to prove the proposed change.

**2. A description must never become reusable mutation authority.** Batch state
exists only inside one call and cannot cross actors, companies, connections,
requests, operations, or human continuations. Actual writes and `reauthorize`
start fresh. The batch returns descriptions only; identity disclosure does not
consume them as authority.

There is a deliberate consistency change: reused facts and retained decisions
are observed once during the description rather than reread for every candidate.
This is neither a database snapshot nor an atomic revocation boundary. A revoke
or target deletion during the call can leave a briefly stale displayed choice;
a second GET and an actual mutation must observe fresh authority. Sequential
first visits preserve static-fact failure order, not every possible failure or
revocation between removed duplicate reads. Document and test this honestly.

Delegated agents remain on the ordinary path initially. `captureRunIdentity`
locks and can reconcile pending steering identity; it is not a pure read. A
future extension must prove run ownership, work mode, API-key status, responsible
human and external-human ceilings, and pending-identity behavior. Preserve the
original actor reference because existing read-context reuse checks identity by
reference. Do not memoize capture or attach batch state to that context.

The intended change touches the connection-management owner, its route consumer,
and focused tests. Existing connection policy is the authority. There is no
schema migration, provider protocol change, background worker, persistent cache,
UI contract change, or blanket creator/manager allow rule in this design.

## Implementation and acceptance gates

1. **Shared-helper refactor:** preserve ordinary evaluation before enabling the
   batch. Prove preparation runs exactly once for the first candidate on both
   eligible and fallback paths. Keep its continuation private and consumed.
2. **Actual service differential:** compare the new production batch against the
   old full evaluator with a disposable PostgreSQL fixture. Compare every
   positional `allowed`, `reason`, and `operation`, not just editable counts.
   Cover empty/duplicate candidates; no, partial, and company installations;
   scoped grants with no installations; missing/foreign retained and candidate
   targets; local board and Cloud creator, owner, administrator, operator,
   ordinary member, viewer, and inactive membership.
3. **Failures and fallback:** retained denial before an unreachable fault;
   candidate denial followed by a reached later fault; preparation/target 500
   and relevant reconciliation 409; only 403 converted. Exercise every excluded
   shape, including empty AI pools, explicit null selectors, proposed providers,
   company-install changes, profile selectors, and linked gateway obligations.
4. **Full grants GET:** compare complete assembled responses, including order,
   editable IDs, configure/use flags, personal identity filtering, manager
   visibility, audience members, and route access gates. Exercise the existing
   connection Permissions and agent installation UI consumers.
5. **Freshness and isolation:** controlled mid-batch revoke/delete; fresh second
   GET; GET then revoke then real mutation; delayed human/OAuth continuation;
   concurrent actors, companies, and connections. Agent fast-path enablement
   additionally requires real run/key/steering and lock-contention fixtures.
6. **Performance:** at roster sizes 1, 8, 32, and 100 or larger, count preparation,
   target evaluations, policy decisions, SQL calls, returned rows, and wall time
   separately. Test subtree grants and unrelated-request responsiveness. Measure
   assembled route phases and database/pool delay before attributing savings.

After implementation, run the relevant regression suite and the repository's
required typecheck, tests, and build before PR hand-off. Require passing final-head
CI and review before hosted rollout. Repeat acceptance on the exact serving
revision, verify both response behavior and latency with enough samples, and
retain a way to restore the ordinary evaluator if parity fails.

This design pass changed no application behavior and performed no hosted mutation.
It establishes a preferred implementation and executable current-code safety
constraints. Complete batch parity and production latency improvement remain
unproved until the implementation and acceptance gates above pass.
